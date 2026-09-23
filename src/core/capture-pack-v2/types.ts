/**
 * Capture Pack 2.0 数据契约（KVM-Recon 0.3.0）。
 *
 * 权威规范：docs/v0.3-development-spec.md。schema/2.0/ 下的 JSON Schema
 * 必须与本文件逐字段同步（规范 §22）；修改类型时同步修改 Schema 与测试。
 *
 * 0.2.x / Capture Pack 1.x 的类型在 src/core/capture-pack/types.ts，保持不动，
 * 用于旧包兼容；不要把 1.x 的限制（YES/PARTIAL/NO、大小上限、脱敏）带入本模块。
 */

// ---------- 状态枚举（规范 §6） ----------

export type CaptureIntegrity = 'COMPLETE' | 'INCOMPLETE' | 'LEGACY_UNVERIFIED';

export type WorkflowStatus = 'KVM_REACHED' | 'LOGIN_REACHED' | 'TARGET_OPENED';

export type ClassificationStatus = 'KNOWN' | 'UNKNOWN';

// ---------- 完整度原因稳定代码（规范 §14） ----------

/**
 * 完整度原因稳定代码（规范 §14）。
 * 前 8 个为规范 §14 列出的典型代码；后 3 个是 0.3.0 阶段 0 为
 * raw journal 关闭、浏览器状态写入与证据引用闭环三类门禁失败补充的稳定代码，
 * 保证任何门禁失败都必须有显式原因（规范 §3：缺失必须显式）。
 */
export type IncompleteReasonCode =
  | 'INCOMPLETE_BODY_MISSING'
  | 'INCOMPLETE_TARGET_ATTACH'
  | 'INCOMPLETE_WORKER_SOURCE'
  | 'INCOMPLETE_CHANNEL_GAP'
  | 'INCOMPLETE_UNSUPPORTED_CHANNEL'
  | 'INCOMPLETE_STORAGE_LIMIT'
  | 'INCOMPLETE_EXPORT_VALIDATION'
  | 'INCOMPLETE_WORKFLOW_NOT_REACHED'
  | 'INCOMPLETE_RAW_JOURNAL'
  | 'INCOMPLETE_BROWSER_STATE'
  | 'INCOMPLETE_EVIDENCE_REFERENCE';

export const PACK_V2_SCHEMA_VERSION = '2.0.0' as const;

// ---------- manifest.json（规范 §4.1 / §13） ----------

export interface PackV2Manifest {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  tool: PackV2ToolInfo;
  job: PackV2JobInfo;
  target: PackV2Target;
  captureIntegrity: CaptureIntegrity;
  workflowStatus: WorkflowStatus;
  classificationStatus: ClassificationStatus;
  security: PackV2Security;
  environment: PackV2Environment;
}

export interface PackV2ToolInfo {
  name: 'KVM-Recon';
  version: string;
  buildId: string;
}

export interface PackV2JobInfo {
  /** 完整作业 ID，例如 20260918-143522-7f3a2c。 */
  id: string;
  /** 进入 ZIP 文件名的短作业 ID（文件名安全字符）。 */
  shortId: string;
  startedAt: string;
  endedAt: string | null;
  /**
   * 设备说明：用户在主界面填写的自由文本（通常为「厂商 / 型号」）。
   * 不参与协议识别、完整度、ZIP 命名与 Adapter 主键判断（规范 §4.1）。
   */
  deviceLabel: string;
}

export interface PackV2Target {
  host: string;
  port: number;
  scheme: 'http' | 'https';
  /** 用户在主界面输入的原始 BMC 地址。 */
  originalInput: string;
}

/** 不脱敏策略固定写入 manifest（规范 §13）。 */
export interface PackV2Security {
  dataHandling: 'UNREDACTED';
  containsSensitiveData: true;
}

/** 采集环境（规范 §7.1：记录 Chromium/Electron/OS/UA/语言/时区/屏幕）。 */
export interface PackV2Environment {
  chromium: string;
  electron: string;
  os: string;
  userAgent: string;
  language: string;
  timezone: string;
  screen: string;
}

// ---------- integrity.json（规范 §14 十项门禁） ----------

