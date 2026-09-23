/**
 * 把 CDP Network / Target / Runtime / Debugger / Page / Log / Browser 事件写入
 * 协议无关采集器（规范 §7.1 / §8）。
 * 不复用 0.2.x recorder，不按 MIME/大小跳过正文。
 *
 * 失败记账：所有被捕获后继续执行的错误都进 evidence（缺口或丢弃计数），
 * 不静默吞掉；根会话第一刀失败（attach / Network.enable / 观察脚本注入）
 * 仍然抛出，调用方必须看到「采集器没有就绪」。
 */

import type { CdpJournal } from './createCdpJournal';
import type { HttpCollector } from './createHttpCollector';
import type { WebSocketCollector } from './createWebSocketCollector';
import type { RuntimeCryptoCollector } from './createRuntimeCryptoCollector';
import type { ScriptCollector } from './createScriptCollector';
import type { BrowserStateCollector } from './createBrowserStateCollector';
import type { RealtimeCollector } from './createRealtimeCollector';
import type { CollectorEvidence } from './collectorEvidence';
import { OBSERVER_BINDING_NAME, OBSERVER_SCRIPT_SOURCE } from './observerScript';
import { sendCdpCommand, type CdpSession } from './cdpSession';
import {
  decodeCdpBody,
  headerValue,
  headersValue,
  isRecord,
  numberValue,
  optionalNumber,
  optionalString,
  scopedId,
  stringValue,
} from './cdpValues';
import type {
  DynamicScriptKind,
  PackV2BrowserActionRow,
  PackV2CacheStorageEntry,
  PackV2IndexedDbEntry,
  PackV2RenderSurfaceRow,
  PackV2TargetRow,
  PackV2TargetType,
  PackV2HttpInitiator,
  RenderSurfaceKind,
  WsFrameOpcode,
} from '../capture-pack-v2/types';

const DEFAULT_NETWORK_ENABLE_TIMEOUT_MS = 5000;
const OPTIONAL_CDP_TIMEOUT_MS = 3000;
const SCRIPT_SOURCE_TIMEOUT_MS = 5000;
const INTERNAL_SCRIPT_URL_PREFIX = 'kvm-recon-internal://';

/**
 * 给采集器自身执行的脚本附加可识别 URL。
 * Debugger.scriptParsed 同样会观察 Runtime.evaluate / 新文档注入；不标记会把
 * 采集器探针误当成目标脚本，导航销毁探针时还会错误降低包完整度。
 */
function internalScriptSource(name: string, source: string): string {
  return `${source}\n//# sourceURL=${INTERNAL_SCRIPT_URL_PREFIX}${name}`;
}

/**
 * drain 阶段仍要落盘的事件：target 生命周期 / 脚本 / binding / 下载收尾，
 * 以及在途 HTTP 请求的完成事件（responseReceived / loadingFinished /
 * loadingFailed / extraInfo）——收尾截断在途请求的完成事实等于把未完成
 * 请求伪装成「无正文语义」（规范 §14 条 3）。
 * requestWillBeSent 不放开：drain 期不追踪新请求。
 */
const DRAIN_METHODS = new Set([
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Target.targetCreated',
  'Target.targetDestroyed',
  'Debugger.scriptParsed',
  'Runtime.bindingCalled',
  'Browser.downloadWillBegin',
  'Browser.downloadProgress',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceivedExtraInfo',
]);

/**
 * loadingFinished 后等待 responseReceivedExtraInfo 的有界提交宽限：Chromium 不
 * 保证 extraInfo 先于 loadingFinished 到达（e2e 实测可晚数毫秒，Set-Cookie /
 * Cookie 头只在该事件里）。宽限内到达的头合并后才提交事务行；计时到点自行
 * 提交，晚于宽限到达的头由 extraInfo 分支按 droppedEvent 显式记账。
 */
const RESPONSE_EXTRA_INFO_COMMIT_GRACE_MS = 50;

/** 观察脚本上报的 render-surface 种类全集（§7.3 第 2 组事实）。 */
const RENDER_SURFACE_KINDS = new Set<RenderSurfaceKind>([
  'canvas',
  'video',
  'offscreencanvas',
  'canvas-context',
  'worker',
  'shared-worker',
  'request-animation-frame',
]);

/** 观察脚本上报的 surface 值校验：未知值不落行（schema enum 拒绝），显式丢弃。 */
function renderSurfaceKindOf(value: unknown): RenderSurfaceKind | null {
  const surface = optionalString(value);
  return surface !== null && RENDER_SURFACE_KINDS.has(surface as RenderSurfaceKind)
    ? (surface as RenderSurfaceKind)
    : null;
}

export interface PageEnvironment {
  userAgent: string;
  language: string;
  timezone: string;
  screen: string;
}

export interface AttachProtocolAgnosticCaptureInput {
  cdp: CdpSession;
  journal: CdpJournal;
  evidence: CollectorEvidence;
  http: HttpCollector;
  webSockets: WebSocketCollector;
  crypto: RuntimeCryptoCollector;
  scripts: ScriptCollector;
  browser: BrowserStateCollector;
  realtime: RealtimeCollector;
  now: () => string;
  rootTargetId: string;
  windowId?: string;
  /** 根窗口角色：popup 时根 target 行记 type=popup（Electron 各窗口独立 debugger，CDP 看不到跨窗口 opener）。 */
  rootWindowRole?: 'main' | 'popup';
  /** popup 根的 opener 根 target ID（Electron 窗口树血缘，CDP target 事件不携带）。 */
  rootOpenerTargetId?: string;
  networkEnableTimeoutMs?: number;
}

/**
 * 浏览器状态快照的步骤明细：各步失败已内部记账并
 * 继续收尾，但不得伪装成「已写入」——由 createCaptureSession 汇总为
 * browserStateGaps 缺口，完整度门禁如实失败。
 */
export interface BrowserStateStepOutcome {
  cookies: boolean;
  storage: boolean;
  indexedDb: boolean;
  cacheStorage: boolean;
  frameTree: boolean;
  stopScreenshot: boolean;
  domSnapshot: boolean;
}

export interface AttachedCapture {
  drain(): Promise<void>;
  /** 之后到达的 CDP 事件不再写入工作区。 */
  stopAccepting(): void;
  /** Cookie / Storage / IndexedDB / CacheStorage 快照 + 收尾截图与 DOM 快照；stopAccepting 之后、finalize 之前调用。返回各步骤成败明细。 */
  snapshotBrowserState(): Promise<BrowserStateStepOutcome>;
  /** popup/独立窗口自己的 Storage 上下文；sessionStorage 不能用主窗口代替。 */
  snapshotAdditionalStorage(): Promise<{
    storage: boolean;
    indexedDb: boolean;
    cacheStorage: boolean;
  }>;
  /** 阶段截图（§7.4：viewer-initial = 检测到 Viewer 活动时；stop = 收尾时）；失败内部已记 droppedEvent，成败返回调用方。 */
  capturePhaseScreenshot(label: string): Promise<boolean>;
  /** 非主根收尾画面：stop 截图 + DOM 快照（popup Viewer 最终状态）；失败内部已记 droppedEvent，成败返回调用方。 */
  snapshotFinalSurfaces(): Promise<{ stopScreenshot: boolean; domSnapshot: boolean }>;
  /** 页面侧运行环境（UA / 语言 / 时区 / 屏幕）。 */
  collectPageEnvironment(): Promise<PageEnvironment | null>;
  /** catalog/targets.json 与 raw/browser/targets.json 的行。 */
  targets(): PackV2TargetRow[];
  /** 主框架导航事实（Page.frameNavigated 无 parentId 的帧；派生引擎只读快照）。 */
  mainFrameNavigations(): Array<{ occurredAt: string; targetId: string; url: string | null }>;
  /** 采集器是否在第一次导航前就绪（规范 §14 条件 1 的事实）。 */
  readyBeforeFirstNavigation(): boolean;
}

function mapInitiator(raw: unknown): PackV2HttpInitiator | undefined {
  if (!isRecord(raw)) return undefined;
  const stack = isRecord(raw.stack) ? raw.stack : undefined;
  const callFrames = Array.isArray(stack?.callFrames)
    ? stack.callFrames.filter(isRecord)
    : undefined;
  return {
    type: stringValue(raw.type) || 'other',
    url: optionalString(raw.url),
    lineNumber: optionalNumber(raw.lineNumber),
    stackTrace: callFrames,
  };
}

function mapTargetType(type: string, openerId: string | undefined): PackV2TargetType {
  const normalized = type.toLowerCase().replace(/_/g, '-');
  if (normalized === 'shared-worker' || normalized === 'sharedworker') return 'shared-worker';
  if (normalized === 'service-worker' || normalized === 'serviceworker') return 'service-worker';
  if (normalized === 'worker') return 'worker';
  if (normalized === 'iframe') return 'iframe';
  if (normalized === 'oopif') return 'oopif';
  if (normalized === 'page' || normalized === 'webview') return openerId ? 'popup' : 'page';
  return 'page';
}

function wsOpcode(opcode: number): WsFrameOpcode {
  switch (opcode) {
    case 0:
      return 'continuation';
    case 1:
      return 'text';
    case 2:
      return 'binary';
    case 8:
      return 'close';
    case 9:
      return 'ping';
    case 10:
      return 'pong';
    default:
      return 'binary';
  }
}

