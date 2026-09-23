/**
 * 生产采集 Controller（规范 §4 / §7）。
 *
 * 把 Electron 壳接到 core 采集会话与 Pack 2.0 装配导出：
 * - 分区窗口（partition / contextIsolation / webSecurity 关闭）；
 * - 现场自签证书放行（分区 setCertificateVerifyProc + certificate-error）；
 * - popup 血缘挂载（nativePopupWindowOpenHandler + did-create-window 多根 attach）；
 * - Electron netLog 源（写工作区 .tmp/，收尾时包装入包）；
 * - Probe 补充事实（开始匿名探测、stop 时带会话 Cookie 复验——只记 Cookie 名）；
 * - Viewer 自动收尾（规范 §7.4）：检测 Viewer 活动 → 稳定窗口静默 → 只 stop，
 *   绝不自动导出 / 关窗 / 弹保存框。
 *
 * Electron 行为从 0.2.x 适配器原样移植（采集语义不变），落盘换 2.0 链路。
 * 无人为大小上限：工作区磁盘水位是唯一物理约束。挂载/探测失败显式记账
 * （targetAttachFailures / droppedEvent），绝不静默吞掉。
 */

import os from 'node:os';

import { BrowserWindow, session, webContents, type WebContents } from 'electron';

import type { CaptureTarget } from '../../core/capture-pack/types';
import { exportJobWorkspaceZip, type ExportJobWorkspaceZipResult } from '../../core/export/exportJobWorkspaceZip';
import { nativePopupWindowOpenHandler, popupWindowFacts } from '../../core/browser/popupWindowFacts';
import {
  startCaptureSession,
  type CaptureSession,
  type CdpSession,
  type NetlogSource,
} from '../../core/collector/createCaptureSession';
import {
  applyAuthenticatedProbe,
  probeBmcTarget,
  type ProbeBmcTargetResult,
} from '../../core/probe/probeBmcTarget';
import { createNodeProbeHttpClient } from '../../core/probe/createNodeProbeHttpClient';
import { buildProbeFactsFile } from '../../core/probe/probeFacts';
import type { ControllerDiagnosticKind } from '../../core/capture-pack-v2/types';
import { recordCaptureWindowLog, registerCaptureSession } from './captureWindowDiagnostics';
import { createDiagnosticRecorder } from './controllerDiagnosticRecorder';
import { createElectronNetlogSource } from './electronNetlogSource';
import { createViewerAutoStopWatchdog, type ViewerAutoStopWatchdog } from './viewerAutoStopWatchdog';
import { shouldCommitAboutBlankBeforeCdp } from './cdpRendererReady';

export type ProductionCaptureTarget = CaptureTarget & { originalInput?: string };

/** close() 被 beforeunload 阻止时的强关宽限（毫秒）。 */
const CLOSE_FORCE_DESTROY_MS = 10_000;

/** Controller 层采集过程事实（规范 §8.4：证书错误等随包导出）。 */
const DIAGNOSTICS_PATH = 'raw/controller/diagnostics.jsonl';

export interface ProductionCaptureInit {
  jobId: string;
  workspacesRootDir: string;
  target: ProductionCaptureTarget;
  deviceLabel?: string;
  partition?: string;
  tool: { version: string; buildId: string };
  hideWindow?: boolean;
  netlog?: NetlogSource;
  probeRunner?: typeof probeBmcTarget;
}

export interface ProductionCaptureExportResult extends ExportJobWorkspaceZipResult {
  zipPath: string;
}

export interface ProductionCaptureController {
  readonly session: CaptureSession;
  /** 匿名 probe + 主窗口挂载 + 首次导航（采集器必须在首次导航前就绪）。 */
  start(): Promise<void>;
  /** 认证 probe 复验 + 采集会话收尾（窗口保留供快照，收尾后再关）。 */
  stop(): Promise<void>;
  /** 装配并导出 Pack 2.0 ZIP（要求已 stop），成功后 markExported。 */
  exportPack(zipDir: string): Promise<ProductionCaptureExportResult>;
  windowsOpen(): boolean;
  closeWindows(): Promise<void>;
}