export type PackV2IntegrityGateId =
  | 'collector-ready-before-first-navigation'
  | 'targets-attached'
  | 'http-bodies-complete'
  | 'scripts-workers-wasm-complete'
  | 'realtime-channels-complete'
  | 'no-uncollected-channel'
  | 'raw-journals-closed'
  | 'browser-state-written'
  | 'evidence-references-closed'
  | 'zip-self-validated';

/** 规范 §14 十项门禁的完整 ID 集合；integrity.json 与状态构造器必须恰好覆盖。 */
export const PACK_V2_INTEGRITY_GATE_IDS: readonly PackV2IntegrityGateId[] = [
  'collector-ready-before-first-navigation',
  'targets-attached',
  'http-bodies-complete',
  'scripts-workers-wasm-complete',
  'realtime-channels-complete',
  'no-uncollected-channel',
  'raw-journals-closed',
  'browser-state-written',
  'evidence-references-closed',
  'zip-self-validated',
];

export interface PackV2IntegrityGate {
  id: PackV2IntegrityGateId;
  passed: boolean;
  detail?: string;
}

export interface PackV2Integrity {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  captureIntegrity: CaptureIntegrity;
  reasons: IncompleteReasonCode[];
  gates: PackV2IntegrityGate[];
  generatedAt: string;
}

// ---------- 完整度证据摘要与派生结果（阶段 3 IntegrityEngine 的契约骨架） ----------

export interface IntegrityEvidenceGap {
  id: string;
  detail?: string;
}

/**
 * 完整度证据摘要。阶段 0 只固化字段语义；阶段 3 的 IntegrityEngine
 * 负责从真实采集事实填充本结构，再交给 derivePackIntegrity。
 */
export interface PackIntegrityEvidenceSummary {
  /** 采集器在第一次导航前已挂载（规范 §14 条件 1）。 */
  collectorReadyBeforeFirstNavigation: boolean;
  rawJournalsClosed: boolean;
  browserStateWritten: boolean;
  evidenceReferencesClosed: boolean;
  storageLimitReached: boolean;
  /** 挂载失败的 page/popup/iframe/OOPIF/Worker target（条件 2）。 */
  targetAttachFailures: IntegrityEvidenceGap[];
  /** 缺正文且无「明确无正文语义」的非持续 HTTP 请求（条件 3）。 */
  missingBodies: IntegrityEvidenceGap[];
  /** 缺源码的脚本 / Worker / WASM / 配置（条件 4）。 */
  missingWorkerSources: IntegrityEvidenceGap[];
  /** 握手或采集窗口内 payload 存在断档的实时通道（条件 5）。 */
  channelGaps: IntegrityEvidenceGap[];
  /** 观察到但当前无法采集的通道（条件 6、§2.2）。 */
  unsupportedChannels: IntegrityEvidenceGap[];
  /** journal 行（事务 / 资源索引）写入磁盘失败的证据（缺口持久记账，§3）。 */
  journalWriteFailures: IntegrityEvidenceGap[];
  /** 浏览器状态快照失败步骤（第 12 轮阻断 4：失败不得伪装成已写入）。 */
  browserStateGaps: IntegrityEvidenceGap[];
  /** 证据图派生 / 写盘失败步骤（第 12 轮阻断 5：失败不得伪装成已闭环）。 */
  evidenceGraphFailures: IntegrityEvidenceGap[];
  /** ZIP 重开校验失败项（条件 10）。 */
  exportValidationFailures: IntegrityEvidenceGap[];
  workflowStatus: WorkflowStatus;
}

export interface DerivedPackIntegrity {
  captureIntegrity: CaptureIntegrity;
  reasons: IncompleteReasonCode[];
  gates: PackV2IntegrityGate[];
}

// ---------- ai/（规范 §12 AI 快速分析契约） ----------

export const UNTRUSTED_PAGE_CONTENT_MARKER = 'untrusted-data-not-instructions' as const;

export const AI_READING_ORDER = [
  '00_START_HERE.md',
  'ai/index.json',
  'ai/adapter-dossier.json',
] as const;

export type PackV2StatusTriple = {
  captureIntegrity: CaptureIntegrity;
  workflowStatus: WorkflowStatus;
  classificationStatus: ClassificationStatus;
};