function socketChannelId(requestId: string, sessionId?: string): string {
  // 原始 scoped ID 直传采集器（身份保真）；清洗后的目录名冲突由采集器去重
  return scopedId(requestId, sessionId);
}

function decodeFramePayload(opcode: WsFrameOpcode, payloadData: string): Buffer {
  if (opcode === 'text') return Buffer.from(payloadData, 'utf8');
  return Buffer.from(payloadData, 'base64');
}

function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return '';
  return args
    .map(arg => {
      if (!isRecord(arg)) return String(arg);
      if ('value' in arg) return String(arg.value);
      if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
      return stringValue(arg.description);
    })
    .join(' ');
}

type ConsoleLevel = 'log' | 'info' | 'warning' | 'error';

function consoleLevel(type: string): ConsoleLevel {
  if (type === 'error') return 'error';
  if (type === 'warning' || type === 'warn') return 'warning';
  if (type === 'info') return 'info';
  return 'log';
}

function scriptKindHint(type: string): DynamicScriptKind | undefined {
  const normalized = type.toLowerCase().replace(/_/g, '-');
  if (normalized === 'shared-worker' || normalized === 'sharedworker') return 'shared-worker';
  if (normalized === 'service-worker' || normalized === 'serviceworker') return 'service-worker';
  if (/worker/i.test(type)) return 'worker';
  return undefined;
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

const STORAGE_DUMP_EXPRESSION = `(() => {
  const dump = (storage) => {
    const out = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key) out[key] = storage.getItem(key) || '';
    }
    return out;
  };
  return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
})()`;

/** IndexedDB 只读枚举（只 open 既有版本 / readonly 事务，不写入）。 */
const INDEXEDDB_DUMP_EXPRESSION = `(async () => {
  try {
    if (!indexedDB || !indexedDB.databases) return [];
    const asPromise = (request) => new Promise((resolve) => {
      try {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch (_error) { resolve(null); }
    });
    const out = [];
    const databases = await indexedDB.databases();
    for (const db of databases) {
      await new Promise((resolveDb) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolveDb(null); } };
        let request;
        try { request = indexedDB.open(db.name); } catch (_error) { done(); return; }
        request.onsuccess = async () => {
          const conn = request.result;
          try {
            const names = Array.from(conn.objectStoreNames || []);
            for (const name of names) {
              await new Promise((resolveStore) => {
                let settledStore = false;
                const doneStore = () => { if (!settledStore) { settledStore = true; resolveStore(null); } };
                let tx;
                try { tx = conn.transaction(name, 'readonly'); } catch (_error) { doneStore(); return; }
                try {
                  const store = tx.objectStore(name);
                  Promise.all([asPromise(store.getAll()), asPromise(store.getAllKeys())]).then((results) => {
                    const values = results[0];
                    const keys = results[1];
                    if (values && keys) {
                      for (let i = 0; i < values.length; i++) {
                        out.push({ database: db.name, objectStore: name, record: { key: keys[i], value: values[i] } });
                      }
                    }
                    doneStore();
                  }, doneStore);
                } catch (_error) { doneStore(); }
              });
            }
          } finally {
            try { conn.close(); } catch (_error) {}
            done();
          }
        };
        request.onerror = () => done();
        request.onupgradeneeded = () => {
          try { if (request.transaction) request.transaction.abort(); } catch (_error) {}
          done();
        };
      });
    }
    return out;
  } catch (_error) { return []; }
})()`;

/** CacheStorage 只读枚举（cache.match 读副本，不消费存储内容）。 */
const CACHE_STORAGE_DUMP_EXPRESSION = `(async () => {
  try {
    if (!caches || !caches.keys) return [];
    const out = [];
    const names = await caches.keys();
    for (const cacheName of names) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      for (const request of requests) {
        let responseB64 = null;
        let status = null;
        let contentType = null;
        try {
          const response = await cache.match(request);
          if (response) {
            status = response.status;
            try { contentType = response.headers.get('content-type'); } catch (_error) {}
            const bytes = new Uint8Array(await response.arrayBuffer());
            let bin = '';
            const step = 0x8000;
            for (let i = 0; i < bytes.length; i += step) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
            }
            responseB64 = btoa(bin);
          }
        } catch (_error) {}
        out.push({
          origin: location.origin,
          cacheName: cacheName,
          requestUrl: request.url,
          status: status,
          contentType: contentType,
          responseB64: responseB64
        });
      }
    }
    return out;
  } catch (_error) { return []; }
})()`;

const ENVIRONMENT_EXPRESSION = `(() => {
  try {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      timezone: (Intl && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
      screen: screen.width + 'x' + screen.height + 'x' + screen.colorDepth
    };
  } catch (_error) { return null; }
})()`;

const OBSERVER_INSTRUMENTATION_SOURCE = internalScriptSource(
  'observer.js',
  OBSERVER_SCRIPT_SOURCE,
);
const STORAGE_DUMP_INSTRUMENTATION_SOURCE = internalScriptSource(
  'storage-dump.js',
  STORAGE_DUMP_EXPRESSION,
);
const INDEXEDDB_DUMP_INSTRUMENTATION_SOURCE = internalScriptSource(
  'indexeddb-dump.js',
  INDEXEDDB_DUMP_EXPRESSION,
);
const CACHE_STORAGE_DUMP_INSTRUMENTATION_SOURCE = internalScriptSource(
  'cache-storage-dump.js',
  CACHE_STORAGE_DUMP_EXPRESSION,
);
const ENVIRONMENT_INSTRUMENTATION_SOURCE = internalScriptSource(
  'environment.js',
  ENVIRONMENT_EXPRESSION,
);
const DOM_SNAPSHOT_INSTRUMENTATION_SOURCE = internalScriptSource(
  'dom-snapshot.js',
  'document.documentElement ? document.documentElement.outerHTML : ""',
);

async function awaitWithTimeout<T>(value: Promise<T> | T, timeoutMs: number, message: string): Promise<T> {
  if (value == null || typeof (value as Promise<T>).then !== 'function') {
    return value as T;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function attachProtocolAgnosticCapture(
  input: AttachProtocolAgnosticCaptureInput,
): Promise<AttachedCapture> {
  const sessionTargets = new Map<string, { targetId: string; type: string }>();
  const targetRows = new Map<string, PackV2TargetRow>();
  // 主框架导航事实（内存态，数量小；派生引擎与 Viewer 识别只读快照）
  const mainFrameNavigations: Array<{ occurredAt: string; targetId: string; url: string | null }> = [];
  const requestChains = new Map<string, string[]>();
  const ignored = new Set<string>();
  // Worker 跨 session 事务关联（0.2.10 唯一匹配别名机制的 0.3 重建）：入口脚本由页面 loader 发起（requestWillBeSent 落根会话），Worker
  // target 建立后其完成事件改在 Worker session 上报——按 scopedId 严格查找必然
  // miss。仅当 Worker target URL 与恰好一个在途父请求 URL 匹配时建立
  // `workerSession::requestId → 父 baseId` 别名；非唯一匹配不建（宁可漏不可错）。
  const workerSessions = new Map<string, { url: string }>();
  const workerRequestAliases = new Map<string, string>();
  const workerSessionBaseIds = new Map<string, Set<string>>();
  // baseId → 原始 CDP requestId（入口脚本补读要在 Worker session 上用父请求的
  // 原始 requestId 调 Network.getResponseBody）
  const hopRequestIds = new Map<string, string>();
  // URL 为空期间已有完成事件按未命中显式丢弃的 Worker session：
  // URL 经 targetInfoChanged 补齐后对这些 session 触发入口脚本补读
  const salvagePendingWorkerSessions = new Set<string>();
  // 已合并 responseReceivedExtraInfo 的 hop：loadingFinished 时据此决定是否延迟提交
  const responseExtraInfoHops = new Set<string>();
  // loadingFinished 已处理、在 extraInfo 提交宽限中的延迟提交计时器
  // （drain 收尾要等它们触发后再置 closed）
  const pendingFinishCommits = new Map<string, ReturnType<typeof setTimeout>>();
  let eventQueue = Promise.resolve();
  let sourceQueue = Promise.resolve();
  let phase: 'live' | 'drain' | 'closed' = 'live';
  let ready = false;
  let navigationSeen = false;

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function enqueueEvent(work: () => Promise<void>, method?: string): void {
    if (phase === 'closed') {
      // 丢弃必须记账（规范 §3：没有记账的静默丢弃等于编造「没有发生过」）
      if (method) {
        input.evidence.droppedEvent(method, new Error('closed 阶段丢弃事件（收尾后不再落盘）'));
      }
      return;
    }
    if (phase === 'drain' && method && !DRAIN_METHODS.has(method)) {
      input.evidence.droppedEvent(method, new Error('drain 阶段丢弃事件（收尾中不落盘）'));
      return;
    }
    const run = async () => {
      try {
        await work();
      } catch (error) {
        // 事件链失败显式记账：不吞、不中断后续事件
        input.evidence.droppedEvent(method ?? 'unknown', error);
      }
    };
    eventQueue = eventQueue.then(run, run);
  }

  function enqueueSourceFetch(work: () => Promise<void>): void {
    if (phase === 'closed') {
      // drain 循环会等 sourceQueue 稳定后才置 closed，正常不可达；
      // 万一到达（收尾后补读源码），丢弃与 enqueueEvent 同纪律显式记账
      input.evidence.droppedEvent('source-fetch', new Error('closed 阶段丢弃源码补读（收尾后不再落盘）'));
      return;
    }
    const run = async () => {
      try {
        await work();
      } catch (error) {
        input.evidence.droppedEvent('source-fetch', error);
      }
    };
    sourceQueue = sourceQueue.then(run, run);
  }

  function targetIdOf(sessionId?: string): string {
    if (sessionId && sessionTargets.has(sessionId)) return sessionTargets.get(sessionId)!.targetId;
    return input.rootTargetId;
  }

  function targetTypeOf(sessionId?: string): string {
    if (sessionId && sessionTargets.has(sessionId)) return sessionTargets.get(sessionId)!.type;
    return 'page';
  }

  function upsertTargetRow(row: PackV2TargetRow): void {
    const known = targetRows.get(row.id);
    if (known) {
      targetRows.set(row.id, { ...known, ...row, url: row.url ?? known.url });
    } else {
      targetRows.set(row.id, row);
    }
  }

  /**
   * 子 Target 各域 enable：失败逐域记 targetAttachFailures 缺口
   * （该 Target 对应采集面缺失，完整度引擎按缺口映射 INCOMPLETE 原因）。
   */
  async function enableDomains(sessionId: string, targetType: string, targetId: string): Promise<void> {
    const record = (command: string, error: unknown) => {
      input.evidence.recordGap('targetAttachFailures', targetId, `${command} 失败：${errorMessage(error)}`);
    };
    try {
      await awaitWithTimeout(loggedSend('Runtime.enable', {}, sessionId), OPTIONAL_CDP_TIMEOUT_MS, 'Runtime.enable timed out');
    } catch (error) {
      record('Runtime.enable', error);
    }
    try {
      await awaitWithTimeout(loggedSend('Debugger.enable', {}, sessionId), OPTIONAL_CDP_TIMEOUT_MS, 'Debugger.enable timed out');
    } catch (error) {
      record('Debugger.enable', error);
    }
    try {
      await awaitWithTimeout(
        loggedSend('Runtime.addBinding', { name: OBSERVER_BINDING_NAME }, sessionId),
        OPTIONAL_CDP_TIMEOUT_MS,
        'Runtime.addBinding timed out',
      );
    } catch (error) {
      record('Runtime.addBinding', error);
    }
    if (scriptKindHint(targetType)) return;
    try {
      await awaitWithTimeout(loggedSend('Page.enable', {}, sessionId), OPTIONAL_CDP_TIMEOUT_MS, 'Page.enable timed out');
      await awaitWithTimeout(
        loggedSend(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: OBSERVER_INSTRUMENTATION_SOURCE },
          sessionId,
        ),
        OPTIONAL_CDP_TIMEOUT_MS,
        'Page.addScriptToEvaluateOnNewDocument timed out',
      );
    } catch (error) {
      record('Page.addScriptToEvaluateOnNewDocument', error);
    }
  }

  /** 向当前文档 / Worker 注入观察脚本（Worker 也注入，修复 Worker 无观察器）。 */
  async function installObserver(sessionId?: string): Promise<void> {
    await awaitWithTimeout(
      loggedSend(
        'Runtime.evaluate',
        { expression: OBSERVER_INSTRUMENTATION_SOURCE, returnByValue: true },
        sessionId,
      ),
      OPTIONAL_CDP_TIMEOUT_MS,
      '观察脚本注入 timed out',
    );
  }

  async function loggedSend(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    const timestamp = input.now();
    try {
      const result = await sendCdpCommand(input.cdp, command, params, sessionId);
      await input.journal.recordCommand({
        timestamp,
        method: command,
        sessionId,
        targetId: targetIdOf(sessionId),
        params,
        result: isRecord(result) ? result : undefined,
      });
      return result;
    } catch (error) {
      // 捕获 CDP 命令失败：目标已 detach、域未 enable 或 Electron 拒绝空 sessionId
      // 策略：命令仍写入 journal.error，再抛给调用方决定是否继续
      await input.journal.recordCommand({
        timestamp,
        method: command,
        sessionId,
        targetId: targetIdOf(sessionId),
        params,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  function hopIds(baseId: string): string[] {
    const existing = requestChains.get(baseId);
    if (existing) return existing;
    const created: string[] = [];
    requestChains.set(baseId, created);
    return created;
  }

  function activeHopId(baseId: string): string {
    const ids = hopIds(baseId);
    return ids[ids.length - 1] || baseId;
  }

  function isWorkerTargetType(type: string): boolean {
    return scriptKindHint(type) !== undefined;
  }

  /** Worker 入口脚本 URL 匹配：全等，或 origin+pathname 相等（query 差异不参与匹配；多候选由调用方按「不建别名」兜底）。 */
  function workerScriptUrlsMatch(left: string, right: string): boolean {
    if (!left || !right) return false;
    if (left === right) return true;
    let leftIdentity: string | null = null;
    let rightIdentity: string | null = null;
    try {
      leftIdentity = `${new URL(left).origin}${new URL(left).pathname}`;
      rightIdentity = `${new URL(right).origin}${new URL(right).pathname}`;
    } catch {
      return false;
    }
    return leftIdentity === rightIdentity;
  }

  /** hop id → 链首 baseId（剥掉 `::redirect-N` 后缀；sessionId 自身的 `::` 不受影响）。 */
  function baseIdOfHopId(hopId: string): string {
    return hopId.replace(/::redirect-\d+$/, '');
  }

  /** Worker target URL 唯一匹配的在途父请求 baseId；无匹配或多匹配返回 null（不建别名）。 */
  function uniqueParentBaseIdForWorkerUrl(targetUrl: string): string | null {
    if (!targetUrl) return null;
    const matches = input.http
      .inFlightHops()
      .filter(hop => workerScriptUrlsMatch(hop.url, targetUrl));
    if (matches.length !== 1) return null;
    return baseIdOfHopId(matches[0].id);
  }

  /**
   * Worker 入口脚本正文补读（0.2.10 salvageWorkerMainScript 的 0.3 重建）。
   * 入口脚本由页面 loader 发起（requestWillBeSent 落父会话），完成事件改在
   * Worker session 上报；Worker URL 迟到期间到达的完成事件已按未命中显式
   * 丢弃（不可重放）——URL 补齐后经 Worker session 主动补读正文
   * （getResponseBody 只在加载该脚本的 Worker session 上可见），成功即收尾
   * 事务。无候选/多候选/行已 commit 时放弃补读（宁可漏不可错），缺正文由
   * flush 按未完成显式记账。
   */
  async function salvageWorkerEntryScript(workerSessionId: string, targetUrl: string): Promise<void> {
    const parentBaseId = uniqueParentBaseIdForWorkerUrl(targetUrl);
    if (!parentBaseId) return;
    const requestId = hopRequestIds.get(parentBaseId);
    if (!requestId) return;
    // 别名同步登记：补读后仍在途的行可继续吃后续 Worker session 完成事件
    // （extraInfo 等），detach 强制收尾也能经 workerSessionBaseIds 命中
    workerRequestAliases.set(scopedId(requestId, workerSessionId), parentBaseId);
    const known = workerSessionBaseIds.get(workerSessionId) ?? new Set<string>();
    known.add(parentBaseId);
    workerSessionBaseIds.set(workerSessionId, known);
    const id = activeHopId(parentBaseId);
    if (!input.http.has(id)) return;
    try {
      const stored = await storeResponseBody(id, requestId, workerSessionId);
      if (!stored) {
        // 行已 commit（跨附件交错收尾窗口）：正文已取出但无法再关联——显式记账
        input.evidence.recordGap('missingBodies', id, 'Worker 入口脚本正文晚于 commit 到达，未落进行（行已落盘）');
        return;
      }
      await input.http.commit(id);
    } catch (error) {
      // Worker session 正文不可读（未就绪/生命周期限制）：不重试不伪造，
      // 行保持未完成，缺正文由 flush 按未完成显式记账（0.2.10 markFailure=false 语义）
      void error;
    }
  }

  /**
   * Network 事件的事务 baseId 解析：scopedId 命中即用；Worker session 事件未
   * 命中时按唯一 URL 匹配回退到父会话 baseId。drain 期
   * requestWillBeSent 已被丢弃，未观测过的新请求不得凭 URL 唯一性建别名
   * （宁漏不错）——drain 期只对父会话已跟踪的 requestId（完成事件改在
   * Worker session 上报的分裂形态）回退关联，新事件按未命中显式记账。
   */
  function resolveNetworkBaseId(requestId: string, eventSessionId?: string): string {
    const scoped = scopedId(requestId, eventSessionId);
    if (requestChains.has(scoped) || ignored.has(scoped)) return scoped;
    if (eventSessionId && workerSessions.has(eventSessionId)) {
      const aliased = workerRequestAliases.get(scoped);
      if (aliased && requestChains.has(aliased)) return aliased;
      // drain 期 requestWillBeSent 已被丢弃：未观测过的新请求不得凭 URL 唯一性
      // 建别名（宁漏不错）——只有父会话观测到 requestWillBeSent 的 requestId
      // （链非空；完成事件先到只会建出空链，不构成已跟踪证据）才允许 URL 回退关联
      const parentChain = requestChains.get(requestId);
      const drainTrusted = phase !== 'drain' || (parentChain !== undefined && parentChain.length > 0);
      if (drainTrusted) {
        const parentBaseId = uniqueParentBaseIdForWorkerUrl(workerSessions.get(eventSessionId)!.url);
        if (parentBaseId && requestChains.has(parentBaseId)) {
          workerRequestAliases.set(scoped, parentBaseId);
          const known = workerSessionBaseIds.get(eventSessionId) ?? new Set<string>();
          known.add(parentBaseId);
          workerSessionBaseIds.set(eventSessionId, known);
          return parentBaseId;
        }
      }
      if (!workerSessions.get(eventSessionId)!.url) {
        // Worker URL 迟到：URL 为空时无法按 URL 建别名，本事件将按
        // 未命中由调用方显式丢弃——记下该 session 有不可重放的丢弃，URL 经
        // targetInfoChanged 补齐后触发入口脚本补读挽回正文
        salvagePendingWorkerSessions.add(eventSessionId);
      }
    }
    return scoped;
  }

  async function storeRequestBody(hopId: string, requestId: string, sessionId?: string): Promise<void> {
    const result = await loggedSend('Network.getRequestPostData', { requestId }, sessionId);
    const postData = isRecord(result) ? stringValue(result.postData) : '';
    if (!postData) return;
    const ref = await input.http.storeBody(Buffer.from(postData, 'utf8'));
    if (!input.http.patchHop(hopId, { requestBody: ref })) {
      // 行已 commit（跨附件 detach 强制收尾的交错窗口）：正文已取出但无法再
      // 关联——显式记账，不得无痕丢弃
      input.evidence.recordGap('missingBodies', hopId, '请求正文晚于 commit 到达，未落进行（行已落盘）');
    }
  }

  /**
   * 取响应正文并挂到事务行。false = 行已 commit（detach 强制收尾 / flush 等），
   * 正文已取出但无法再关联——由调用方显式记账，不得无痕丢弃。
   */
  async function storeResponseBody(hopId: string, requestId: string, sessionId?: string): Promise<boolean> {
    const result = await loggedSend('Network.getResponseBody', { requestId }, sessionId);
    const bytes = decodeCdpBody(result);
    const ref = await input.http.storeBody(bytes);
    return input.http.patchHop(hopId, { responseBody: ref });
  }

  async function enableAttachedTarget(attachedSessionId: string, targetType: string): Promise<void> {
    const targetId = targetIdOf(attachedSessionId);
    try {
      await awaitWithTimeout(
        loggedSend('Network.enable', {}, attachedSessionId),
        OPTIONAL_CDP_TIMEOUT_MS,
        'Network.enable timed out',
      );
    } catch (error) {
      // 捕获子 Target Network.enable 失败：Worker/OOPIF 可能不支持 Network 或会话已失效
      // 策略：仍解除 waitForDebugger，避免 Viewer/Worker 永久冻结；缺口显式记账
      input.evidence.recordGap('targetAttachFailures', targetId, `Network.enable 失败：${errorMessage(error)}`);
    }
    await enableDomains(attachedSessionId, targetType, targetId);
    try {
      await loggedSend('Runtime.runIfWaitingForDebugger', {}, attachedSessionId);
    } catch (error) {
      // 捕获目标未处于 waitForDebugger：旧目标或已自行恢复
      // 策略：不阻断主会话采集
      void error;
    }
    try {
      await installObserver(attachedSessionId);
    } catch (error) {
      // Worker 会话没有 Page 注入，Runtime.evaluate 是唯一观察器入口
      input.evidence.recordGap('targetAttachFailures', targetId, `观察脚本注入失败：${errorMessage(error)}`);
    }
  }

  async function captureScreenshot(
    sessionId: string | undefined,
    targetId: string,
    label: string,
  ): Promise<boolean> {
    try {
      const result = await awaitWithTimeout(
        loggedSend('Page.captureScreenshot', { format: 'png' }, sessionId),
        OPTIONAL_CDP_TIMEOUT_MS,
        'Page.captureScreenshot timed out',
      );
      const data = isRecord(result) ? stringValue(result.data) : '';
      if (!data) throw new Error('captureScreenshot 返回空数据（隐藏窗口可能未渲染）');
      await input.browser.addScreenshot(label, Buffer.from(data, 'base64'), {
        targetId,
        occurredAt: input.now(),
      });
      return true;
    } catch (error) {
      // 捕获截图失败：窗口隐藏 / GPU 不可用 / 目标无 Page 域
      // 策略：丢弃计数显式记账，不阻断导航事件链；成败返回给调用方进步骤明细
      input.evidence.droppedEvent('Page.captureScreenshot', error);
      return false;
    }
  }

  async function captureDomSnapshot(
    sessionId: string | undefined,
    targetId: string,
    label: string,
  ): Promise<boolean> {
    try {
      const result = await awaitWithTimeout(
        loggedSend(
          'Runtime.evaluate',
          {
            expression: DOM_SNAPSHOT_INSTRUMENTATION_SOURCE,
            returnByValue: true,
          },
          sessionId,
        ),
        OPTIONAL_CDP_TIMEOUT_MS,
        'DOM 快照 timed out',
      );
      const value =
        isRecord(result) && isRecord(result.result) ? stringValue(result.result.value) : '';
      await input.browser.addDomSnapshot(label, value, { targetId, occurredAt: input.now() });
      return true;
    } catch (error) {
      // 捕获 DOM 快照失败：文档不可访问或目标已导航离开
      // 策略：丢弃计数显式记账，不阻断导航事件链；成败返回给调用方进步骤明细
      input.evidence.droppedEvent('dom-snapshot', error);
      return false;
    }
  }

  async function handleObserverBinding(
    payload: string,
    targetId: string,
    occurredAt: string,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      input.evidence.droppedEvent('Runtime.bindingCalled', error);
      return;
    }
    if (!isRecord(parsed)) {
      input.evidence.droppedEvent(
        'Runtime.bindingCalled',
        new Error(`观察脚本 payload 不是对象：${typeof parsed}`),
      );
      return;
    }
    const kind = stringValue(parsed.kind);
    if (kind === 'crypto') {
      await input.crypto.recordBindingPayload(parsed, targetId, occurredAt);
      return;
    }
    if (kind === 'action') {
      const row: Omit<PackV2BrowserActionRow, 'id'> = {
        occurredAt,
        targetId,
        kind: stringValue(parsed.actionKind) === 'form-submit' ? 'form-submit' : 'click',
        elementSummary: stringValue(parsed.elementSummary) || 'element',
        url: optionalString(parsed.url),
      };
      await input.browser.addAction(row);
      return;
    }
    if (kind === 'render-surface') {
      // §7.3 第 2 组事实：页面观察脚本上报的新建渲染/执行表面
      const surface = renderSurfaceKindOf(parsed.surface);
      if (!surface) {
        input.evidence.droppedEvent(
          'Runtime.bindingCalled',
          new Error(`观察脚本 payload surface 未知：${stringValue(parsed.surface) || '(empty)'}`),
        );
        return;
      }
      const row: Omit<PackV2RenderSurfaceRow, 'id'> = {
        occurredAt,
        targetId,
        surface,
        detail: optionalString(parsed.detail) ?? null,
      };
      await input.browser.addRenderSurface(row);
      return;
    }
    if (kind === 'webrtc' || kind === 'webtransport' || kind === 'sse') {
      await input.realtime.recordObserverEvent(kind, parsed, targetId, occurredAt);
      return;
    }
    if (kind === 'observer-hook-failed') {
      // 观察脚本钩子安装失败：观察面缺失必须显式记账（规范 §3）；
      // 明细（hook/stage）供派生折扣与表面条件缺口映射（阶段 3）。
      input.evidence.recordObserverHookFailure(
        stringValue(parsed.hook) || 'unknown',
        stringValue(parsed.stage) || 'unknown',
        stringValue(parsed.detail) || 'no detail',
      );
      return;
    }
    input.evidence.droppedEvent(
      'Runtime.bindingCalled',
      new Error(`观察脚本 payload kind 未知：${kind || '(empty)'}`),
    );
  }

  async function handleEvent(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<void> {
    await input.journal.recordEvent({
      timestamp: input.now(),
      method,
      sessionId,
      targetId: targetIdOf(sessionId),
      params,
    });

    if (method === 'Target.attachedToTarget') {
      const attachedSessionId = stringValue(params.sessionId);
      const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : {};
      const attachedTargetId = stringValue(targetInfo.targetId) || attachedSessionId;
      const attachedType = stringValue(targetInfo.type) || 'other';
      if (attachedSessionId) {
        sessionTargets.set(attachedSessionId, { targetId: attachedTargetId, type: attachedType });
        if (isWorkerTargetType(attachedType)) {
          workerSessions.set(attachedSessionId, { url: optionalString(targetInfo.url) ?? '' });
        }
        const openerId = optionalString(targetInfo.openerId);
        // flatten=true 时直接子 target 的 attachedToTarget 从根会话上报，
        // Electron message 回调没有第四个 sessionId。这时父节点就是本附件的
        // root target；嵌套子会话则以事件所在 session 为父节点。
        const eventParentTargetId = sessionId ? targetIdOf(sessionId) : input.rootTargetId;
        const parentTargetId =
          eventParentTargetId !== attachedTargetId ? eventParentTargetId : undefined;
        upsertTargetRow({
          id: attachedTargetId,
          type: mapTargetType(attachedType, openerId),
          attached: true,
          url: optionalString(targetInfo.url) ?? null,
          ...(openerId ? { openerTargetId: openerId } : {}),
          ...(parentTargetId ? { parentTargetId } : {}),
          attachedAt: input.now(),
        });
        await enableAttachedTarget(attachedSessionId, attachedType);
      }
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      const detachedSessionId = stringValue(params.sessionId);
      const detachedTargetId = stringValue(params.targetId);
      // Worker 会话消失：别名关联的未完成请求正文不可再读（getResponseBody 需要
      // 该会话），强制收尾在途 hop——不是观察到的失败（loadingFailed 语义），
      // 按未完成收尾：缺正文的 hop 由 commit 记 missingBodies 缺口（204/205/304
      // /redirect 等明确无正文语义除外），逐条显式记账 detach 原因
      const aliasedBaseIds = detachedSessionId ? workerSessionBaseIds.get(detachedSessionId) : undefined;
      if (aliasedBaseIds) {
        const inFlightIds = new Set(input.http.inFlightHops().map(hop => hop.id));
        for (const baseId of aliasedBaseIds) {
          const id = activeHopId(baseId);
          if (!inFlightIds.has(id)) continue;
          input.evidence.droppedEvent(
            'Target.detachedFromTarget',
            new Error(`Worker session detach，别名在途请求强制收尾：${id}`),
          );
          try {
            await input.http.commit(id);
          } catch (error) {
            // commit 写盘失败已由 commit 记 journalWriteFailures 并 rethrow；
            // 此处按 hop 隔离：单个失败不得中断其余 hop 收尾，也不得跳过
            // 下方的别名/会话清理（残留别名会让死会话继续命中）
            input.evidence.droppedEvent(
              'Target.detachedFromTarget',
              new Error(`detach 强制收尾 commit 失败：${id}：${errorMessage(error)}`),
            );
          }
        }
      }
      if (detachedSessionId) {
        workerSessions.delete(detachedSessionId);
        workerSessionBaseIds.delete(detachedSessionId);
        for (const scoped of [...workerRequestAliases.keys()]) {
          if (scoped.startsWith(`${detachedSessionId}::`)) workerRequestAliases.delete(scoped);
        }
      }
      if (detachedSessionId && sessionTargets.has(detachedSessionId)) {
        sessionTargets.delete(detachedSessionId);
      }
      if (detachedTargetId && targetRows.has(detachedTargetId)) {
        const known = targetRows.get(detachedTargetId)!;
        targetRows.set(detachedTargetId, { ...known, attached: false, detachReason: 'detached' });
      }
      return;
    }

    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : {};
      const targetId = stringValue(targetInfo.targetId);
      if (targetId) {
        const openerId = optionalString(targetInfo.openerId);
        const known = targetRows.get(targetId);
        const targetUrl = optionalString(targetInfo.url) ?? null;
        upsertTargetRow({
          id: targetId,
          type: mapTargetType(stringValue(targetInfo.type) || 'other', openerId),
          attached: known?.attached ?? targetInfo.attached === true,
          url: targetUrl,
          ...(openerId ? { openerTargetId: openerId } : {}),
          ...(known?.parentTargetId ? { parentTargetId: known.parentTargetId } : {}),
          ...(known?.attachedAt ? { attachedAt: known.attachedAt } : {}),
          ...(known?.detachReason ? { detachReason: known.detachReason } : {}),
        });
        if (targetUrl) {
          // Worker URL 迟到补齐：attach 时 targetInfo.url 可能为空，
          // workerSessions 里记的还是空 URL——URL 到达时补写；若该 session 在
          // URL 为空期间已有完成事件按未命中显式丢弃，立即补读入口脚本正文
          for (const [workerSessionId, session] of sessionTargets) {
            if (session.targetId !== targetId || !isWorkerTargetType(session.type)) continue;
            const workerSession = workerSessions.get(workerSessionId);
            if (!workerSession || workerSession.url) continue;
            workerSessions.set(workerSessionId, { url: targetUrl });
            if (salvagePendingWorkerSessions.has(workerSessionId)) {
              salvagePendingWorkerSessions.delete(workerSessionId);
              await salvageWorkerEntryScript(workerSessionId, targetUrl);
            }
          }
        }
      }
      return;
    }

    if (method === 'Target.targetDestroyed') {
      const targetId = stringValue(params.targetId);
      if (targetId && targetRows.has(targetId)) {
        const known = targetRows.get(targetId)!;
        targetRows.set(targetId, {
          ...known,
          attached: false,
          detachReason: known.detachReason ?? 'destroyed',
        });
      }
      return;
    }

    if (method === 'Runtime.bindingCalled') {
      if (stringValue(params.name) !== OBSERVER_BINDING_NAME) return;
      await handleObserverBinding(
        stringValue(params.payload),
        targetIdOf(sessionId),
        input.now(),
      );
      return;
    }

    if (method === 'Debugger.scriptParsed') {
      const scriptId = stringValue(params.scriptId);
      if (!scriptId) return;
      const url = stringValue(params.url);
      // 采集器通过 Runtime.evaluate / Page.addScriptToEvaluateOnNewDocument
      // 执行的探针不是目标站点证据，不进入 scripts 索引与完整度门禁。
      // 原始 scriptParsed 事件仍已写入 CDP journal，可离线审计。
      if (url.startsWith(INTERNAL_SCRIPT_URL_PREFIX)) return;
      const targetId = targetIdOf(sessionId);
      const kindHint = scriptKindHint(targetTypeOf(sessionId));
      const sourceMapURL = optionalString(params.sourceMapURL);
      const scriptLanguage = stringValue(params.scriptLanguage);
      const lengthBytes = optionalNumber(params.length);
      const contentHash = optionalString(params.hash);
      const fetchSessionId = sessionId;
      // getScriptSource 走独立队列，避免挡住 Target.attachedToTarget / Network.enable
      enqueueSourceFetch(async () => {
        let source = '';
        let sourceBytes: Buffer | undefined;
        let fetchFailed = false;
        try {
          const result = await awaitWithTimeout(
            loggedSend('Debugger.getScriptSource', { scriptId }, fetchSessionId),
            SCRIPT_SOURCE_TIMEOUT_MS,
            `Debugger.getScriptSource timed out for ${scriptId}`,
          );
          if (isRecord(result)) {
            source = stringValue(result.scriptSource);
            const bytecode = stringValue(result.bytecode);
            if (!source && bytecode) sourceBytes = Buffer.from(bytecode, 'base64');
          }
        } catch (error) {
          // 捕获 getScriptSource 失败：WASM、已回收脚本（导航/文档销毁竞态，
          // Chromium 侧丢弃，不可重读）或子会话未 enable Debugger
          // 策略：观察尝试失败按 §3 显式记账；ScriptCollector 只有在
          // 另一文档已成功留存完全相同的 CDP hash 正文时才补全，否则任意
          // kind 都形成源码完整度缺口，不用 0 字节 BodyRef 冒充。
          fetchFailed = true;
          input.evidence.droppedEvent('Debugger.getScriptSource', error);
        }
        await input.scripts.addParsed({
          scriptId,
          url,
          targetId,
          sourceMapURL,
          source,
          sourceBytes,
          isWasm:
            scriptLanguage === 'WebAssembly' ||
            Boolean(sourceBytes) ||
            /\.wasm(?:[?#]|$)/i.test(url),
          kindHint,
          ...(fetchFailed ? { fetchFailed } : {}),
          ...(lengthBytes !== undefined ? { lengthBytes } : {}),
          ...(contentHash ? { contentHash } : {}),
        });
      });
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      await input.browser.addConsole({
        occurredAt: input.now(),
        targetId: targetIdOf(sessionId),
        level: consoleLevel(stringValue(params.type)),
        text: consoleText(params.args),
      });
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
      const exception = isRecord(details.exception) ? details.exception : {};
      await input.browser.addConsole({
        occurredAt: input.now(),
        targetId: targetIdOf(sessionId),
        level: 'error',
        text: stringValue(details.text) || stringValue(exception.description) || 'uncaught exception',
      });
      return;
    }

    if (method === 'Log.entryAdded') {
      const entry = isRecord(params.entry) ? params.entry : {};
      await input.browser.addConsole({
        occurredAt: input.now(),
        targetId: targetIdOf(sessionId),
        level: consoleLevel(stringValue(entry.level)),
        text: stringValue(entry.text) || stringValue(entry.url) || 'log entry',
      });
      return;
    }

    if (method === 'Page.frameNavigated') {
      const frame = isRecord(params.frame) ? params.frame : {};
      await input.browser.addTimeline({
        occurredAt: input.now(),
        kind: 'navigation',
        targetId: targetIdOf(sessionId),
        url: optionalString(frame.url),
      });
      const isMainFrame = !frame.parentId;
      if (isMainFrame) {
        mainFrameNavigations.push({
          occurredAt: input.now(),
          targetId: targetIdOf(sessionId),
          url: optionalString(frame.url) ?? null,
        });
        // 主框架导航点：截图 + DOM 快照（规范 §8.4）
        const label = optionalString(frame.url) || 'navigation';
        await captureScreenshot(sessionId, targetIdOf(sessionId), label);
        await captureDomSnapshot(sessionId, targetIdOf(sessionId), label);
      }
      return;
    }

    if (method === 'Page.navigatedWithinDocument') {
      await input.browser.addTimeline({
        occurredAt: input.now(),
        kind: 'hash-change',
        targetId: targetIdOf(sessionId),
        url: optionalString(params.url),
      });
      return;
    }

    if (method === 'Browser.downloadWillBegin') {
      const guid = stringValue(params.guid);
      if (!guid) return;
      await input.realtime.recordDownloadStart({
        id: guid,
        url: stringValue(params.url),
        targetId: targetIdOf(sessionId),
        occurredAt: input.now(),
        suggestedFileName: optionalString(params.suggestedFilename),
      });
      return;
    }

    if (method === 'Browser.downloadProgress') {
      const guid = stringValue(params.guid);
      if (!guid) return;
      const state = stringValue(params.state);
      const completed = state === 'Completed';
      await input.realtime.patchDownload(guid, {
        completed,
        occurredAt: input.now(),
      });
      if (completed) {
        // 下载内容未接管（改变下载路径属于生产接线，规范 §8.5 浏览器外通道显式缺口）
        input.evidence.recordGap(
          'unsupportedChannels',
          guid,
          '下载文件内容未采集（未接管下载重定向）',
        );
      }
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const request = isRecord(params.request) ? params.request : {};
      const requestId = stringValue(params.requestId);
      const baseId = scopedId(requestId, sessionId);
      const url = stringValue(request.url);
      if (/^(?:data|blob):/i.test(url)) {
        ignored.add(baseId);
        return;
      }
      const chain = hopIds(baseId);
      // 原始 requestId 留存：Worker 入口脚本补读要在 Worker session
      // 上用父请求的原始 requestId 调 Network.getResponseBody
      hopRequestIds.set(baseId, requestId);
      const redirectResponse = isRecord(params.redirectResponse) ? params.redirectResponse : null;
      const redirectedFromId = redirectResponse ? chain[chain.length - 1] : undefined;
      if (redirectResponse && redirectedFromId) {
        const nextId = `${baseId}::redirect-${chain.length}`;
        const patched = input.http.patchHop(redirectedFromId, {
          status: numberValue(redirectResponse.status),
          responseHeaders: headersValue(redirectResponse.headers),
          redirectToId: nextId,
        });
        if (!patched) {
          // 前跳已 commit（detach 强制收尾 / loadingFailed 等）：302 状态/头/
          // redirectToId 无法落盘，显式记账（无记账的静默丢弃等于编造「没有
          // 发生过」，规范 §3）
          input.evidence.droppedEvent(
            method,
            new Error(`redirectResponse 晚于 commit，状态/头/redirectToId 未落盘：${redirectedFromId}`),
          );
        }
        await input.http.commit(redirectedFromId);
      }
      const id = chain.length === 0 ? baseId : `${baseId}::redirect-${chain.length}`;
      chain.push(id);
      const requestHeaders = headersValue(request.headers);
      input.http.openHop({
        id,
        targetId: targetIdOf(sessionId),
        windowId: input.windowId,
        frameId: optionalString(params.frameId),
        startedAt: input.now(),
        method: stringValue(request.method) || 'GET',
        url,
        resourceType: stringValue(params.type) || 'other',
        requestHeaders,
        initiator: mapInitiator(params.initiator),
        referer: headerValue(requestHeaders, 'referer'),
        redirectFromId: redirectedFromId,
      });
      const inlinePostData = stringValue(request.postData);
      if (inlinePostData) {
        const ref = await input.http.storeBody(Buffer.from(inlinePostData, 'utf8'));
        if (!input.http.patchHop(id, { requestBody: ref })) {
          // 行已 commit（storeBody 落盘期间跨附件交错收尾）：正文已取出但无法
          // 再关联——显式记账，不得无痕丢弃
          input.evidence.recordGap('missingBodies', id, '请求正文晚于 commit 到达，未落进行（行已落盘）');
        }
      } else if (request.hasPostData === true) {
        try {
          await storeRequestBody(id, requestId, sessionId);
        } catch (error) {
          // 捕获 POST 正文不可读取：CDP 仅声明 hasPostData
          // 策略：事务仍提交，缺正文由 commit 记 missingBodies 缺口
          input.evidence.recordGap('missingBodies', id, `请求正文不可读取：${errorMessage(error)}`);
        }
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = stringValue(params.requestId);
      const baseId = resolveNetworkBaseId(requestId, sessionId);
      if (ignored.has(baseId)) return;
      const id = activeHopId(baseId);
      if (!input.http.has(id)) {
        // 未命中必须显式记账（无记账的静默丢弃等于编造「没有发生过」，规范 §3）
        input.evidence.droppedEvent(method, new Error(`responseReceived 缺少对应 hop：${id}`));
        return;
      }
      const response = isRecord(params.response) ? params.response : {};
      const headers = headersValue(response.headers);
      const timingRaw = isRecord(response.timing) ? response.timing : null;
      const patched = input.http.patchHop(id, {
        status: numberValue(response.status),
        contentEncoding: headerValue(headers, 'content-encoding') ?? null,
        connectionId:
          optionalString(response.connectionId) ??
          (response.connectionId == null ? undefined : String(response.connectionId)),
        remoteIpAddress: optionalString(response.remoteIPAddress),
        remotePort: optionalNumber(response.remotePort),
        timing: timingRaw
          ? {
              sendMs: Math.max(0, numberValue(timingRaw.sendEnd) - numberValue(timingRaw.sendStart)),
              waitMs: Math.max(0, numberValue(timingRaw.receiveHeadersEnd) - numberValue(timingRaw.sendEnd)),
              receiveMs: Math.max(0, numberValue(timingRaw.receiveHeadersEnd)),
            }
          : undefined,
      });
      if (!patched) {
        // hop 已提交（redirect 链 / detach 强制收尾）：状态与头都无法再落盘，
        // 显式记账（无记账的静默丢弃等于编造「没有发生过」，规范 §3）
        input.evidence.droppedEvent(method, new Error(`responseReceived 晚于 commit，状态/头未落盘：${id}`));
        return;
      }
      // Chromium 事件序：responseReceivedExtraInfo 先于 responseReceived 到达，
      // Set-Cookie 只在 extraInfo 里——合并而非整包替换，extraInfo 已有的键不得丢失
      if (!input.http.mergeHopHeaders(id, { responseHeaders: headers })) {
        input.evidence.droppedEvent(
          method,
          new Error(`responseReceived 晚于 commit，头未合并：${id}`),
        );
      }
      return;
    }

    if (method === 'Network.requestWillBeSentExtraInfo' || method === 'Network.responseReceivedExtraInfo') {
      // Chromium 对 fetch/XHR 把 Cookie / Set-Cookie 头放在 extraInfo 事件里
      // （responseReceived.headers 缺失），必须合并进事务行，登录传播才可观察。
      const requestId = stringValue(params.requestId);
      const baseId = resolveNetworkBaseId(requestId, sessionId);
      if (ignored.has(baseId)) return;
      const id = activeHopId(baseId);
      if (!input.http.has(id)) {
        // CDP 不保证 extraInfo 与 requestWillBeSent 的先后；错过的头显式记账
        input.evidence.droppedEvent(method, new Error(`extraInfo 缺少对应 hop：${id}`));
        return;
      }
      const headers = headersValue(params.headers);
      const merged = input.http.mergeHopHeaders(
        id,
        method === 'Network.requestWillBeSentExtraInfo' ? { requestHeaders: headers } : { responseHeaders: headers },
      );
      if (!merged) {
        // hop 已提交（redirect 链在下一跳前 commit / extraInfo 提交宽限已过）：
        // journal 只追加，不改写已落盘行
        input.evidence.droppedEvent(method, new Error(`extraInfo 到达晚于 commit，头未合并：${id}`));
        return;
      }
      if (method === 'Network.responseReceivedExtraInfo') {
        responseExtraInfoHops.add(id);
        const timer = pendingFinishCommits.get(id);
        if (timer) {
          // extraInfo 在提交宽限内到达（晚于 loadingFinished 的竞态序）：头已合并，
          // 取消宽限计时器立即提交
          pendingFinishCommits.delete(id);
          clearTimeout(timer);
          await input.http.commit(id);
        }
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = stringValue(params.requestId);
      const baseId = resolveNetworkBaseId(requestId, sessionId);
      if (ignored.has(baseId)) return;
      const id = activeHopId(baseId);
      if (!input.http.has(id)) {
        input.evidence.droppedEvent(method, new Error(`loadingFinished 缺少对应 hop：${id}`));
        return;
      }
      let stored = true;
      try {
        stored = await storeResponseBody(id, requestId, sessionId);
      } catch (error) {
        // 捕获响应体不可读取：缓存命中、重定向、流式资源或 CDP 生命周期限制
        // 读失败的事实按 droppedEvent 显式记账；缺正文是否构成缺口由 commit
        // 单点判定（204/205/304/redirect 是明确无正文语义，不作证缺失，
        // 不在 commit 之外重复记 missingBodies）
        input.evidence.droppedEvent(
          'Network.getResponseBody',
          new Error(`响应正文不可读取：${errorMessage(error)}（${id}）`),
        );
      }
      if (!stored) {
        // 正文已取出，但事务行在取正文期间已 commit（detach 强制收尾 / flush）：
        // 字节在 BodyStore 里但行已落盘、无法再关联——显式记账，不得无痕丢弃
        input.evidence.recordGap('missingBodies', id, '响应正文晚于 commit 到达，未落进行（行已落盘）');
      }
      if (responseExtraInfoHops.has(id)) {
        await input.http.commit(id);
        return;
      }
      // Chromium 不保证 responseReceivedExtraInfo 先于 loadingFinished 到达
      // （e2e 实测可晚数毫秒，Set-Cookie 只在该事件里）：延迟提交，宽限内到达
      // 即合并提交；计时到点自行提交，晚于宽限到达的头按 droppedEvent 显式记账
      const timer = setTimeout(() => {
        pendingFinishCommits.delete(id);
        void input.http.commit(id).catch(error => {
          input.evidence.droppedEvent(
            'Network.loadingFinished',
            new Error(`延迟提交失败：${errorMessage(error)}（${id}）`),
          );
        });
      }, RESPONSE_EXTRA_INFO_COMMIT_GRACE_MS);
      pendingFinishCommits.set(id, timer);
      return;
    }

    if (method === 'Network.loadingFailed') {
      const baseId = resolveNetworkBaseId(stringValue(params.requestId), sessionId);
      if (ignored.has(baseId)) return;
      const id = activeHopId(baseId);
      if (!input.http.has(id)) {
        input.evidence.droppedEvent(method, new Error(`loadingFailed 缺少对应 hop：${id}`));
        return;
      }
      await input.http.commit(id, 'failed');
      return;
    }

    if (method === 'Network.webSocketCreated') {
      const requestId = stringValue(params.requestId);
      input.webSockets.open({
        channelId: socketChannelId(requestId, sessionId),
        url: stringValue(params.url),
        targetId: targetIdOf(sessionId),
        createdAt: input.now(),
      });
      return;
    }

    if (method === 'Network.webSocketWillSendHandshakeRequest') {
      const request = isRecord(params.request) ? params.request : {};
      input.webSockets.handshakeRequest(
        socketChannelId(stringValue(params.requestId), sessionId),
        headersValue(request.headers),
      );
      return;
    }

    if (method === 'Network.webSocketHandshakeResponseReceived') {
      const response = isRecord(params.response) ? params.response : {};
      input.webSockets.handshakeResponse(
        socketChannelId(stringValue(params.requestId), sessionId),
        numberValue(response.status) || 101,
        headersValue(response.headers),
      );
      return;
    }

    if (method === 'Network.webSocketClosed') {
      await input.webSockets.close(socketChannelId(stringValue(params.requestId), sessionId), input.now());
      return;
    }

    if (method === 'Network.webSocketFrameError') {
      input.evidence.recordGap(
        'channelGaps',
        socketChannelId(stringValue(params.requestId), sessionId),
        `WebSocket 帧错误：${stringValue(params.errorMessage) || 'unknown'}`,
      );
      return;
    }

    if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
      const response = isRecord(params.response) ? params.response : {};
      const opcode = wsOpcode(numberValue(response.opcode));
      // FIN 由采集器后视推导（下一帧是否 continuation），此处不伪造
      await input.webSockets.addFrame(socketChannelId(stringValue(params.requestId), sessionId), {
        direction: method === 'Network.webSocketFrameSent' ? 'up' : 'down',
        opcode,
        timestamp: input.now(),
        payload: decodeFramePayload(opcode, stringValue(response.payloadData)),
      });
      return;
    }
  }

  const onCdpMessage = (
    _event: unknown,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => {
    // 「首个导航前就绪」按事件到达时刻判定（排队处理可能晚于 ready 置位）
    if (method === 'Page.frameNavigated' && !ready) navigationSeen = true;
    enqueueEvent(() => handleEvent(method, params, sessionId), method);
  };
  input.cdp.on('message', onCdpMessage);

  try {
    if (!(typeof input.cdp.isAttached === 'function' && input.cdp.isAttached())) {
      await input.cdp.attach('1.3');
    }
    await awaitWithTimeout(
      loggedSend('Network.enable', {}),
      input.networkEnableTimeoutMs ?? DEFAULT_NETWORK_ENABLE_TIMEOUT_MS,
      'Network.enable timed out before the renderer committed a document',
    );
    try {
      await loggedSend('Network.setCacheDisabled', { cacheDisabled: true });
    } catch (error) {
      // 捕获禁用缓存失败：规范 §7.1 要求禁用；失败记账但不阻断
      input.evidence.droppedEvent('Network.setCacheDisabled', error);
    }
    try {
      await loggedSend('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    } catch (error) {
      // 捕获旧 Chromium 不支持 Target.setAutoAttach
      // 策略：主会话 Network 采集继续，子 Target 缺口显式记账
      input.evidence.recordGap(
        'targetAttachFailures',
        input.rootTargetId,
        `Target.setAutoAttach 失败（子 Target 可能漏挂）：${errorMessage(error)}`,
      );
    }
    await loggedSend('Runtime.enable', {});
    await loggedSend('Debugger.enable', {});
    await loggedSend('Runtime.addBinding', { name: OBSERVER_BINDING_NAME });
    await loggedSend('Page.enable', {});
    await loggedSend('Page.addScriptToEvaluateOnNewDocument', {
      source: OBSERVER_INSTRUMENTATION_SOURCE,
    });
    try {
      await loggedSend('Log.enable', {});
    } catch (error) {
      input.evidence.droppedEvent('Log.enable', error);
    }
    try {
      await loggedSend('Browser.enable', {});
    } catch (error) {
      input.evidence.droppedEvent('Browser.enable', error);
    }
    await installObserver();
    upsertTargetRow({
      id: input.rootTargetId,
      type: input.rootWindowRole === 'popup' ? 'popup' : 'page',
      attached: true,
      url: null,
      ...(input.rootOpenerTargetId ? { openerTargetId: input.rootOpenerTargetId } : {}),
      attachedAt: input.now(),
    });
  } catch (error) {
    // 捕获根会话 attach / Network.enable / 观察脚本注入失败
    // 策略：第一刀失败关闭；先移除监听并 detach，绝不留活监听器与孤儿事件队列
    try {
      input.cdp.off?.('message', onCdpMessage);
    } catch (cleanupError) {
      void cleanupError;
    }
    try {
      await input.cdp.detach?.();
    } catch (cleanupError) {
      void cleanupError;
    }
    throw error;
  }
  ready = true;

  return {
    stopAccepting() {
      if (phase === 'live') phase = 'drain';
    },
    async drain() {
      if (phase === 'live') phase = 'drain';
      for (let round = 0; round < 50; round += 1) {
        const events = eventQueue;
        const sources = sourceQueue;
        await events;
        await sources;
        if (eventQueue === events && sourceQueue === sources) break;
      }
      // Debugger.enable 的 scriptParsed 可能略晚于命令返回（CDP 推送无完成
      // 信号，无法用 Promise 门控确定性等待）。此处是有界收尾宽限：只补
      // 迟到的脚本/目标事件，50ms 后到达的事件由 enqueueEvent 显式记账丢弃。
      await new Promise(resolve => setTimeout(resolve, 50));
      for (let round = 0; round < 20; round += 1) {
        const events = eventQueue;
        const sources = sourceQueue;
        await events;
        await sources;
        if (eventQueue === events && sourceQueue === sources) break;
      }
      // loadingFinished 的延迟提交计时器收口（responseReceivedExtraInfo 竞态）：
      // 计时器最迟一个宽限后自行提交，此处只等其触发，不引入新的等待源
      for (let round = 0; round < 20 && pendingFinishCommits.size > 0; round += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      phase = 'closed';
    },
    async snapshotBrowserState(): Promise<BrowserStateStepOutcome> {
      let cookiesOk = false;
      let cookies: Array<Record<string, unknown>> = [];
      try {
        // 可选 CDP 命令一律有界：渲染进程挂死时超时返回，不挂起收尾
        const result = await awaitWithTimeout(
          loggedSend('Network.getCookies', {}),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'Network.getCookies timed out',
        );
        if (isRecord(result) && Array.isArray(result.cookies)) {
          cookies = result.cookies.filter(isRecord);
          cookiesOk = true;
        } else {
          // 返回形状不符（无 cookies 数组）＝ 该步失败：记账后按空数据继续
          input.evidence.droppedEvent('Network.getCookies', new Error('返回缺少 cookies 数组'));
        }
      } catch (error) {
        // 捕获 Cookie 快照失败：Network 域未就绪或浏览器拒绝
        // 策略：写入空 cookies，不阻断收尾；失败经步骤明细如实上报
        input.evidence.droppedEvent('Network.getCookies', error);
      }
      let storageOk = false;
      let localStorage: Record<string, string> = {};
      let sessionStorage: Record<string, string> = {};
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: STORAGE_DUMP_INSTRUMENTATION_SOURCE,
            returnByValue: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'Storage 快照 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (isRecord(remote)) {
          localStorage = stringMap(remote.localStorage);
          sessionStorage = stringMap(remote.sessionStorage);
          storageOk = true;
        } else {
          input.evidence.droppedEvent('storage-dump', new Error('返回缺少 storage 映射'));
        }
      } catch (error) {
        // 捕获 Storage 快照失败：当前文档可能无法访问 storage
        // 策略：写入空 map，不阻断收尾；失败经步骤明细如实上报
        input.evidence.droppedEvent('storage-dump', error);
      }
      let indexedDbOk = false;
      let indexedDb: PackV2IndexedDbEntry[] = [];
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: INDEXEDDB_DUMP_INSTRUMENTATION_SOURCE,
            returnByValue: true,
            awaitPromise: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'IndexedDB 枚举 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (Array.isArray(remote)) {
          indexedDb = remote.filter(isRecord).map(entry => ({
            database: stringValue(entry.database),
            objectStore: stringValue(entry.objectStore),
            record: entry.record ?? null,
          }));
          indexedDbOk = true;
        } else {
          input.evidence.droppedEvent('indexeddb-dump', new Error('返回缺少 IndexedDB 条目数组'));
        }
      } catch (error) {
        input.evidence.droppedEvent('indexeddb-dump', error);
      }
      let cacheStorageOk = false;
      let cacheStorage: PackV2CacheStorageEntry[] = [];
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: CACHE_STORAGE_DUMP_INSTRUMENTATION_SOURCE,
            returnByValue: true,
            awaitPromise: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'CacheStorage 枚举 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (Array.isArray(remote)) {
          cacheStorageOk = true;
          for (const entry of remote.filter(isRecord)) {
            const row: PackV2CacheStorageEntry = {
              origin: stringValue(entry.origin),
              cacheName: stringValue(entry.cacheName),
              requestUrl: stringValue(entry.requestUrl),
            };
            const responseB64 = stringValue(entry.responseB64);
            if (responseB64) {
              try {
                row.responseRef = await input.browser.storeCacheBody(Buffer.from(responseB64, 'base64'));
              } catch (error) {
                // 正文取出但落盘失败 = 步骤失败，不得伪装成
                // 「已写入」——droppedEvent 已记账，步骤明细同步翻 false
                input.evidence.droppedEvent('cache-body', error);
                cacheStorageOk = false;
              }
            }
            cacheStorage.push(row);
          }
        } else {
          input.evidence.droppedEvent('cachestorage-dump', new Error('返回缺少 CacheStorage 条目数组'));
        }
      } catch (error) {
        input.evidence.droppedEvent('cachestorage-dump', error);
      }
      await input.browser.writeStorage({
        targetId: input.rootTargetId,
        capturedAt: input.now(),
        cookies,
        localStorage,
        sessionStorage,
        indexedDb,
        cacheStorage,
      });
      // Frame Tree 快照（规范 §8.4）：可选 CDP 命令一律有界，失败记账后继续
      let frameTreeOk = false;
      try {
        const frameTreeResult = await awaitWithTimeout(
          loggedSend('Page.getFrameTree', {}),
          OPTIONAL_CDP_TIMEOUT_MS,
          'Page.getFrameTree timed out',
        );
        if (isRecord(frameTreeResult) && isRecord(frameTreeResult.frameTree)) {
          await input.browser.writeFrameTree({
            targetId: input.rootTargetId,
            capturedAt: input.now(),
            frameTree: frameTreeResult.frameTree,
          });
          frameTreeOk = true;
        } else {
          // 形状不符：写空结构（诚实下限），失败经步骤明细如实上报
          await input.browser.writeFrameTree({
            targetId: input.rootTargetId,
            capturedAt: input.now(),
            frameTree: {},
          });
          input.evidence.droppedEvent('Page.getFrameTree', new Error('返回缺少 frameTree 结构'));
        }
      } catch (error) {
        input.evidence.droppedEvent('Page.getFrameTree', error);
      }
      // 收尾截图 + DOM 快照（规范 §7.4 Viewer 稳定画面）；失败不是静默步骤
      const stopScreenshotOk = await captureScreenshot(undefined, input.rootTargetId, 'stop');
      const domSnapshotOk = await captureDomSnapshot(undefined, input.rootTargetId, 'stop');
      return {
        cookies: cookiesOk,
        storage: storageOk,
        indexedDb: indexedDbOk,
        cacheStorage: cacheStorageOk,
        frameTree: frameTreeOk,
        stopScreenshot: stopScreenshotOk,
        domSnapshot: domSnapshotOk,
      };
    },
    async snapshotAdditionalStorage() {
      let storageOk = false;
      let localStorage: Record<string, string> = {};
      let sessionStorage: Record<string, string> = {};
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: STORAGE_DUMP_INSTRUMENTATION_SOURCE,
            returnByValue: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'popup Storage 快照 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (isRecord(remote)) {
          localStorage = stringMap(remote.localStorage);
          sessionStorage = stringMap(remote.sessionStorage);
          storageOk = true;
        } else {
          input.evidence.droppedEvent('popup-storage-dump', new Error('返回缺少 storage 映射'));
        }
      } catch (error) {
        input.evidence.droppedEvent('popup-storage-dump', error);
      }

      let indexedDbOk = false;
      let indexedDb: PackV2IndexedDbEntry[] = [];
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: INDEXEDDB_DUMP_INSTRUMENTATION_SOURCE,
            returnByValue: true,
            awaitPromise: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'popup IndexedDB 枚举 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (Array.isArray(remote)) {
          indexedDb = remote.filter(isRecord).map(entry => ({
            database: stringValue(entry.database),
            objectStore: stringValue(entry.objectStore),
            record: entry.record ?? null,
          }));
          indexedDbOk = true;
        } else {
          input.evidence.droppedEvent('popup-indexeddb-dump', new Error('返回缺少 IndexedDB 条目数组'));
        }
      } catch (error) {
        input.evidence.droppedEvent('popup-indexeddb-dump', error);
      }

      let cacheStorageOk = false;
      const cacheStorage: PackV2CacheStorageEntry[] = [];
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: CACHE_STORAGE_DUMP_INSTRUMENTATION_SOURCE,
            returnByValue: true,
            awaitPromise: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'popup CacheStorage 枚举 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (Array.isArray(remote)) {
          cacheStorageOk = true;
          for (const entry of remote.filter(isRecord)) {
            const row: PackV2CacheStorageEntry = {
              origin: stringValue(entry.origin),
              cacheName: stringValue(entry.cacheName),
              requestUrl: stringValue(entry.requestUrl),
            };
            const responseB64 = stringValue(entry.responseB64);
            if (responseB64) {
              try {
                row.responseRef = await input.browser.storeCacheBody(Buffer.from(responseB64, 'base64'));
              } catch (error) {
                input.evidence.droppedEvent('popup-cache-body', error);
                cacheStorageOk = false;
              }
            }
            cacheStorage.push(row);
          }
        } else {
          input.evidence.droppedEvent(
            'popup-cachestorage-dump',
            new Error('返回缺少 CacheStorage 条目数组'),
          );
        }
      } catch (error) {
        input.evidence.droppedEvent('popup-cachestorage-dump', error);
      }

      try {
        await input.browser.addStorageContext({
          targetId: input.rootTargetId,
          capturedAt: input.now(),
          localStorage,
          sessionStorage,
          indexedDb,
          cacheStorage,
        });
      } catch (error) {
        input.evidence.droppedEvent('popup-storage-write', error);
        storageOk = false;
        indexedDbOk = false;
        cacheStorageOk = false;
      }
      return { storage: storageOk, indexedDb: indexedDbOk, cacheStorage: cacheStorageOk };
    },
    async collectPageEnvironment() {
      try {
        const result = await loggedSend('Runtime.evaluate', {
          expression: ENVIRONMENT_INSTRUMENTATION_SOURCE,
          returnByValue: true,
        });
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (!isRecord(remote)) return null;
        return {
          userAgent: stringValue(remote.userAgent),
          language: stringValue(remote.language),
          timezone: stringValue(remote.timezone),
          screen: stringValue(remote.screen),
        };
      } catch (error) {
        input.evidence.droppedEvent('page-environment', error);
        return null;
      }
    },
    async capturePhaseScreenshot(label) {
      return captureScreenshot(undefined, input.rootTargetId, label);
    },
    async snapshotFinalSurfaces() {
      const stopScreenshot = await captureScreenshot(undefined, input.rootTargetId, 'stop');
      const domSnapshot = await captureDomSnapshot(undefined, input.rootTargetId, 'stop');
      return { stopScreenshot, domSnapshot };
    },
    targets() {
      return [...targetRows.values()];
    },
    mainFrameNavigations() {
      return mainFrameNavigations.map(navigation => ({ ...navigation }));
    },
    readyBeforeFirstNavigation() {
      return ready && !navigationSeen;
    },
  };
}
