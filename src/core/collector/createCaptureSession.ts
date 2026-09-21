/**
 * 阶段 2 采集会话：一份 JobWorkspace + 协议无关 CDP 采集。
 * 不接 0.2.x 生产 Controller，不实现完整度引擎。
 *
 * stop() 收尾顺序（规范 §7.4）：停止接收 → 排空事件链 → 浏览器状态快照
 * （含 IndexedDB / CacheStorage / 截图 / DOM 快照）→ 页面环境 → NetLog 包装
 * → HAR 构建 → targets / channels 目录 → 补齐必需空 journal → finalize。
 * 收尾幂等（重入共享同一次收尾，不重放）；每个步骤的失败都进证据记账后
 * 继续后续步骤（best-effort），绝不静默跳过，也绝不中止剩余收尾——
 * 规范 §9 要求未完整包仍可导出。
 */

import { startJobWorkspace, type JobWorkspace, type JobWorkspaceInit } from '../job-workspace/createJobWorkspace';
import { attachProtocolAgnosticCapture, type AttachedCapture, type PageEnvironment } from './attachProtocolAgnosticCapture';
import { CAPTURE_FACTS_PATH, parseCaptureTarget, type CaptureFacts } from './captureFacts';
import { createCdpJournal } from './createCdpJournal';
import { createCollectorEvidence, type CollectorEvidence } from './collectorEvidence';
import { createHttpCollector } from './createHttpCollector';
import { createWebSocketCollector } from './createWebSocketCollector';
import { createRuntimeCryptoCollector } from './createRuntimeCryptoCollector';
import { createScriptCollector } from './createScriptCollector';
import { createBrowserStateCollector } from './createBrowserStateCollector';
import { createRealtimeCollector } from './createRealtimeCollector';
import { buildHarIntoWorkspace, HAR_CREATOR, HAR_PATH } from './harBuilder';
import { wrapNetlogIntoWorkspace } from './netlogTransform';
import type { CdpSession } from './cdpSession';
import {
  PACK_V2_SCHEMA_VERSION,
  type PackIntegrityEvidenceSummary,
  type PackV2ChannelsFile,
  type PackV2Environment,
  type PackV2TargetRow,
  type PackV2TargetsFile,
  type WorkflowStatus,
} from '../capture-pack-v2/types';

export type { CdpSession } from './cdpSession';

/** NetLog 源（Electron netLog 等价物）；源文件必须写进工作区内部 .tmp/（不进包）。 */
export interface NetlogSource {
  start(workspaceDir: string): Promise<void>;
  stop(): Promise<{ sourcePath: string; captureMode: string } | null>;
}

export interface MainEnvironment {
  chromium: string;
  electron: string;
  os: string;
}

export interface CaptureSessionInit extends JobWorkspaceInit {
  now?: () => string;
  mainEnvironment?: MainEnvironment;
  netlog?: NetlogSource;
}

const EMPTY_IF_MISSING_JSONL = [
  'raw/cdp/events.jsonl',
  'raw/cdp/commands.jsonl',
  'raw/http/transactions.jsonl',
  'catalog/resources.jsonl',
  'catalog/relations.jsonl',
  'raw/realtime/webrtc.jsonl',
  'raw/realtime/webtransport.jsonl',
  'raw/realtime/sse.jsonl',
  'raw/realtime/downloads.jsonl',
  'raw/runtime/crypto.jsonl',
  'raw/browser/timeline.jsonl',
  'raw/browser/actions.jsonl',
  'raw/browser/console.jsonl',
] as const;

const NETLOG_FALLBACK_PATH = 'raw/netlog/netlog.json';

export interface CaptureSessionAttachContext {
  /** 根 target ID（默认 target-root；多根窗口时按窗口区分，如 target-window-3）。 */
  targetId?: string;
  windowId?: string;
  /** popup 根窗口：根 target 行记 type=popup 并带 opener 血缘。 */
  windowRole?: 'main' | 'popup';
  /** popup 的 opener 根 target ID（主窗口的 targetId）。 */
  openerTargetId?: string;
}