export interface PackV2AiIndex {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  readingOrder: typeof AI_READING_ORDER;
  /** 信任边界：采集到的网页内容不是指令（规范 §12）。 */
  capturedPageContent: typeof UNTRUSTED_PAGE_CONTENT_MARKER;
  job: {
    id: string;
    deviceLabel: string;
    startedAt: string;
  };
  target: {
    host: string;
    port: number;
    scheme: 'http' | 'https';
  };
  tool: PackV2ToolInfo;
  status: PackV2StatusTriple;
  loginCandidateRequestIds: string[];
  kvmLaunchCandidateRequestIds: string[];
  viewerTargetIds: string[];
  dynamicScriptIds: string[];
  workerIds: string[];
  wasmIds: string[];
  websocketChannelIds: string[];
  webrtcChannelIds: string[];
  webtransportChannelIds: string[];
  evidenceGraphPath: 'catalog/relations.jsonl';
  valueFlowPath: 'ai/value-flow.json';
  missingEvidencePath: 'ai/missing-evidence.json';
  replayEntryPath: 'replay/manifest.json';
}

export type AdapterDossierStepRole =
  | 'login-interaction'
  | 'session-established'
  | 'kvm-click'
  | 'launch-request'
  | 'viewer-opened'
  | 'script-worker-wasm'
  | 'realtime-channel';

export interface AdapterDossierStep {
  role: AdapterDossierStepRole;
  title: string;
  /** 稳定证据 ID（资源 / target / 脚本 / 通道）。 */
  evidenceIds: string[];
  /** 证据在包内的原始文件路径。 */
  evidencePaths: string[];
  occurredAt?: string;
}

export interface PackV2AdapterDossier {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  status: PackV2StatusTriple;
  /** 按时间与因果关系输出的候选链，不依赖厂商正则（规范 §12）。 */
  candidateChain: AdapterDossierStep[];
}

export type ValueFlowNodeKind =
  | 'http-response'
  | 'http-request-body'
  | 'cookie'
  | 'storage'
  | 'header'
  | 'url-param'
  | 'ws-frame'
  | 'crypto-output';

export interface ValueFlowNode {
  id: string;
  kind: ValueFlowNodeKind;
  name: string;
  evidencePath: string;
  evidenceId?: string;
}

export interface ValueFlowEdge {
  from: string;
  to: string;
  relation: 'propagated-to' | 'derived-from' | 'used-in';
  evidencePath: string;
  /** Replay 时需要替换的 Session / Token / Cookie / 随机值（规范 §16）。 */
  replaySubstitution?: boolean;
}

export interface PackV2ValueFlow {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  nodes: ValueFlowNode[];
  edges: ValueFlowEdge[];
}

export interface MissingEvidenceItem {
  reason: IncompleteReasonCode;
  title: string;
  detail: string;
  evidencePath?: string;
}

export interface PackV2MissingEvidence {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  captureIntegrity: CaptureIntegrity;
  items: MissingEvidenceItem[];
}

// ---------- catalog / raw 行类型（规范 §11、§8） ----------

/** SHA-256 寻址正文引用（规范 §9）。 */
export interface PackV2BodyRef {
  sha256: string;
  bytes: number;
  /** 包内路径，例如 raw/http/bodies/<sha256>。 */
  path: string;
}

export type PackV2ResourceKind =
  | 'document'
  | 'xhr'
  | 'fetch'
  | 'script'
  | 'worker'
  | 'wasm'
  | 'stylesheet'
  | 'image'
  | 'font'
  | 'media'
  | 'source-map'
  | 'other';

/** catalog/resources.jsonl 每行：稳定索引。 */
export interface PackV2ResourceRow {
  id: string;
  kind: PackV2ResourceKind;
  url: string;
  method: string;
  status: number | null;
  contentType: string | null;
  targetId: string;
  occurredAt: string;
  requestBody?: PackV2BodyRef;
  responseBody?: PackV2BodyRef;
}

export type PackV2TargetType =
  | 'page'
  | 'popup'
  | 'iframe'
  | 'oopif'
  | 'worker'
  | 'shared-worker'
  | 'service-worker';

/** catalog/targets.json 与 raw/browser/targets.json 的行。 */
export interface PackV2TargetRow {
  id: string;
  type: PackV2TargetType;
  attached: boolean;
  url: string | null;
  openerTargetId?: string;
  parentTargetId?: string;
  attachedAt?: string;
  detachReason?: string;
}

export interface PackV2TargetsFile {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  targets: PackV2TargetRow[];
}