export async function createProductionCapture(
  init: ProductionCaptureInit,
): Promise<ProductionCaptureController> {
  const partition = init.partition ?? `kvm-recon-capture-${init.jobId}`;
  const targetUrl = `${init.target.scheme}://${init.target.host}:${init.target.port}/`;
  const hideWindow =
    init.hideWindow ??
    (process.argv.includes('--e2e-capture-controller') || process.env.KVM_RECON_E2E_CAPTURE === '1');
  const probeRunner = init.probeRunner ?? probeBmcTarget;

  const captureSession = await startCaptureSession({
    jobId: init.jobId,
    rootDir: init.workspacesRootDir,
    deviceLabel: init.deviceLabel,
    targetUrl,
    mainEnvironment: {
      chromium: process.versions.chrome ?? '',
      electron: process.versions.electron ?? '',
      os: `${process.platform} ${os.release()}`,
    },
    netlog: init.netlog ?? createElectronNetlogSource(),
  });

  let probeResult: ProbeBmcTargetResult | null = null;
  let stopped = false;
  let stoppedAt: string | null = null;
  // 幂等：并发/重入 stop 共享同一次收尾。与 createCaptureSession
  // 同一形态——收尾序列不可重放（认证 probe 是带会话 Cookie 的网络副作用），
  // 失败也复用同一 promise：调用方拿到同一拒绝，重试入口在 discard/恢复链路
  let stopPromise: Promise<void> | null = null;

  // Viewer 自动收尾看门狗（规范 §7.4）：检测 → 稳定 → 只 stop，
  // 绝不自动导出 / 关窗 / 弹保存框；识别失败只记诊断，绝不停采集。
  const viewerWatchdog: ViewerAutoStopWatchdog = createViewerAutoStopWatchdog({
    getFacts: () => captureSession.workflowFacts(),
    now: () => Date.now(),
    recordDiagnostic: (kind, detail) => recordDiagnostic(kind, detail),
    pendingNonStreamingRequests: () => captureSession.pendingNonStreamingRequests(),
    captureViewerInitialState: targetId => captureSession.captureViewerInitialScreenshot(targetId),
    // 返回 Promise 本体：拒绝由看门狗记 viewer-auto-stop-failed 诊断
    autoStop: () => stop(),
  });

  async function writeProbeFile() {
    const file = buildProbeFactsFile(probeResult);
    await captureSession.workspace.writeArtifact(
      'raw/probe/index.json',
      `${JSON.stringify(file, null, 2)}\n`,
    );
  }

  // stderr + 内存环形缓冲镜像保留；事实行追加进包（收尾后到达的行由 finalize
  // 门禁拒绝，走 droppedEvent 记账，属预期路径）
  const recordDiagnostic = createDiagnosticRecorder({
    appendDiagnosticRow: row => captureSession.workspace.appendJsonl(DIAGNOSTICS_PATH, row),
    droppedEvent: (method, error) => {
      captureSession.evidence().droppedEvent(method, error);
    },
    mirrorLog: recordCaptureWindowLog,
  });

  // ---- 窗口簿记（按根 target ID 记血缘，attach 上下文直接可用） ----

  const windows = new Set<BrowserWindow>();
  const windowRoles = new Map<BrowserWindow, 'main' | 'popup'>();
  const windowRootTargetIds = new Map<BrowserWindow, string>();
  const windowAncestorTargetIds = new Map<BrowserWindow, string[]>();
  // popupWindowFacts 按窗口 ID 记血缘；attach 上下文按根 target ID 记，两套分开
  const windowAncestorCaptureWindowIds = new Map<BrowserWindow, string[]>();
  const attachedByContentsId = new Map<number, Promise<void>>();

  function rootTargetIdFor(contentsId: number, role: 'main' | 'popup') {
    return role === 'main' ? 'target-root' : `target-window-${contentsId}`;
  }

  function ensureCdp(contents: WebContents, role: 'main' | 'popup', openerTargetId?: string) {
    const existing = attachedByContentsId.get(contents.id);
    if (existing) return existing;
    const started = (async () => {
      try {
        // Electron 44：空窗口尚未完成首次文档提交时 Network.enable 会一直挂起。
        // 主窗口先提交 about:blank；弹窗可能已有 POST 导航，禁止改写成 blank。
        if (shouldCommitAboutBlankBeforeCdp({ windowRole: role, url: contents.getURL() })) {
          try {
            await contents.loadURL('about:blank');
          } catch {
            // about:blank 预提交失败（窗口可能已销毁）：继续 attach，由超时/挂载失败降级
          }
        }
        await captureSession.attachCdp(contents.debugger as unknown as CdpSession, {
          targetId: rootTargetIdFor(contents.id, role),
          windowId: String(contents.id),
          windowRole: role,
          ...(openerTargetId ? { openerTargetId } : {}),
        });
        recordDiagnostic('cdp-attached', `role=${role} window=${contents.id}`);
      } catch (error) {
        // 挂载失败（弹窗 CDP 被占用 / Network.enable 超时）：显式记账，窗口保留
        captureSession.evidence().recordGap(
          'targetAttachFailures',
          rootTargetIdFor(contents.id, role),
          `CDP 挂载失败：${error instanceof Error ? error.message : String(error)}`,
        );
        recordDiagnostic('cdp-attach-failed', `window=${contents.id}`);
      }
    })();
    attachedByContentsId.set(contents.id, started);
    return started;
  }

  function attachWindow(
    window: BrowserWindow,
    role: 'main' | 'popup',
    lineage?: { openerTargetId?: string; ancestorTargetIds?: string[] },
  ) {
    windows.add(window);
    windowRoles.set(window, role);
    const rootTargetId = rootTargetIdFor(window.webContents.id, role);
    windowRootTargetIds.set(window, rootTargetId);
    if (lineage?.openerTargetId) {
      windowAncestorTargetIds.set(
        window,
        lineage.ancestorTargetIds?.length ? [...lineage.ancestorTargetIds] : [lineage.openerTargetId],
      );
    }
    window.on('closed', () => {
      windows.delete(window);
      windowRoles.delete(window);
      windowRootTargetIds.delete(window);
      windowAncestorTargetIds.delete(window);
      windowAncestorCaptureWindowIds.delete(window);
    });

    const contents = window.webContents;
    contents.on('certificate-error', (event, url, error, _certificate, callback) => {
      event.preventDefault();
      callback(true);
      recordDiagnostic('cert-trusted', `${error} ${url}`);
    });
    // Electron 44：console-message 是单事件对象签名（旧五参数形式已弃用）。旧数字 level 的 2/3（warning/error）对应新字符串枚举
    contents.on('console-message', event => {
      if (event.level !== 'warning' && event.level !== 'error') return;
      // 页面 console 全文已在包内（CDP Log → raw/browser/console.jsonl）；
      // 这里只保留 stderr/环形缓冲镜像（截断并遮蔽敏感词，避免口令打到控制台）
      const safe = String(event.message)
        .replace(/password|passwd|cookie|token|authorization/gi, '[redacted]')
        .slice(0, 240);
      recordCaptureWindowLog(
        `capture-console level=${event.level} ${safe} (${event.sourceId}:${event.lineNumber})`,
      );
    });
    contents.on('render-process-gone', (_event, details) => {
      recordDiagnostic('renderer-gone', `reason=${details.reason} exit=${details.exitCode}`);
    });
    contents.setWindowOpenHandler(() => {
      const handler = nativePopupWindowOpenHandler({ partition });
      if (hideWindow) {
        return {
          ...handler,
          overrideBrowserWindowOptions: {
            ...handler.overrideBrowserWindowOptions,
            show: false,
          },
        };
      }
      return handler;
    });
    contents.on('did-create-window', (childWindow, details) => {
      const openerCaptureWindowId = String(contents.id);
      const facts = popupWindowFacts({
        childCaptureWindowId: String(childWindow.webContents.id),
        openerCaptureWindowId,
        openerAncestorCaptureWindowIds: windowAncestorCaptureWindowIds.get(window),
        details,
        fallbackUrl: childWindow.webContents.getURL(),
      });
      recordDiagnostic('popup-created', `window=${facts.captureWindowId} url=${facts.url}`);
      windowAncestorCaptureWindowIds.set(
        childWindow,
        facts.openerCaptureWindowId
          ? [...(facts.ancestorCaptureWindowIds ?? [facts.openerCaptureWindowId])]
          : [openerCaptureWindowId],
      );
      attachWindow(childWindow, 'popup', {
        openerTargetId: rootTargetId,
        ancestorTargetIds: [rootTargetId, ...(windowAncestorTargetIds.get(window) ?? [])],
      });
    });
    return ensureCdp(contents, role, lineage?.openerTargetId);
  }

  async function refreshAuthenticatedProbe() {
    if (!probeResult) return;
    try {
      const electronSession = session.fromPartition(partition);
      const cookieNames = new Set<string>();
      const authenticated = await probeRunner({
        target: init.target,
        httpClient: createNodeProbeHttpClient(init.target, {
          extraHeadersForPath: async path => {
            const url = `${init.target.scheme}://${init.target.host}:${init.target.port}${path}`;
            const cookies = await electronSession.cookies.get({ url });
            // 事实只记 Cookie 名，绝不记值（值仅进入探测请求头）
            for (const cookie of cookies) {
              if (cookie.name) cookieNames.add(cookie.name);
            }
            const header = cookies
              .filter(cookie => cookie.name && cookie.value)
              .map(cookie => `${cookie.name}=${cookie.value}`)
              .join('; ');
            const headers: Record<string, string> = {};
            if (header) headers.Cookie = header;
            return headers;
          },
        }),
      });
      if (cookieNames.size === 0) {
        probeResult = {
          ...probeResult,
          authenticated: { attempted: true, cookieNames: [], paths: {} },
        };
        return;
      }
      probeResult = applyAuthenticatedProbe(probeResult, authenticated, [...cookieNames]);
    } catch (error) {
      // 登录后复验失败（BMC 拒绝带会话探测 / 网络中断）：保留匿名 probe，不阻断导出
      captureSession.evidence().droppedEvent('probe-authenticated', error);
    }
  }

  async function start() {
    if (stopped) throw new Error(`采集作业已收尾，拒绝重复 start：${init.jobId}`);
    const electronSession = session.fromPartition(partition);
    registerCaptureSession(electronSession);
    electronSession.setCertificateVerifyProc((_request, callback) => {
      // 采集分区只打开目标 BMC。现场自签证书在 Chrome 要点「高级」；这里直接放行，避免白屏。
      callback(0);
    });
    // 安全网：万一有窗口没走 ensureCdp（如脚本控制的 window.open），请求前补挂
    electronSession.webRequest.onBeforeRequest((details, callback) => {
      const contents =
        typeof details.webContentsId === 'number'
          ? webContents.fromId(details.webContentsId)
          : undefined;
      if (contents && contents.session === electronSession && contents.getType() === 'window') {
        const matched = [...windows].find(
          candidate => !candidate.isDestroyed() && candidate.webContents.id === contents.id,
        );
        if (matched) {
          // 幂等补挂（已挂载时 ensureCdp 直接返回现有 promise）。
          // 不传 openerTargetId：那是该窗口自己的根 ID，传了就是自引用血缘。
          void ensureCdp(contents, windowRoles.get(matched) ?? 'popup');
        }
      }
      callback({});
    });

    // 匿名 probe 先行落盘（失败不阻止浏览器采集，规范 §8.7）
    try {
      probeResult = await probeRunner({ target: init.target });
    } catch (error) {
      captureSession.evidence().droppedEvent('probe-anonymous', error);
    }
    await writeProbeFile();

    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      show: !hideWindow,
      title: `KVM-Recon Capture - ${init.target.host}`,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: false,
      },
    });
    recordDiagnostic('window-created', `host=${init.target.host} partition=${partition}`);
    // 主窗口挂载必须在首次导航前完成（collectorReadyBeforeFirstNavigation）
    await attachWindow(window, 'main');
    try {
      recordDiagnostic('load-start', targetUrl);
      await window.loadURL(targetUrl);
      recordDiagnostic('load-done', window.webContents.getURL());
    } catch (error) {
      recordDiagnostic(
        'load-failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    // 导航完成后开始 Viewer 活动轮询（加载失败也轮询：采集仍在继续）
    viewerWatchdog.start();
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    viewerWatchdog.stop();
    stopPromise = (async () => {
      await refreshAuthenticatedProbe();
      try {
        await writeProbeFile();
      } catch (error) {
        // 收尾期 Probe 写盘失败（磁盘不可写/水位触发）不能阻断
        // 核心采集会话收尾；记账后继续，Capture Pack 将由必需文件/
        // 导出门禁诚实降级，不把作业永久留在 active。
        captureSession.evidence().droppedEvent('probe-stop-write', error);
      }
      await captureSession.stop();
      stoppedAt = new Date().toISOString();
      stopped = true;
    })();
    return stopPromise;
  }

  async function exportPack(zipDir: string): Promise<ProductionCaptureExportResult> {
    if (!stopped) {
      throw new Error(`先调用 stop() 收尾采集会话再导出：${init.jobId}`);
    }
    const environment = captureSession.environment();
    if (!environment) {
      throw new Error(`页面环境缺失（无根窗口挂载），拒绝装配导出：${init.jobId}`);
    }
    // workflowStatus 由采集会话从观察事实派生（阶段 3），不再硬编码
    const evidenceSummary = captureSession.integrityEvidence();
    const result = await exportJobWorkspaceZip({
      workspace: captureSession.workspace,
      zipDir,
      assembly: {
        tool: init.tool,
        environment,
        evidenceSummary,
        target: {
          host: init.target.host,
          port: init.target.port,
          scheme: init.target.scheme,
          ...(init.target.originalInput ? { originalInput: init.target.originalInput } : {}),
        },
        job: {
          endedAt: stoppedAt ?? undefined,
          deviceLabel: init.deviceLabel,
        },
      },
    });
    await captureSession.workspace.markExported();
    return { ...result, zipPath: result.export.zipPath };
  }

  function windowsOpen() {
    return [...windows].some(window => !window.isDestroyed());
  }

  async function closeWindows() {
    const alive = [...windows].filter(window => !window.isDestroyed());
    if (!alive.length) return;
    await Promise.all(
      alive.map(
        window =>
          new Promise<void>(resolve => {
            if (window.isDestroyed()) {
              resolve();
              return;
            }
            // beforeunload 可能阻止 close：有界等待后强关（destroy），
            // 避免丢弃作业（capture:discard）永久挂起；destroy 也会触发 closed。
            const forceClose = setTimeout(() => {
              if (!window.isDestroyed()) window.destroy();
            }, CLOSE_FORCE_DESTROY_MS);
            window.once('closed', () => {
              clearTimeout(forceClose);
              resolve();
            });
            window.close();
          }),
      ),
    );
  }

  return {
    session: captureSession,
    start,
    stop,
    exportPack,
    windowsOpen,
    closeWindows,
  };
}