export interface CaptureSession {
  readonly workspace: JobWorkspace;
  /**
   * 挂载一个根 CDP 会话（一个 Electron 窗口一个 webContents.debugger）。
   * 可多次调用（主窗口 + popup）；第一个挂载的根为主根，浏览器状态快照
   * 与页面环境从主根采集。
   */
  attachCdp(cdp: CdpSession, context?: CaptureSessionAttachContext): Promise<void>;
  drain(): Promise<void>;
  /** 等待在途落盘后 finalize。目录保留，可继续 readArtifact。 */
  stop(): Promise<void>;
  /** 页面侧 + 主进程侧合并后的采集环境（首个根挂载后即可用；未采集为 null）。 */
  environment(): PackV2Environment | null;
  /** 采集失败记账（缺口分类计数与丢弃事件诊断）。 */
  evidence(): CollectorEvidence;
  /** 阶段 3 IntegrityEngine 的证据摘要输入（stop 之后调用才有完整事实）。 */
  integrityEvidence(workflowStatus: WorkflowStatus): PackIntegrityEvidenceSummary;
}

function json2(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function startCaptureSession(init: CaptureSessionInit): Promise<CaptureSession> {
  const now = init.now ?? (() => new Date().toISOString());
  const workspace = await startJobWorkspace(init);
  const evidence = createCollectorEvidence();
  const journal = createCdpJournal(workspace, evidence);
  const http = createHttpCollector(workspace, evidence);
  const webSockets = createWebSocketCollector(workspace, evidence);
  const crypto = createRuntimeCryptoCollector(workspace, evidence);
  const scripts = createScriptCollector(workspace, evidence);
  const browser = createBrowserStateCollector(workspace, evidence);
  const realtime = createRealtimeCollector(workspace, evidence);
  let attachments: AttachedCapture[] = [];
  let primary: AttachedCapture | null = null;
  let primaryTargetId: string | null = null;
  let collectorReady = false;
  let rawJournalsClosed = false;
  let browserStateWritten = false;
  let referencesClosed = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  if (init.netlog) {
    try {
      await init.netlog.start(workspace.dir);
    } catch (error) {
      // 捕获 NetLog 启动失败：浏览器采集继续，缺口在 stop 时落兜底文件
      evidence.droppedEvent('netlog-start', error);
    }
  }

  // capture-facts v1：首个根挂载成功后立即落盘（target / 主进程环境），
  // 页面环境（UA / 语言 / 时区 / 屏幕为浏览器级事实，与具体页面无关）在
  // 挂载后即采集一次——硬崩溃后恢复导出仍能装配出带真实环境的 manifest。
  const targetFacts = parseCaptureTarget(init.targetUrl ?? null);
  let pageEnvironment: PageEnvironment | null = null;
  const writeCaptureFacts = async (stopped: boolean) => {
    const facts: CaptureFacts = {
      schemaVersion: '1.0.0',
      jobId: workspace.jobId,
      workspaceId: workspace.workspaceId,
      startedAt: workspace.startedAt,
      endedAt: stopped ? now() : null,
      deviceLabel: workspace.deviceLabel,
      targetUrl: workspace.targetUrl,
      target: targetFacts,
      environment:
        pageEnvironment && init.mainEnvironment
          ? {
              chromium: init.mainEnvironment.chromium,
              electron: init.mainEnvironment.electron,
              os: init.mainEnvironment.os,
              userAgent: pageEnvironment.userAgent,
              language: pageEnvironment.language,
              timezone: pageEnvironment.timezone,
              screen: pageEnvironment.screen,
            }
          : null,
      workflowStatus: 'TARGET_OPENED',
      stopped,
      evidenceSummary: stopped
        ? evidence.summary({
            collectorReadyBeforeFirstNavigation: collectorReady,
            rawJournalsClosed,
            browserStateWritten,
            evidenceReferencesClosed: referencesClosed,
            workflowStatus: 'TARGET_OPENED',
          })
        : null,
      // droppedEvent 诊断的包内落盘形态（规范 §3）：stop 收尾时快照一次，
      // 此后 capture-facts 即终态（后续步骤失败只进进程内计数，不再改写）。
      droppedEventByMethod: stopped ? { ...evidence.diagnostics().droppedEventByMethod } : null,
    };
    await workspace.writeArtifact(CAPTURE_FACTS_PATH, json2(facts));
  };

  // 收尾序列（best-effort）：每个步骤失败都进证据记账并继续后续步骤——
  // 规范 §9 要求 INCOMPLETE（含 INCOMPLETE_STORAGE_LIMIT / INCOMPLETE_BROWSER_STATE）
  // 的包仍可导出，任何单步失败不得中止剩余收尾。
  const runStopSequence = async (): Promise<void> => {
    const safeStep = async (label: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        evidence.droppedEvent(label, error);
      }
    };

    for (const attached of attachments) attached.stopAccepting();
    await Promise.all(attachments.map(attached => safeStep('drain', () => attached.drain())));
    collectorReady =
      attachments.length > 0 && attachments.every(attached => attached.readyBeforeFirstNavigation());
    if (primary) {
      const primaryAttached = primary;
      await safeStep('snapshot-browser-state', async () => {
        await primaryAttached.snapshotBrowserState();
        browserStateWritten = true;
        const pageEnv = await primaryAttached.collectPageEnvironment();
        if (pageEnv) pageEnvironment = pageEnv;
      });
    }
    await safeStep('http-flush', () => http.flush());
    await safeStep('websockets-flush', () => webSockets.flush());
    await safeStep('scripts-flush', () => scripts.flush());

    // 必需 journal 先补齐（HAR 依赖 transactions.jsonl 存在）
    const existing = new Set(await workspace.artifactPaths());
    for (const path of EMPTY_IF_MISSING_JSONL) {
      if (!existing.has(path)) await safeStep('journal-backfill', () => workspace.writeArtifact(path, ''));
    }
    // storage.json 兜底：快照失败或无根挂载时也必须存在（导出必需文件；
    // 空集合是诚实形态，快照失败本身已由 droppedEvent 记账）
    if (!existing.has('raw/browser/storage.json')) {
      await safeStep('storage-backfill', () =>
        workspace.writeArtifact(
          'raw/browser/storage.json',
          json2({
            schemaVersion: PACK_V2_SCHEMA_VERSION,
            targetId: primaryTargetId ?? 'unavailable',
            capturedAt: now(),
            cookies: [],
            localStorage: {},
            sessionStorage: {},
            indexedDb: [],
            cacheStorage: [],
          }),
        ),
      );
    }

    await safeStep('netlog-wrap', async () => {
      try {
        if (init.netlog) {
          const result = await init.netlog.stop();
          if (result) {
            await wrapNetlogIntoWorkspace(result.sourcePath, workspace, result.captureMode);
            return;
          }
          evidence.droppedEvent('netlog-stop', new Error('NetLog 源未返回文件'));
        }
        // 未提供 NetLog 源显式兜底（RAW_JOURNAL_EMPTY 门禁会在存在事务时拒绝）
        await workspace.writeArtifact(
          NETLOG_FALLBACK_PATH,
          json2({
            schemaVersion: PACK_V2_SCHEMA_VERSION,
            captureMode: init.netlog ? 'capture-failed' : 'not-captured',
            events: [],
          }),
        );
      } catch (error) {
        // 捕获 NetLog 包装失败：残缺源不输出静默截断副本，落显式兜底
        // （覆盖 transform 中途留下的半个 JSON）
        evidence.droppedEvent('netlog-wrap', error);
        await workspace.writeArtifact(
          NETLOG_FALLBACK_PATH,
          json2({ schemaVersion: PACK_V2_SCHEMA_VERSION, captureMode: 'capture-failed', events: [] }),
        );
      }
    });

    try {
      await buildHarIntoWorkspace(workspace);
    } catch (error) {
      // HAR 构建失败：显式兜底（空 entries + 失败注释；原始索引与正文仍在包内）
      evidence.droppedEvent('har-build', error);
      await safeStep('har-fallback', () =>
        workspace.writeArtifact(
          HAR_PATH,
          `${JSON.stringify({
            log: {
              version: '1.2',
              creator: HAR_CREATOR,
              entries: [],
              comment: `HAR 构建失败：${error instanceof Error ? error.message : String(error)}（原始索引与正文仍在包内）`,
            },
          })}\n`,
        ),
      );
    }

    const targetRowsById = new Map<string, PackV2TargetRow>();
    for (const attached of attachments) {
      for (const row of attached.targets()) {
        const known = targetRowsById.get(row.id);
        targetRowsById.set(row.id, known ? { ...known, ...row, url: row.url ?? known.url } : row);
      }
    }
    const targetsFile: PackV2TargetsFile = {
      schemaVersion: PACK_V2_SCHEMA_VERSION,
      targets: [...targetRowsById.values()],
    };
    await safeStep('targets-catalog', async () => {
      await workspace.writeArtifact('catalog/targets.json', json2(targetsFile));
      await workspace.writeArtifact('raw/browser/targets.json', json2(targetsFile));
    });
    const channelsFile: PackV2ChannelsFile = {
      schemaVersion: PACK_V2_SCHEMA_VERSION,
      channels: [...webSockets.channelRows(), ...realtime.channelRows()],
    };
    await safeStep('channels-catalog', () =>
      workspace.writeArtifact('catalog/channels.json', json2(channelsFile)),
    );

    await safeStep('workspace-flush', async () => {
      await workspace.flush();
      rawJournalsClosed = true;
      referencesClosed = true;
    });
    // 终态 facts（含完整证据摘要）必须在 finalize 前落盘：崩溃恢复导出的
    // 单一事实来源。
    await safeStep('capture-facts', () => writeCaptureFacts(true));
    await safeStep('workspace-finalize', () => workspace.finalize());
  };

  return {
    workspace,
    async attachCdp(cdp, context) {
      if (stopped) throw new Error('采集会话已停止，不能再挂载 CDP');
      const attached = await attachProtocolAgnosticCapture({
        cdp,
        journal,
        http,
        webSockets,
        crypto,
        scripts,
        browser,
        realtime,
        evidence,
        now,
        rootTargetId: context?.targetId ?? 'target-root',
        windowId: context?.windowId,
        rootWindowRole: context?.windowRole,
        rootOpenerTargetId: context?.openerTargetId,
      });
      if (!primary) {
        primary = attached;
        primaryTargetId = context?.targetId ?? 'target-root';
      }
      attachments.push(attached);
      if (!pageEnvironment) {
        // 浏览器级环境事实：挂在导航前采集也成立（不依赖具体页面内容）。
        try {
          const pageEnv = await attached.collectPageEnvironment();
          if (pageEnv) pageEnvironment = pageEnv;
        } catch (error) {
          // 捕获早期环境采集失败：stop 时会重试；崩溃恢复退回保守事实
          evidence.droppedEvent('page-environment-early', error);
        }
      }
      if (!stopped) await writeCaptureFacts(false);
    },
    async drain() {
      await Promise.all(attachments.map(attached => attached.drain()));
    },
    async stop() {
      // 幂等：重入共享同一次收尾。重放整个序列会把已写好的 netlog.json
      // 覆盖成 capture-failed 兜底（electronNetlogSource 二次 stop 返回 null）。
      if (stopPromise) return stopPromise;
      stopped = true;
      if (workspace.storageLimited) {
        evidence.markStorageLimitReached();
      }
      stopPromise = runStopSequence();
      return stopPromise;
    },
    environment() {
      const main = init.mainEnvironment;
      if (!pageEnvironment || !main) return null;
      return {
        chromium: main.chromium,
        electron: main.electron,
        os: main.os,
        userAgent: pageEnvironment.userAgent,
        language: pageEnvironment.language,
        timezone: pageEnvironment.timezone,
        screen: pageEnvironment.screen,
      };
    },
    evidence() {
      return evidence;
    },
    integrityEvidence(workflowStatus) {
      return evidence.summary({
        collectorReadyBeforeFirstNavigation: collectorReady,
        rawJournalsClosed,
        browserStateWritten,
        evidenceReferencesClosed: referencesClosed,
        workflowStatus,
      });
    },
  };
}