export type PackV2ChannelKind =
  | 'websocket'
  | 'webrtc'
  | 'webtransport'
  | 'sse'
  | 'download'
  | 'other';

/** catalog/channels.json 的行。 */
export interface PackV2ChannelRow {
  id: string;
  kind: PackV2ChannelKind;
  url: string | null;
  targetId: string | null;
  createdAt: string;
  closedAt: string | null;
  /** 双向帧/消息计数；下载等单向通道为 null。 */
  frameCounts?: { up: number; down: number } | null;
  payloadPath: string | null;
}

export interface PackV2ChannelsFile {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  channels: PackV2ChannelRow[];
}

export type PackV2RelationKind =
  | 'initiated'
  | 'opened'
  | 'attached'
  | 'loaded'
  | 'created'
  | 'value-flow';

/** catalog/relations.jsonl 每行。 */
export interface PackV2RelationRow {
  from: string;
  to: string;
  relation: PackV2RelationKind;
  occurredAt: string;
  evidencePath?: string;
}

// ---------- raw/http（规范 §8.2） ----------

/** 请求发起信息（发起栈 / initiator，保留 CDP 原始字段）。 */
export interface PackV2HttpInitiator {
  type: string;
  url?: string;
  lineNumber?: number;
  stackTrace?: Array<Record<string, unknown>>;
}

export interface PackV2HttpTiming {
  sendMs: number;
  waitMs: number;
  receiveMs: number;
}

/** raw/http/transactions.jsonl 每行：完整请求响应事实（不脱敏）。 */
export interface PackV2HttpTransactionRow {
  id: string;
  targetId: string;
  /** CDP frameId / windowId，用于 frame/window 血缘（规范 §8.2）。 */
  frameId?: string;
  windowId?: string;
  startedAt: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody?: PackV2BodyRef;
  status: number | null;
  responseHeaders: Record<string, string>;
  /** 响应 Content-Encoding 等内容编码信息（规范 §8.2）。 */
  contentEncoding?: string | null;
  responseBody?: PackV2BodyRef;
  initiator?: PackV2HttpInitiator;
  referer?: string;
  timing?: PackV2HttpTiming | null;
  /** 连接信息（规范 §8.2）。 */
  connectionId?: string;
  remoteIpAddress?: string;
  remotePort?: number;
  redirectFromId?: string;
  redirectToId?: string;
}

// ---------- raw/websocket（规范 §8.5） ----------

export interface PackV2WsMetadata {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  channelId: string;
  url: string;
  targetId: string;
  createdAt: string;
  closedAt: string | null;
  /** 浏览器请求的子协议。 */
  requestedSubProtocols: string[];
  /** 服务端最终选择的子协议。 */
  acceptedSubProtocol: string | null;
  /** 协商成功的扩展（如 permessage-deflate）。 */
  extensions: string[];
  /** 关闭码；连接仍开着时为 null。 */
  closeCode: number | null;
  /** 关闭原因；连接仍开着时为 null。 */
  closeReason: string | null;
  handshakeStatus: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  frameCounts: { up: number; down: number };
  /** frames.bin 的包内路径。 */
  framesBinPath: string;
}

export type WsFrameOpcode =
  | 'continuation'
  | 'text'
  | 'binary'
  | 'close'
  | 'ping'
  | 'pong';

/** raw/websocket/<socket-id>/frames.index.jsonl 每行（规范 §8.5：保留消息边界）。 */
export interface PackV2WsFrameIndexRow {
  frameIndex: number;
  direction: 'up' | 'down';
  opcode: WsFrameOpcode;
  /** 是否为消息最后一帧（continuation/FIN 边界信息）。 */
  fin: boolean;
  timestamp: string;
  /** frames.bin 内的字节偏移。 */
  payloadOffset: number;
  payloadLength: number;
}

// ---------- raw/cdp（规范 §8.1） ----------

/** raw/cdp/events.jsonl 每行。params 保留 CDP 原始字段，不做裁剪。 */
export interface PackV2CdpEventRow {
  seq: number;
  timestamp: string;
  method: string;
  sessionId?: string;
  targetId?: string;
  params: Record<string, unknown>;
}

