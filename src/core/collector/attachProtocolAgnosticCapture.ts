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
  PackV2TargetRow,
  PackV2TargetType,
  PackV2HttpInitiator,
  WsFrameOpcode,
} from '../capture-pack-v2/types';

const DEFAULT_NETWORK_ENABLE_TIMEOUT_MS = 5000;
const OPTIONAL_CDP_TIMEOUT_MS = 3000;
const SCRIPT_SOURCE_TIMEOUT_MS = 5000;

/** drain 阶段仍要落盘的事件（target 生命周期 / 脚本 / binding / 下载收尾）。 */
const DRAIN_METHODS = new Set([
  'Target.attachedToTarget',
  'Target.detachedFromTarget',
  'Target.targetCreated',
  'Target.targetDestroyed',
  'Debugger.scriptParsed',
  'Runtime.bindingCalled',
  'Browser.downloadWillBegin',
  'Browser.downloadProgress',
]);

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

export interface AttachedCapture {
  drain(): Promise<void>;
  /** 之后到达的 CDP 事件不再写入工作区。 */
  stopAccepting(): void;
  /** Cookie / Storage / IndexedDB / CacheStorage 快照 + 收尾截图与 DOM 快照；stopAccepting 之后、finalize 之前调用。 */
  snapshotBrowserState(): Promise<void>;
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
        loggedSend('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SCRIPT_SOURCE }, sessionId),
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
      loggedSend('Runtime.evaluate', { expression: OBSERVER_SCRIPT_SOURCE, returnByValue: true }, sessionId),
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

  async function storeRequestBody(hopId: string, requestId: string, sessionId?: string): Promise<void> {
    const result = await loggedSend('Network.getRequestPostData', { requestId }, sessionId);
    const postData = isRecord(result) ? stringValue(result.postData) : '';
    if (!postData) return;
    const ref = await input.http.storeBody(Buffer.from(postData, 'utf8'));
    input.http.patchHop(hopId, { requestBody: ref });
  }

  async function storeResponseBody(hopId: string, requestId: string, sessionId?: string): Promise<void> {
    const result = await loggedSend('Network.getResponseBody', { requestId }, sessionId);
    const bytes = decodeCdpBody(result);
    const ref = await input.http.storeBody(bytes);
    input.http.patchHop(hopId, { responseBody: ref });
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

  async function captureScreenshot(sessionId: string | undefined, targetId: string, label: string): Promise<void> {
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
    } catch (error) {
      // 捕获截图失败：窗口隐藏 / GPU 不可用 / 目标无 Page 域
      // 策略：丢弃计数显式记账，不阻断导航事件链
      input.evidence.droppedEvent('Page.captureScreenshot', error);
    }
  }

  async function captureDomSnapshot(sessionId: string | undefined, targetId: string, label: string): Promise<void> {
    try {
      const result = await awaitWithTimeout(
        loggedSend(
          'Runtime.evaluate',
          {
            expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
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
    } catch (error) {
      // 捕获 DOM 快照失败：文档不可访问或目标已导航离开
      // 策略：丢弃计数显式记账，不阻断导航事件链
      input.evidence.droppedEvent('dom-snapshot', error);
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
        const openerId = optionalString(targetInfo.openerId);
        upsertTargetRow({
          id: attachedTargetId,
          type: mapTargetType(attachedType, openerId),
          attached: true,
          url: optionalString(targetInfo.url) ?? null,
          ...(openerId ? { openerTargetId: openerId } : {}),
          attachedAt: input.now(),
        });
        await enableAttachedTarget(attachedSessionId, attachedType);
      }
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      const detachedSessionId = stringValue(params.sessionId);
      const detachedTargetId = stringValue(params.targetId);
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
        upsertTargetRow({
          id: targetId,
          type: mapTargetType(stringValue(targetInfo.type) || 'other', openerId),
          attached: known?.attached ?? targetInfo.attached === true,
          url: optionalString(targetInfo.url) ?? null,
          ...(openerId ? { openerTargetId: openerId } : {}),
          ...(known?.attachedAt ? { attachedAt: known.attachedAt } : {}),
          ...(known?.detachReason ? { detachReason: known.detachReason } : {}),
        });
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
      const targetId = targetIdOf(sessionId);
      const kindHint = scriptKindHint(targetTypeOf(sessionId));
      const sourceMapURL = optionalString(params.sourceMapURL);
      const scriptLanguage = stringValue(params.scriptLanguage);
      const fetchSessionId = sessionId;
      // getScriptSource 走独立队列，避免挡住 Target.attachedToTarget / Network.enable
      enqueueSourceFetch(async () => {
        let source = '';
        let sourceBytes: Buffer | undefined;
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
          // 捕获 getScriptSource 失败：WASM、已回收脚本或子会话未 enable Debugger
          // 策略：仍登记索引，无正文（缺口由 ScriptCollector 记账）
          void error;
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
      const redirectResponse = isRecord(params.redirectResponse) ? params.redirectResponse : null;
      const redirectedFromId = redirectResponse ? chain[chain.length - 1] : undefined;
      if (redirectResponse && redirectedFromId) {
        const nextId = `${baseId}::redirect-${chain.length}`;
        input.http.patchHop(redirectedFromId, {
          status: numberValue(redirectResponse.status),
          responseHeaders: headersValue(redirectResponse.headers),
          redirectToId: nextId,
        });
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
        input.http.patchHop(id, { requestBody: ref });
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
      const baseId = scopedId(requestId, sessionId);
      if (ignored.has(baseId)) return;
      const id = activeHopId(baseId);
      if (!input.http.has(id)) return;
      const response = isRecord(params.response) ? params.response : {};
      const headers = headersValue(response.headers);
      const timingRaw = isRecord(response.timing) ? response.timing : null;
      input.http.patchHop(id, {
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
      const baseId = scopedId(requestId, sessionId);
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
        // hop 已提交（redirect 链在下一跳前 commit）：journal 只追加，不改写已落盘行
        input.evidence.droppedEvent(method, new Error(`extraInfo 到达晚于 commit，头未合并：${id}`));
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = stringValue(params.requestId);
      const baseId = scopedId(requestId, sessionId);
      if (ignored.has(baseId)) return;
      const id = activeHopId(baseId);
      if (!input.http.has(id)) return;
      try {
        await storeResponseBody(id, requestId, sessionId);
      } catch (error) {
        // 捕获响应体不可读取：缓存命中、重定向、流式资源或 CDP 生命周期限制
        // 策略：仍提交事务行，缺 responseBody 由 commit 记 missingBodies 缺口
        input.evidence.recordGap('missingBodies', id, `响应正文不可读取：${errorMessage(error)}`);
      }
      await input.http.commit(id);
      return;
    }

    if (method === 'Network.loadingFailed') {
      const baseId = scopedId(stringValue(params.requestId), sessionId);
      if (ignored.has(baseId)) return;
      const id = activeHopId(baseId);
      if (!input.http.has(id)) return;
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
    await loggedSend('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SCRIPT_SOURCE });
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
      phase = 'closed';
    },
    async snapshotBrowserState() {
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
        }
      } catch (error) {
        // 捕获 Cookie 快照失败：Network 域未就绪或浏览器拒绝
        // 策略：写入空 cookies，不阻断收尾
        input.evidence.droppedEvent('Network.getCookies', error);
      }
      let localStorage: Record<string, string> = {};
      let sessionStorage: Record<string, string> = {};
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: STORAGE_DUMP_EXPRESSION,
            returnByValue: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'Storage 快照 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (isRecord(remote)) {
          localStorage = stringMap(remote.localStorage);
          sessionStorage = stringMap(remote.sessionStorage);
        }
      } catch (error) {
        // 捕获 Storage 快照失败：当前文档可能无法访问 storage
        // 策略：写入空 map，不阻断收尾
        input.evidence.droppedEvent('storage-dump', error);
      }
      let indexedDb: PackV2IndexedDbEntry[] = [];
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: INDEXEDDB_DUMP_EXPRESSION,
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
        }
      } catch (error) {
        input.evidence.droppedEvent('indexeddb-dump', error);
      }
      let cacheStorage: PackV2CacheStorageEntry[] = [];
      try {
        const result = await awaitWithTimeout(
          loggedSend('Runtime.evaluate', {
            expression: CACHE_STORAGE_DUMP_EXPRESSION,
            returnByValue: true,
            awaitPromise: true,
          }),
          OPTIONAL_CDP_TIMEOUT_MS * 10,
          'CacheStorage 枚举 timed out',
        );
        const remote = isRecord(result) && isRecord(result.result) ? result.result.value : undefined;
        if (Array.isArray(remote)) {
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
                input.evidence.droppedEvent('cache-body', error);
              }
            }
            cacheStorage.push(row);
          }
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
      try {
        const frameTreeResult = await awaitWithTimeout(
          loggedSend('Page.getFrameTree', {}),
          OPTIONAL_CDP_TIMEOUT_MS,
          'Page.getFrameTree timed out',
        );
        const frameTree =
          isRecord(frameTreeResult) && isRecord(frameTreeResult.frameTree)
            ? frameTreeResult.frameTree
            : {};
        await input.browser.writeFrameTree({
          targetId: input.rootTargetId,
          capturedAt: input.now(),
          frameTree,
        });
      } catch (error) {
        input.evidence.droppedEvent('Page.getFrameTree', error);
      }
      // 收尾截图 + DOM 快照（规范 §7.4 Viewer 稳定画面）
      await captureScreenshot(undefined, input.rootTargetId, 'stop');
      await captureDomSnapshot(undefined, input.rootTargetId, 'stop');
    },
    async collectPageEnvironment() {
      try {
        const result = await loggedSend('Runtime.evaluate', {
          expression: ENVIRONMENT_EXPRESSION,
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
