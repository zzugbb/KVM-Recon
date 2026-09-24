/**
 * 采集会话：一份 JobWorkspace + 协议无关 CDP 采集。
 * 管理采集生命周期与原始事实；完整度由导出前的证据门禁派生。
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
import {
  createCollectorEvidence,
  observerHookFailureChannelGaps,
  type CollectorEvidence,
} from './collectorEvidence';
import { createHttpCollector } from './createHttpCollector';
import { createWebSocketCollector } from './createWebSocketCollector';
import { createRuntimeCryptoCollector } from './createRuntimeCryptoCollector';
import { createScriptCollector } from './createScriptCollector';
import { createBrowserStateCollector } from './createBrowserStateCollector';
import { createRealtimeCollector } from './createRealtimeCollector';
import { buildHarIntoWorkspace, HAR_CREATOR, HAR_PATH } from './harBuilder';
import { wrapNetlogIntoWorkspace } from './netlogTransform';
import { readStorageSnapshotFacts } from './storageSnapshotFacts';
import { scanStreamForNeedles } from './chunkedNeedleScan';
import type { CdpSession } from './cdpSession';
import { deriveWorkflowStatus, workflowFactsSignature, type WorkflowFacts } from './workflowStatusEngine';
import { deriveRelations, deriveValueFlow } from './valueFlowEngine';
import {
  PACK_V2_SCHEMA_VERSION,
  type PackIntegrityEvidenceSummary,
  type PackV2BodyRef,
  type PackV2ChannelsFile,
  type PackV2Environment,
  type PackV2TargetRow,
  type PackV2TargetsFile,
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
  /** 派生引擎只读事实快照（采集期随时可调，stop 后为终态事实）。 */
  workflowFacts(): WorkflowFacts;
  /** 在途非持续 HTTP 请求视图（规范 §7.4：自动收尾等待其落盘）。 */
  pendingNonStreamingRequests(): ReadonlyArray<{ id: string; url: string }>;
  /**
   * viewer-initial 阶段截图（§7.4「至少完成 Viewer 初始与稳定阶段截图」）：检出 Viewer 活动时由看门狗对 viewer 所在根 target 调用。
   * 未知根 target 或截图失败 → 显式记账并返回 false（识别失败不停采集）。
   */
  captureViewerInitialScreenshot(targetId: string): Promise<boolean>;
  /** 从观察事实派生的证据摘要（workflowStatus 由引擎从观察事实派生，不再由调用方指定）。 */
  integrityEvidence(): PackIntegrityEvidenceSummary;
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
  // 根 target → 附件：viewer-initial 阶段截图与 popup 根收尾
  // 快照按根 target 路由，不再只从主根采集。
  const rootAttachments = new Map<string, AttachedCapture>();
  // 挂载中途失败的根 target 补行（attached=false）：事件监听在 enable 序列
  // 前已注册，事务可能已进共享 collector 且 targetId 指向该根 target；
  // 不补行则 catalog/targets.json 缺行，relations 引用未知 ID，导出被拒。
  const salvagedTargets: PackV2TargetRow[] = [];
  let primary: AttachedCapture | null = null;
  let primaryTargetId: string | null = null;
  let collectorReady = false;
  let rawJournalsClosed = false;
  let browserStateWritten = false;
  let referencesClosed = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  // Viewer 初始截图可由看门狗异步发起。手动 stop 也必须等它落定，
  // 否则 CDP 返回截图前 workspace 已 finalize，会将本可留存的截图误记为缺失。
  const pendingViewerInitialCaptures = new Set<Promise<boolean>>();
  // popup/OOPIF 可在 stop 前一刻开始挂载。收尾必须等待已发起的
  // attach 落定，否则迟到附件会在终态目录/证据图生成后继续写共享 collector。
  const pendingAttachmentOperations = new Set<Promise<void>>();

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
  // 派生引擎只读事实快照与派生入口：
  // 派生失败绝不阻断收尾——退回诚实下限 TARGET_OPENED 并显式记账。
  const collectWorkflowFacts = (): WorkflowFacts => ({
    transactions: http.transactionRows(),
    actions: browser.actionRows(),
    targets: attachments.flatMap(attached => attached.targets()),
    channels: [...webSockets.channelRows(), ...realtime.channelRows()],
    navigations: attachments.flatMap(attached => attached.mainFrameNavigations()),
    renderSurfaces: browser.renderSurfaceRows(),
    hookFailures: [...evidence.diagnostics().observerHookFailures],
  });
  // 派生结果签名缓存：renderer 2s 轮询 / 看门狗轮询在事实
  // 未变化时直接复用，不重跑 O(actions×navigations) 派生配对；签名由
  // workflowFactsSignature 投影派生引擎读取的全部字段（含原位变更），
  // 事实一变即失效——不会给出过期状态。
  let workflowStatusCache: { signature: string; value: CaptureFacts['workflowStatus'] } | null = null;
  const currentWorkflowStatus = (): CaptureFacts['workflowStatus'] => {
    const facts = collectWorkflowFacts();
    const signature = workflowFactsSignature(facts);
    if (workflowStatusCache && workflowStatusCache.signature === signature) {
      return workflowStatusCache.value;
    }
    try {
      const value = deriveWorkflowStatus(facts).workflowStatus;
      workflowStatusCache = { signature, value };
      return value;
    } catch (error) {
      evidence.droppedEvent('workflow-status-derive', error);
      return 'TARGET_OPENED';
    }
  };
  const writeCaptureFacts = async (stopped: boolean) => {
    // 终态 workflowStatus 由派生引擎从观察事实推导；挂载中间态（v1）保持
    // 诚实下限 TARGET_OPENED（未收尾不主张更高状态）。
    const workflowStatus = stopped ? currentWorkflowStatus() : 'TARGET_OPENED';
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
      workflowStatus,
      stopped,
      evidenceSummary: stopped
        ? evidence.summary({
            collectorReadyBeforeFirstNavigation: collectorReady,
            rawJournalsClosed,
            browserStateWritten,
            evidenceReferencesClosed: referencesClosed,
            workflowStatus,
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

    // stop() 调用瞬间已将 stopped 置 true，不会再登记新附件/截图；
    // 先等待此前已发起的工作，再关闭事件入口。失败附件已自行
    // 补 salvage target 并记账，不应使其他附件无法收尾。
    if (pendingAttachmentOperations.size > 0) {
      await Promise.allSettled([...pendingAttachmentOperations]);
    }
    if (pendingViewerInitialCaptures.size > 0) {
      await Promise.allSettled([...pendingViewerInitialCaptures]);
    }
    for (const attached of attachments) attached.stopAccepting();
    await Promise.all(attachments.map(attached => safeStep('drain', () => attached.drain())));
    collectorReady =
      attachments.length > 0 && attachments.every(attached => attached.readyBeforeFirstNavigation());
    if (primary) {
      const primaryAttached = primary;
      await safeStep('snapshot-browser-state', async () => {
        const steps = await primaryAttached.snapshotBrowserState();
        // 按步骤键遍历（新增步骤自动进步骤明细，不出现静默步骤）
        const failedSteps = (Object.keys(steps) as Array<keyof typeof steps>).filter(
          step => !steps[step],
        );
        for (const step of failedSteps) {
          // 步骤失败（内部已记账为 droppedEvent）不得
          // 伪装成「已写入」——browserStateGaps 缺口 → INCOMPLETE_BROWSER_STATE
          evidence.recordGap('browserState', step, '浏览器状态快照步骤失败（详见 droppedEventByMethod）');
        }
        browserStateWritten = failedSteps.length === 0;
        const pageEnv = await primaryAttached.collectPageEnvironment();
        if (pageEnv) pageEnvironment = pageEnv;
      });
    }
    // popup 根的 Storage + 最终状态也逐根采集。Cookie 是 profile 级，
    // 但 sessionStorage 是 browsing-context 级，主根快照不能代表 popup。
    for (const [rootTargetId, attached] of rootAttachments) {
      if (attached === primary) continue;
      await safeStep('snapshot-popup-storage', async () => {
        const steps = await attached.snapshotAdditionalStorage();
        for (const step of (Object.keys(steps) as Array<keyof typeof steps>)) {
          if (steps[step]) continue;
          evidence.recordGap(
            'browserState',
            `popup-${step}:${rootTargetId}`,
            `popup 根（${rootTargetId}）${step} 快照失败（详见 droppedEventByMethod）`,
          );
        }
      });
      await safeStep('snapshot-final-surfaces', async () => {
        const steps = await attached.snapshotFinalSurfaces();
        if (!steps.stopScreenshot) {
          evidence.recordGap(
            'browserState',
            `stop-screenshot:${rootTargetId}`,
            `popup 根（${rootTargetId}）收尾 stop 截图失败（详见 droppedEventByMethod）`,
          );
        }
        if (!steps.domSnapshot) {
          evidence.recordGap(
            'browserState',
            `dom-snapshot:${rootTargetId}`,
            `popup 根（${rootTargetId}）收尾 DOM 快照失败（详见 droppedEventByMethod）`,
          );
        }
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
    // 挂载失败补行先入表（诚实下限），成功附件的完整行随后覆盖同名 id
    for (const row of salvagedTargets) {
      if (!targetRowsById.has(row.id)) targetRowsById.set(row.id, row);
    }
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
    // 观察脚本钩子失败的表面条件映射：只有对应观察面
    // 真实在场（webrtc/webtransport/sse 通道行存在）才构成 channelGaps
    // 缺口；必须在终态 facts 写入前记账，才能进证据摘要。
    const hookFailures = evidence.diagnostics().observerHookFailures;
    if (hookFailures.length > 0) {
      const channelKinds = new Set(channelsFile.channels.map(row => row.kind));
      for (const gap of observerHookFailureChannelGaps(hookFailures, channelKinds)) {
        evidence.recordGap('channelGaps', gap.id, gap.detail);
      }
    }

    // 证据图：从观察事实派生 ai/value-flow.json 与
    // catalog/relations.jsonl。只记字节级观察背书的边；storage 快照读取
    // 失败只丢 cookie 链（显式记账），crypto / WS 参数链继续派生。
    // 派生/写盘失败（含 storage 读取降级）不得伪装成
    // 「已闭环」——evidenceGraphOk=false 时 referencesClosed 不置位。
    let evidenceGraphOk = false;
    await safeStep('evidence-graph', async () => {
      let storageReadFailed = false;
      let storageCookies: Array<{ name: string; value: string }> = [];
      let storageValues: Array<{ key: string; value: string }> = [];
      let storageCapturedAt = now();
      try {
        // 流式提取：storage.json 的 indexedDb records 内联无上界，
        // 只走查证据图实际消费的字段，不整体载入
        const storageStream = await workspace.openArtifactStream('raw/browser/storage.json');
        storageStream.setEncoding('utf8');
        const snapshot = await readStorageSnapshotFacts(storageStream);
        if (snapshot.capturedAt !== null) storageCapturedAt = snapshot.capturedAt;
        storageCookies = snapshot.storageCookies;
        storageValues = snapshot.storageValues;
      } catch (error) {
        // storage.json 是快照步产物；读取失败不牵连其余派生链
        evidence.droppedEvent('value-flow-storage-read', error);
        evidence.recordGap(
          'evidenceGraph',
          'value-flow-storage-read',
          'storage 快照读取失败：cookie / storage 值链边丢弃',
        );
        storageReadFailed = true;
      }
      const readBody = async (ref: PackV2BodyRef): Promise<Buffer | null> => {
        try {
          return await workspace.readArtifact(ref.path);
        } catch {
          return null;
        }
      };
      // 干草堆侧分块扫描：needle 长于正文总字节数时数学上不可能命中，
      // 跳过读取（诚实预筛，不是截断）；其余逐块滚动扫描，不整体载入
      const scanBody = async (
        ref: PackV2BodyRef,
        needles: ReadonlyArray<Buffer>,
      ): Promise<ReadonlySet<Buffer> | null> => {
        if (needles.length === 0) return new Set<Buffer>();
        const candidates = needles.filter(
          needle => needle.byteLength > 0 && needle.byteLength <= ref.bytes,
        );
        if (candidates.length === 0) return new Set<Buffer>();
        try {
          const stream = await workspace.openArtifactStream(ref.path);
          return await scanStreamForNeedles(stream, candidates);
        } catch {
          return null;
        }
      };
      const derived = await deriveValueFlow(
        {
          transactions: http.transactionRows(),
          cryptoRows: crypto.rows(),
          wsChannels: webSockets.handshakeFacts(),
          storageCookies,
          storageValues,
          storageCapturedAt,
        },
        { readBody, scanBody },
      );
      await workspace.writeArtifact('ai/value-flow.json', json2(derived.valueFlow));
      const relations = deriveRelations(
        {
          transactions: http.transactionRows(),
          targets: [...targetRowsById.values()],
          channels: channelsFile.channels,
        },
        derived.relations,
      );
      await workspace.writeArtifact(
        'catalog/relations.jsonl',
        relations.length === 0 ? '' : `${relations.map(row => JSON.stringify(row)).join('\n')}\n`,
      );
      if (!storageReadFailed) evidenceGraphOk = true;
    });
    if (!evidenceGraphOk) {
      // 步骤整体抛出（safeStep 已记 droppedEvent）或 storage 读取降级：
      // 缺口显式记账，evidence-references-closed 门禁如实失败
      evidence.recordGap(
        'evidenceGraph',
        'evidence-graph',
        '证据图派生或写盘未完成（详见 droppedEventByMethod）',
      );
    }

    await safeStep('workspace-flush', async () => {
      await workspace.flush();
      rawJournalsClosed = true;
      if (evidenceGraphOk) referencesClosed = true;
    });
    // 终态 facts（含完整证据摘要）必须在 finalize 前落盘：崩溃恢复导出的
    // 单一事实来源。
    await safeStep('capture-facts', () => writeCaptureFacts(true));
    await safeStep('workspace-finalize', () => workspace.finalize());
  };

  return {
    workspace,
    attachCdp(cdp, context) {
      if (stopped) return Promise.reject(new Error('采集会话已停止，不能再挂载 CDP'));
      let operation!: Promise<void>;
      operation = (async () => {
        let attached: AttachedCapture;
        try {
          attached = await attachProtocolAgnosticCapture({
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
        } catch (error) {
          // 挂载中途失败（enable 序列某步抛出）：附件被丢弃，但已进共享
          // collector 的事务仍在——补 attached=false 行保住 target 身份，
          // 识别失败绝不牵连导出（UNKNOWN_EVIDENCE_ID 门禁不再触发）。
          salvagedTargets.push({
            id: context?.targetId ?? 'target-root',
            type: context?.windowRole === 'popup' ? 'popup' : 'page',
            attached: false,
            url: null,
            ...(context?.openerTargetId ? { openerTargetId: context.openerTargetId } : {}),
            detachReason: 'attach-failed',
          });
          throw error;
        }
        if (!primary) {
          primary = attached;
          primaryTargetId = context?.targetId ?? 'target-root';
        }
        attachments.push(attached);
        rootAttachments.set(context?.targetId ?? 'target-root', attached);
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
      })().finally(() => pendingAttachmentOperations.delete(operation));
      pendingAttachmentOperations.add(operation);
      return operation;
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
    workflowFacts() {
      return collectWorkflowFacts();
    },
    pendingNonStreamingRequests() {
      return http.pendingNonStreamingHops();
    },
    async captureViewerInitialScreenshot(targetId: string) {
      // （§7.4）：viewer-initial 阶段截图按根 target 路由；未知
      // target（未挂载 / 已 detach / 收尾后）显式记账返回 false，识别与
      // 采集照常继续——缺截图由一致性验证器如实报缺口。
      // Viewer 可以在 iframe/OOPIF 子 target 中。截图仍从其所属根
      // BrowserWindow 采全画面，不应因 targetId 不是根窗口就误报缺失。
      const attached =
        rootAttachments.get(targetId) ??
        attachments.find(candidate => candidate.targets().some(target => target.id === targetId));
      if (!attached || stopped) {
        evidence.droppedEvent(
          'viewer-initial-screenshot',
          new Error(stopped ? `收尾已开始，viewer target ${targetId} 阶段截图不再写入` : `未知 viewer 根 target：${targetId}（未挂载）`),
        );
        evidence.recordGap(
          'browserState',
          `viewer-initial:${targetId}`,
          stopped ? '收尾开始前未完成 Viewer 初始截图' : 'Viewer target 未挂载，无法完成初始截图',
        );
        return false;
      }
      let operation!: Promise<boolean>;
      operation = (async () => {
        try {
          const captured = await attached.capturePhaseScreenshot('viewer-initial');
          if (!captured) {
            evidence.recordGap(
              'browserState',
              `viewer-initial:${targetId}`,
              'Viewer 初始截图失败（详见 droppedEventByMethod）',
            );
          }
          return captured;
        } catch (error) {
          evidence.droppedEvent('viewer-initial-screenshot', error);
          evidence.recordGap(
            'browserState',
            `viewer-initial:${targetId}`,
            'Viewer 初始截图异常（详见 droppedEventByMethod）',
          );
          return false;
        }
      })().finally(() => pendingViewerInitialCaptures.delete(operation));
      pendingViewerInitialCaptures.add(operation);
      return operation;
    },
    integrityEvidence() {
      return evidence.summary({
        collectorReadyBeforeFirstNavigation: collectorReady,
        rawJournalsClosed,
        browserStateWritten,
        evidenceReferencesClosed: referencesClosed,
        workflowStatus: currentWorkflowStatus(),
      });
    },
  };
}