/** raw/cdp/commands.jsonl 每行。 */
export interface PackV2CdpCommandRow {
  seq: number;
  timestamp: string;
  method: string;
  sessionId?: string;
  targetId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

// ---------- raw/netlog（规范 §8.1） ----------

/**
 * raw/netlog/netlog.json。除 envelope 字段外，Chromium NetLog 的原始字段
 * （constants 等）与当前解析器不认识的字段必须原样保留（规范 §8.1），
 * 因此本类型开放任意附加字段，Schema 同步放开 additionalProperties。
 */
export interface PackV2NetLogFile {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  captureMode: string;
  /** NetLog 原始事件（Chromium 常量原样保留）。 */
  events: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// ---------- raw/realtime（规范 §8.5 WebRTC / WebTransport / SSE / 下载） ----------

export type WebRtcEventKind =
  | 'peer-connection-created'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'dtls-fingerprint'
  | 'stats'
  | 'datachannel-opened'
  | 'datachannel-closed'
  | 'datachannel-message'
  | 'other';

/**
 * raw/realtime/webrtc.jsonl 每行。生命周期事件的 SDP / ICE / stats 等原始
 * 字段保存在 detail；消息（datachannel-message）必须携带方向、通道标识、
 * 消息序号与 FIN 边界，二进制 / 大消息经 BodyStore 引用（raw/realtime/bodies）。
 */
export interface PackV2WebRtcEventRow {
  occurredAt: string;
  targetId: string;
  peerConnectionId: string;
  kind: WebRtcEventKind;
  direction?: 'up' | 'down';
  /** DataChannel 标识（label / id）。 */
  dataChannelId?: string;
  /** 通道内消息序号（从 0 递增）。 */
  messageIndex?: number;
  /** 消息是否完整边界（continuation/FIN）。 */
  fin?: boolean;
  detail?: Record<string, unknown>;
  /** 消息正文引用（BodyStore，含 SHA-256 与字节数）。 */
  messageRef?: PackV2BodyRef;
}

export type WebTransportEventKind =
  | 'created'
  | 'connected'
  | 'closed'
  | 'stream-opened'
  | 'stream-message'
  | 'datagram'
  | 'other';

/**
 * raw/realtime/webtransport.jsonl 每行。流与 datagram 消息必须携带方向、
 * stream 标识、消息序号与边界；二进制 / 大消息经 BodyStore 引用。
 */
export interface PackV2WebTransportEventRow {
  occurredAt: string;
  targetId: string;
  transportId: string;
  kind: WebTransportEventKind;
  direction?: 'up' | 'down';
  /** stream 标识（单向 / 双向流 ID）。 */
  streamId?: string;
  /** 流内消息序号（从 0 递增）。 */
  messageIndex?: number;
  fin?: boolean;
  detail?: Record<string, unknown>;
  messageRef?: PackV2BodyRef;
}

/** raw/realtime/sse.jsonl 每行：EventSource / SSE 事件生命周期与数据。 */
export type SseLifecycleKind = 'connected' | 'event' | 'error' | 'closed';

export interface PackV2SseEventRow {
  id: string;
  occurredAt: string;
  targetId: string;
  url: string;
  kind: SseLifecycleKind;
  /** SSE event: 字段；缺省为 message。 */
  event?: string;
  /** SSE id: 字段（服务端事件 ID）。 */
  serverEventId?: string;
  retryMs?: number;
  /** 事件边界内的原始 data（BodyStore 引用，含 SHA-256 与字节数）。 */
  dataRef?: PackV2BodyRef;
}

/**
 * raw/realtime/downloads.jsonl 每行：浏览器下载（含触发浏览器外通道的下载）。
 * 文件内容经 BodyStore 引用（raw/realtime/downloads/<sha256>）。
 */
export interface PackV2DownloadRow {
  id: string;
  occurredAt: string;
  targetId: string;
  url: string;
  suggestedFileName?: string;
  mimeType?: string;
  fileRef?: PackV2BodyRef;
  completed: boolean;
}

// ---------- raw/runtime（规范 §8.6 运行时算法与值传播） ----------

export type PackV2CryptoOperationKind =
  | 'encrypt'
  | 'decrypt'
  | 'digest'
  | 'sign'
  | 'verify'
  | 'derive-key'
  | 'derive-bits'
  | 'generate-key'
  | 'import-key'
  | 'export-key'
  | 'custom';

/**
 * raw/runtime/crypto.jsonl 每行：WebCrypto / 自定义算法调用事实。
 * 算法、参数、输入输出（BodyStore 引用）、调用脚本位置、Target、时间与
 * 异常全部保留（规范 §8.6），支撑登录加密（如摘要凭据、SM2/RSA 自实现）
 * 的离线还原；派生关系写入 ai/value-flow.json。
 */
export interface PackV2CryptoCallRow {
  id: string;
  occurredAt: string;
  targetId: string;
  kind: PackV2CryptoOperationKind;
  /** 算法名（WebCrypto 标准名或自定义实现名，原样保留）。 */
  algorithm: string;
  /** 算法参数原样保留（IV、salt、迭代次数、曲线、模数等）。 */
  algorithmParams?: Record<string, unknown>;
  /** 调用脚本位置。 */
  scriptId?: string;
  scriptUrl?: string;
  lineNumber?: number;
  /** 调用输入正文（BodyStore 引用，raw/runtime/bodies）。 */
  inputRef?: PackV2BodyRef;
  /** 调用输出正文（BodyStore 引用，raw/runtime/bodies）。 */
  outputRef?: PackV2BodyRef;
  /** 调用异常（如操作被策略拒绝）。 */
  error?: string;
}

// ---------- raw/browser（规范 §8.4） ----------

export type BrowserTimelineEventKind =
  | 'navigation'
  | 'popup-opened'
  | 'hash-change'
  | 'worker-created'
  | 'channel-opened'
  | 'screenshot-saved'
  | 'dom-snapshot-saved';

export interface PackV2BrowserTimelineRow {
  occurredAt: string;
  kind: BrowserTimelineEventKind;
  targetId: string;
  url?: string;
  detail?: string;
}

export type BrowserActionKind =
  | 'click'
  | 'form-submit';

/** raw/browser/actions.jsonl 每行：用户操作时间线（不含键盘输入值，规范 §7.2）。 */
export interface PackV2BrowserActionRow {
  /** 稳定操作 ID（dossier 与证据图引用，规范 §12）。 */
  id: string;
  occurredAt: string;
  kind: BrowserActionKind;
  targetId: string;
  /** 元素语义摘要（选择器或可见文案）。 */
  elementSummary: string;
  url?: string;
}

/** 新建渲染/执行表面种类（§7.3 第 2 组事实；页面观察脚本上报）。 */
export type RenderSurfaceKind =
  | 'canvas'
  | 'video'
  | 'offscreencanvas'
  | 'canvas-context'
  | 'worker'
  | 'shared-worker'
  | 'request-animation-frame';

/** raw/browser/render-surfaces.jsonl 每行：动作后血缘内新建的 Canvas / Video /
 * Worker / 持续渲染表面（§7.3 KVM 判定的第 2 组事实，第五轮 G1）。 */
export interface PackV2RenderSurfaceRow {
  /** 稳定表面事件 ID（render-0001…）。 */
  id: string;
  occurredAt: string;
  targetId: string;
  surface: RenderSurfaceKind;
  /** 表面细节（contextType / Worker 脚本 URL / rAF 回调序号等）。 */
  detail: string | null;
}

/** IndexedDB 适配相关记录（规范 §8.4）。 */
export interface PackV2IndexedDbEntry {
  database: string;
  objectStore: string;
  record: unknown;
}

/** CacheStorage 适配相关记录（规范 §8.4）。 */
export interface PackV2CacheStorageEntry {
  origin: string;
  cacheName: string;
  requestUrl: string;
  responseRef?: PackV2BodyRef;
}

/** 单个页面根上下文的 Storage 快照。sessionStorage 按 browsing context 隔离，
 * popup 不能由主窗口快照代替；localStorage/IndexedDB/CacheStorage 即使同源
 * 重复也保留各根实际观察结果。 */
export interface PackV2BrowserStorageContext {
  targetId: string;
  capturedAt: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  indexedDb: PackV2IndexedDbEntry[];
  cacheStorage: PackV2CacheStorageEntry[];
}

export interface PackV2BrowserStorageFile {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  targetId: string;
  capturedAt: string;
  cookies: Array<Record<string, unknown>>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  indexedDb: PackV2IndexedDbEntry[];
  cacheStorage: PackV2CacheStorageEntry[];
  /** 主根之外的 popup/独立窗口上下文；旧 2.0 包可不含此字段。 */
  additionalContexts?: PackV2BrowserStorageContext[];
}

/** raw/browser/frame-tree.json：收尾时 Page.getFrameTree 的原始 Frame Tree（规范 §8.4）。 */
export interface PackV2BrowserFrameTreeFile {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  targetId: string;
  capturedAt: string;
  frameTree: Record<string, unknown>;
}

export type ControllerDiagnosticKind =
  | 'window-created'
  | 'load-start'
  | 'load-done'
  | 'load-failed'
  | 'cdp-attached'
  | 'cdp-attach-failed'
  | 'cert-trusted'
  | 'renderer-gone'
  | 'popup-created'
  | 'viewer-activity-detected'
  | 'viewer-activity-error'
  | 'viewer-auto-stop'
  | 'viewer-auto-stop-deferred'
  | 'viewer-auto-stop-failed'
  | 'viewer-initial-screenshot-failed';

/** raw/controller/diagnostics.jsonl 每行：Controller 层采集过程事实（规范 §8.4，含证书错误）。 */
export interface PackV2ControllerDiagnosticRow {
  occurredAt: string;
  kind: ControllerDiagnosticKind;
  detail: string;
}

export type BrowserConsoleLevel = 'log' | 'info' | 'warning' | 'error';

export interface PackV2BrowserConsoleRow {
  occurredAt: string;
  targetId: string;
  level: BrowserConsoleLevel;
  text: string;
}

// ---------- raw/scripts（规范 §8.3） ----------

export type DynamicScriptKind =
  | 'network-script'
  | 'inline'
  | 'eval'
  | 'function'
  | 'blob'
  | 'data'
  | 'worker'
  | 'shared-worker'
  | 'service-worker'
  | 'wasm'
  | 'source-map';

export interface PackV2ScriptEntry {
  id: string;
  kind: DynamicScriptKind;
  url: string | null;
  targetId: string | null;
  /** 创建者（父 target 或引者请求）。 */
  createdBy?: string;
  bodyRef?: PackV2BodyRef;
  /** CDP Debugger.scriptParsed.hash；用于跨文档相同源码的严格去重补全。 */
  contentHash?: string;
  /** CDP Debugger.scriptParsed.length（字符长度，0 表示真实空脚本）。 */
  sourceLength?: number;
  sourceMapPath?: string;
}

/** raw/scripts/index.json。 */
export interface PackV2ScriptsIndex {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  scripts: PackV2ScriptEntry[];
}

// ---------- raw/probe（规范 §8.7：Probe 只是补充事实） ----------

export interface PackV2ProbeFile {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  /** Probe 失败不阻止浏览器采集，命中也不提升完整度（规范 §8.7）。 */
  probeRan: boolean;
  facts: Array<Record<string, unknown>>;
}

// ---------- replay/（规范 §16） ----------

export interface PackV2ReplayRequest {
  requestId: string;
  url: string;
  method: string;
  /** 需要替换的动态值节点 ID（见 ai/value-flow.json）。 */
  requiresDynamicValueIds: string[];
}

export interface PackV2ReplayChannel {
  channelId: string;
  kind: PackV2ChannelKind;
  /** 帧序列索引的包内路径（含方向与消息边界）。 */
  framesIndexPath: string | null;
  /** 回放该通道需要替换的动态值节点 ID（如 WS 握手的 Session Cookie 与 token），见 ai/value-flow.json。 */
  requiresDynamicValueIds: string[];
}

export interface PackV2ReplayManifest {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  /** 无法生成 Replay Fixture 时必须列出缺失证据（规范 §16）。 */
  replayable: boolean;
  clockPolicy: 'deterministic-accelerated' | 'realtime';
  requests: PackV2ReplayRequest[];
  channels: PackV2ReplayChannel[];
}

/** replay/http.jsonl 每行。 */
export interface PackV2ReplayRequestRow {
  requestId: string;
  url: string;
  method: string;
  requestBodyPath: string | null;
  responseBodyPath: string | null;
  occurredAt: string;
}

/** replay/channels.json。 */
export interface PackV2ReplayChannelsFile {
  schemaVersion: typeof PACK_V2_SCHEMA_VERSION;
  channels: PackV2ReplayChannel[];
}
