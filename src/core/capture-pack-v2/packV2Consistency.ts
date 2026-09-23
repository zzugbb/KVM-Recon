import { createHash } from 'node:crypto';

import Ajv from 'ajv';

import { checkPackStatus } from './packStatus';
import { checkPackV2Layout, checkStartHereContent } from './packV2Layout';
import { PACK_V2_INTEGRITY_GATE_IDS } from './types';
import type {
  AdapterDossierStep,
  PackV2BodyRef,
  PackV2ChannelRow,
  PackV2Manifest,
  PackV2RelationRow,
  PackV2ResourceRow,
  PackV2ScriptEntry,
  PackV2TargetRow,
  PackV2WsFrameIndexRow,
} from './types';

/**
 * Capture Pack 2.0 样例包一致性验证器（独立于生成器与 IntegrityEngine）。
 *
 * 从包内文件本身验证（而不是重放生成器输入）：
 * - checksums.sha256 覆盖全部文件、哈希一致且无重复条目；
 * - 状态文件（manifest / integrity / ai/index / adapter-dossier）状态互相一致且合法，
 *   integrity 门禁恰好覆盖十个唯一且合法的 ID；
 * - 包内结构化文件按包内 schema/ 副本完成 Schema 自校验（规范 §14 条件 10）；
 * - 资源 / 脚本 / 实时消息 / 下载 / crypto 调用 / 通道 / 截图 / DOM 快照 / 证据引用
 *   全部闭环（无悬空引用）；
 * - WS 帧索引偏移与 frames.bin 长度、通道计数一致；通道验证按 channel.kind 分派；
 * - relations / value-flow / dossier / replay 引用的稳定 ID 均可解析。
 *
 * 阶段 0 用于样例包与负向测试（删除正文、删除截图、悬空引用必须被抓出）；
 * 阶段 3 的 IntegrityEngine 在真实导出时复用同一验证结论。
 */

export type PackV2ConsistencyProblemCode =
  | 'REQUIRED_FILE_MISSING'
  | 'PARSE_ERROR'
  | 'DUPLICATE_PATH'
  | 'CHECKSUM_MISSING_ENTRY'
  | 'CHECKSUM_EXTRA_ENTRY'
  | 'CHECKSUM_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'STATUS_ILLEGAL'
  | 'GATE_COUNT_INVALID'
  | 'GATE_ID_INVALID'
  | 'GATE_FAILED_WITH_COMPLETE'
  | 'REASONS_EMPTY_WITH_INCOMPLETE'
  | 'PACK_SCHEMA_MISSING'
  | 'SCHEMA_VIOLATION'
  | 'UNEXPECTED_TOP_LEVEL_ENTRY'
  | 'START_HERE_INVALID'
  | 'DANGLING_BODY_REF'
  | 'BODY_HASH_MISMATCH'
  | 'DANGLING_SCRIPT_REF'
  | 'DANGLING_EVIDENCE_PATH'
  | 'CHANNEL_FILE_MISSING'
  | 'CHANNEL_EVENT_MISSING'
  | 'FRAME_OFFSET_MISMATCH'
  | 'CHANNEL_COUNT_MISMATCH'
  | 'MISSING_SCREENSHOT'
  | 'MISSING_VIEWER_SCREENSHOTS'
  | 'MISSING_DOM_SNAPSHOT'
  | 'RAW_JOURNAL_INVALID'
  | 'RAW_JOURNAL_EMPTY'
  | 'UNKNOWN_EVIDENCE_ID'
  | 'VALUE_FLOW_UNKNOWN_NODE'
  | 'REPLAY_UNKNOWN_ID'
  | 'REPLAY_MISMATCH';

export interface PackV2ConsistencyProblem {
  code: PackV2ConsistencyProblemCode;
  detail: string;
  /** 问题涉及的包内路径（存在时用于按文件域归类门禁失败）。 */
  path?: string;
}

export interface PackV2ConsistencyResult {
  valid: boolean;
  problems: PackV2ConsistencyProblem[];
}

export interface PackV2ConsistencyOptions {
  /** 校验 checksums.sha256（默认 true）。样例生成器在写清单前传 false。 */
  requireChecksumFile?: boolean;
  /** 校验状态文件一致性（默认 true）。样例生成器在写状态文件前传 false。 */
  requireStatusFiles?: boolean;
  /** 执行包内 Schema 自校验（默认 true）。 */
  requireSchemaValidation?: boolean;
  /**
   * raw journal（原始日志）内容校验交给外部流式通道（默认 false）。
   * 为 true 时：cdp journal 递增/netlog 空、WS 帧偏移与计数、实时事件
   * 关联、raw journal ID 收集等内容检查被跳过（存在性/checksums/布局
   * 仍强制），ID 闭合并入 rawJournalIds。用于导出器对无界日志的有界
   * 内存校验；必须与流式校验配合使用，不得单独开启。
   */
  skipRawJournalContentChecks?: boolean;
  /** skipRawJournalContentChecks 时由流式通道收集的 raw journal ID 集合。 */
  rawJournalIds?: ReadonlySet<string>;
}

export interface PackV2ArtifactLike {
  path: string;
  content: string | Uint8Array;
  /**
   * 调用方背书的预计算 SHA-256（文件背书：由导出器等对文件流式计算得出）。
   * 提供时验证器跳过内容哈希（用于大正文不整体载入内存的流式校验），
   * 与逐字节哈希完全等价；提供错误值会被 checksums / BodyRef 比较抓出。
   */
  sha256?: string;
  /** 调用方背书的字节数；与 sha256 配套使用。 */
  bytes?: number;
}

/**
 * 状态文件：依赖完整度结论的派生文件。样例生成器写状态前的预校验
 * （requireStatusFiles: false）会跳过这些文件的必需性与一致性检查。
 */
const STATUS_FILES = [
  'manifest.json',
  'integrity.json',
  'report.html',
  'ai/index.json',
  'ai/summary.md',
  'ai/adapter-dossier.json',
  'ai/missing-evidence.json',
];
const CHECKSUM_FILE = 'checksums.sha256';

/**
 * 截图阶段标签：截图文件名 = raw/browser/screenshots/<seq>-<label>.png，
 * 标签 = 文件名去掉 .png 后再去掉前导序号前缀；viewer-initial 与 stop 是仅有的
 * 阶段截图标签（登录 / 导航等过程截图不得计入 §7.4 阶段截图条件）。
 */
function screenshotLabelOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.png$/, '').replace(/^\d+-/, '');
}
/** 包内 Schema 副本必须使用的 $id 前缀；$id 与文件名一一对应，否则视为 Schema 被篡改。 */
export const SCHEMA_ID_PREFIX = 'https://kvm-recon.local/schema/2.0';

/** 包内路径 → Schema 文件（包内 schema/ 副本）映射；jsonl=true 时逐行校验。 */
const SCHEMA_TARGETS: ReadonlyArray<{
  path: string | RegExp;
  schema: string;
  jsonl: boolean;
}> = [
  { path: 'manifest.json', schema: 'manifest.schema.json', jsonl: false },
  { path: 'integrity.json', schema: 'integrity.schema.json', jsonl: false },
  { path: 'ai/index.json', schema: 'ai-index.schema.json', jsonl: false },
  { path: 'ai/adapter-dossier.json', schema: 'ai-adapter-dossier.schema.json', jsonl: false },
  { path: 'ai/value-flow.json', schema: 'ai-value-flow.schema.json', jsonl: false },
  { path: 'ai/missing-evidence.json', schema: 'ai-missing-evidence.schema.json', jsonl: false },
  { path: 'catalog/resources.jsonl', schema: 'catalog-resource.schema.json', jsonl: true },
  { path: 'catalog/targets.json', schema: 'targets.schema.json', jsonl: false },
  { path: 'catalog/channels.json', schema: 'catalog-channels.schema.json', jsonl: false },
  { path: 'catalog/relations.jsonl', schema: 'catalog-relation.schema.json', jsonl: true },
  { path: 'raw/http/transactions.jsonl', schema: 'http-transaction.schema.json', jsonl: true },
  { path: 'raw/cdp/events.jsonl', schema: 'cdp-event.schema.json', jsonl: true },
  { path: 'raw/cdp/commands.jsonl', schema: 'cdp-command.schema.json', jsonl: true },
  { path: 'raw/netlog/netlog.json', schema: 'netlog.schema.json', jsonl: false },
  { path: /^raw\/websocket\/[^/]+\/metadata\.json$/, schema: 'ws-metadata.schema.json', jsonl: false },
  { path: /^raw\/websocket\/[^/]+\/frames\.index\.jsonl$/, schema: 'ws-frame-index.schema.json', jsonl: true },
  { path: 'raw/realtime/webrtc.jsonl', schema: 'realtime-webrtc.schema.json', jsonl: true },
  { path: 'raw/realtime/webtransport.jsonl', schema: 'realtime-webtransport.schema.json', jsonl: true },
  { path: 'raw/realtime/sse.jsonl', schema: 'realtime-sse.schema.json', jsonl: true },
  { path: 'raw/realtime/downloads.jsonl', schema: 'realtime-download.schema.json', jsonl: true },
  { path: 'raw/runtime/crypto.jsonl', schema: 'runtime-crypto.schema.json', jsonl: true },
  { path: 'raw/browser/timeline.jsonl', schema: 'browser-timeline-event.schema.json', jsonl: true },
  { path: 'raw/browser/actions.jsonl', schema: 'browser-action.schema.json', jsonl: true },
  { path: 'raw/browser/render-surfaces.jsonl', schema: 'browser-render-surface.schema.json', jsonl: true },
  { path: 'raw/browser/targets.json', schema: 'targets.schema.json', jsonl: false },
  { path: 'raw/browser/storage.json', schema: 'browser-storage.schema.json', jsonl: false },
  { path: 'raw/browser/console.jsonl', schema: 'browser-console-entry.schema.json', jsonl: true },
  { path: 'raw/scripts/index.json', schema: 'scripts-index.schema.json', jsonl: false },
  { path: 'replay/manifest.json', schema: 'replay-manifest.schema.json', jsonl: false },
  { path: 'replay/http.jsonl', schema: 'replay-request.schema.json', jsonl: true },
  { path: 'replay/channels.json', schema: 'replay-channels.schema.json', jsonl: false },
  { path: 'raw/probe/index.json', schema: 'probe-index.schema.json', jsonl: false },
];

function schemaFor(path: string): { schema: string; jsonl: boolean } | undefined {
  return SCHEMA_TARGETS.find(
    target =>
      (typeof target.path === 'string' && target.path === path) ||
      (target.path instanceof RegExp && target.path.test(path)),
  );
}

/** 导出器流式 raw-journal 校验复用同一份 path→Schema 映射（单一事实源）。 */
export function packV2SchemaTargetFor(
  path: string,
): { schema: string; jsonl: boolean } | undefined {
  return schemaFor(path);
}

/**
 * 无界 raw journal 路径全集：CDP 事件/命令、NetLog、HTTP 事务、浏览器
 * 与实时/运行时 JSONL、WebSocket 帧索引。导出器对它们做流式校验
 * （不整体载入内存），其余结构化文件（catalog/replay/ai/状态/Schema）
 * 属于索引与元数据规模，保留在内存校验。
 */
export function isRawJournalPath(path: string): boolean {
  return (
    path === 'raw/netlog/netlog.json' ||
    path === 'raw/cdp/events.jsonl' ||
    path === 'raw/cdp/commands.jsonl' ||
    path === 'raw/http/transactions.jsonl' ||
    path === 'raw/runtime/crypto.jsonl' ||
    (path.startsWith('raw/browser/') && path.endsWith('.jsonl')) ||
    (path.startsWith('raw/realtime/') && path.endsWith('.jsonl')) ||
    /^raw\/websocket\/[^/]+\/frames\.index\.jsonl$/.test(path)
  );
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(toBuffer(content)).digest('hex');
}

export function validatePackV2Consistency(
  artifacts: ReadonlyArray<PackV2ArtifactLike>,
  options: PackV2ConsistencyOptions = {},
): PackV2ConsistencyResult {
  const problems: PackV2ConsistencyProblem[] = [];
  /** raw journal 内容校验委托：哈希背书工件无内容，跳过其解析/单行 Schema。 */
  const skipRawJournalContent = options.skipRawJournalContentChecks === true;
  const add = (code: PackV2ConsistencyProblemCode, detail: string, path?: string) => {
    problems.push({ code, detail, ...(path ? { path } : {}) });
  };

  // ---- 0. 重复路径 ----
  const byPath = new Map<string, PackV2ArtifactLike>();
  for (const artifact of artifacts) {
    if (byPath.has(artifact.path)) {
      add('DUPLICATE_PATH', `包内路径重复：${artifact.path}`, artifact.path);
      continue;
    }
    byPath.set(artifact.path, artifact);
  }
  const has = (path: string) => byPath.has(path);
  const shaOf = (path: string): string => {
    const artifact = byPath.get(path);
    if (!artifact) return '';
    return artifact.sha256 ?? sha256(artifact.content);
  };
  const bytesOf = (path: string): number => {
    const artifact = byPath.get(path);
    if (!artifact) return 0;
    if (artifact.bytes !== undefined) return artifact.bytes;
    return toBuffer(artifact.content).length;
  };
  const bufferOf = (path: string) => {
    const artifact = byPath.get(path);
    return artifact ? toBuffer(artifact.content) : null;
  };
  const textOf = (path: string): string | null => {
    const buffer = bufferOf(path);
    return buffer === null ? null : buffer.toString('utf8');
  };
  const jsonOf = (path: string): unknown => {
    const text = textOf(path);
    if (text === null) return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      add('PARSE_ERROR', `${path}: ${error instanceof Error ? error.message : String(error)}`, path);
      return undefined;
    }
  };
  const jsonlOf = (path: string): unknown[] => {
    const text = textOf(path);
    if (text === null) return [];
    const rows: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        add(
          'PARSE_ERROR',
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
          path,
        );
      }
    }
    return rows;
  };

  // ---- 1. 必需文件 / 顶层条目 / 00_START_HERE ----
  const optionalFiles = new Set<string>();
  if (options.requireStatusFiles === false) {
    for (const file of STATUS_FILES) optionalFiles.add(file);
  }
  if (options.requireChecksumFile === false) optionalFiles.add(CHECKSUM_FILE);
  const layout = checkPackV2Layout(artifacts.map(artifact => artifact.path));
  for (const missing of layout.missingFiles) {
    if (optionalFiles.has(missing)) continue;
    add('REQUIRED_FILE_MISSING', missing, missing);
  }
  for (const entry of layout.unexpectedTopLevelEntries) {
    add('UNEXPECTED_TOP_LEVEL_ENTRY', `契约外顶层条目：${entry}/`);
  }
  const startHereText = textOf('00_START_HERE.md');
  if (startHereText !== null) {
    const startHereCheck = checkStartHereContent(startHereText);
    for (const problem of startHereCheck.problems) {
      add('START_HERE_INVALID', problem, '00_START_HERE.md');
    }
  }

  // ---- 2. 正文 / 脚本 / 消息 / 下载 / crypto 引用闭环 ----
  const checkBodyRef = (ref: PackV2BodyRef | undefined, owner: string, danglingCode: PackV2ConsistencyProblemCode) => {
    if (!ref) return;
    if (!has(ref.path)) {
      add(danglingCode, `${owner} 引用的正文文件缺失：${ref.path}`, ref.path);
      return;
    }
    const digest = shaOf(ref.path);
    if (digest !== ref.sha256) {
      add('BODY_HASH_MISMATCH', `${owner} 引用的 ${ref.path} sha256 不一致`, ref.path);
    }
    const actualBytes = bytesOf(ref.path);
    if (actualBytes !== ref.bytes) {
      add('BODY_HASH_MISMATCH', `${owner} 引用的 ${ref.path} 字节数 ${actualBytes} != ${ref.bytes}`, ref.path);
    }
  };

  const resources = jsonlOf('catalog/resources.jsonl') as PackV2ResourceRow[];
  for (const row of resources) {
    checkBodyRef(row.requestBody, `资源 ${row.id}`, 'DANGLING_BODY_REF');
    checkBodyRef(row.responseBody, `资源 ${row.id}`, 'DANGLING_BODY_REF');
  }
  const transactions = jsonlOf('raw/http/transactions.jsonl') as Array<
    PackV2ResourceRow & { requestBody?: PackV2BodyRef; responseBody?: PackV2BodyRef; id: string }
  >;
  for (const row of transactions) {
    checkBodyRef(row.requestBody, `事务 ${row.id}`, 'DANGLING_BODY_REF');
    checkBodyRef(row.responseBody, `事务 ${row.id}`, 'DANGLING_BODY_REF');
  }
  const scriptIndex = jsonOf('raw/scripts/index.json') as { scripts?: PackV2ScriptEntry[] } | undefined;
  for (const script of scriptIndex?.scripts || []) {
    checkBodyRef(script.bodyRef, `脚本 ${script.id}`, 'DANGLING_SCRIPT_REF');
  }
  const storage = jsonOf('raw/browser/storage.json') as
    | {
        cacheStorage?: Array<{ requestUrl: string; responseRef?: PackV2BodyRef }>;
        additionalContexts?: Array<{
          targetId: string;
          cacheStorage?: Array<{ requestUrl: string; responseRef?: PackV2BodyRef }>;
        }>;
      }
    | undefined;
  for (const [index, entry] of (storage?.cacheStorage || []).entries()) {
    checkBodyRef(entry.responseRef, `CacheStorage[${index}] ${entry.requestUrl}`, 'DANGLING_BODY_REF');
  }
  for (const context of storage?.additionalContexts || []) {
    for (const [index, entry] of (context.cacheStorage || []).entries()) {
      checkBodyRef(
        entry.responseRef,
        `Storage 上下文 ${context.targetId} CacheStorage[${index}] ${entry.requestUrl}`,
        'DANGLING_BODY_REF',
      );
    }
  }
  // 运行时 crypto 调用的输入输出（规范 §8.6）。
  const cryptoRows = jsonlOf('raw/runtime/crypto.jsonl') as Array<{
    id: string;
    inputRef?: PackV2BodyRef;
    outputRef?: PackV2BodyRef;
  }>;
  for (const row of cryptoRows) {
    checkBodyRef(row.inputRef, `crypto ${row.id} 输入`, 'DANGLING_BODY_REF');
    checkBodyRef(row.outputRef, `crypto ${row.id} 输出`, 'DANGLING_BODY_REF');
  }
  // 实时消息 / SSE data / 下载文件引用（独立于 channels.json 存在与否）。
  const webrtcRows = jsonlOf('raw/realtime/webrtc.jsonl') as Array<{
    peerConnectionId: string;
    messageIndex?: number;
    messageRef?: PackV2BodyRef;
  }>;
  for (const [index, row] of webrtcRows.entries()) {
    checkBodyRef(
      row.messageRef,
      `WebRTC 消息 ${row.peerConnectionId}#${row.messageIndex ?? index}`,
      'DANGLING_BODY_REF',
    );
  }
  const webtransportRows = jsonlOf('raw/realtime/webtransport.jsonl') as Array<{
    transportId: string;
    streamId?: string;
    messageRef?: PackV2BodyRef;
  }>;
  for (const [index, row] of webtransportRows.entries()) {
    checkBodyRef(
      row.messageRef,
      `WebTransport 消息 ${row.transportId}/${row.streamId ?? index}`,
      'DANGLING_BODY_REF',
    );
  }
  const sseRows = jsonlOf('raw/realtime/sse.jsonl') as Array<{
    id: string;
    url: string;
    dataRef?: PackV2BodyRef;
  }>;
  for (const row of sseRows) {
    checkBodyRef(row.dataRef, `SSE 事件 ${row.id}`, 'DANGLING_BODY_REF');
  }
  const downloadRows = jsonlOf('raw/realtime/downloads.jsonl') as Array<{
    id: string;
    url: string;
    fileRef?: PackV2BodyRef;
  }>;
  for (const row of downloadRows) {
    checkBodyRef(row.fileRef, `下载 ${row.id}`, 'DANGLING_BODY_REF');
  }

  // ---- 3. 通道验证（按 channel.kind 分派，规范 §8.5） ----
  const channelsFile = jsonOf('catalog/channels.json') as { channels?: PackV2ChannelRow[] } | undefined;
  for (const channel of channelsFile?.channels || []) {
    const requirePayload = (detail: string) => {
      if (channel.payloadPath && !has(channel.payloadPath)) {
        add('CHANNEL_FILE_MISSING', `${detail}：${channel.payloadPath}`, channel.payloadPath);
        return false;
      }
      return true;
    };

    if (channel.kind === 'websocket') {
      // WebSocket 通道必须有 payloadPath（frames.bin）；缺引用本身就是不完整。
      if (!channel.payloadPath) {
        add('CHANNEL_FILE_MISSING', `WebSocket 通道 ${channel.id} 缺少 payloadPath（frames.bin）`);
        continue;
      }
      const channelDir = channel.payloadPath.replace(/\/[^/]*$/, '');
      const metadataPath = `${channelDir}/metadata.json`;
      const framesIndexPath = `${channelDir}/frames.index.jsonl`;
      if (!has(metadataPath)) {
        add('CHANNEL_FILE_MISSING', `通道 ${channel.id} 缺少 ${metadataPath}`, metadataPath);
      }
      if (!has(framesIndexPath)) {
        add('CHANNEL_FILE_MISSING', `通道 ${channel.id} 缺少 ${framesIndexPath}`, framesIndexPath);
      }
      if (!has(channel.payloadPath)) {
        add('CHANNEL_FILE_MISSING', `通道 ${channel.id} 缺少 ${channel.payloadPath}`, channel.payloadPath);
        continue;
      }
      // frames.bin 只参与长度越界判断：用（可预计算的）字节数即可，不载入内容。
      if (options.skipRawJournalContentChecks) continue;
      const framesBinBytes = bytesOf(channel.payloadPath);
      const frameRows = jsonlOf(framesIndexPath) as PackV2WsFrameIndexRow[];
      let expectedOffset = 0;
      let upCount = 0;
      let downCount = 0;
      for (const [index, frame] of frameRows.entries()) {
        if (frame.frameIndex !== index) {
          add('FRAME_OFFSET_MISMATCH', `通道 ${channel.id} 第 ${index} 行 frameIndex 不连续：${frame.frameIndex}`, framesIndexPath);
        }
        if (frame.payloadOffset !== expectedOffset) {
          add(
            'FRAME_OFFSET_MISMATCH',
            `通道 ${channel.id} 第 ${index} 帧 payloadOffset ${frame.payloadOffset} != 期望 ${expectedOffset}`,
            framesIndexPath,
          );
        }
        if (frame.payloadOffset + frame.payloadLength > framesBinBytes) {
          add(
            'FRAME_OFFSET_MISMATCH',
            `通道 ${channel.id} 第 ${index} 帧越界：${frame.payloadOffset}+${frame.payloadLength} > ${framesBinBytes}`,
            framesIndexPath,
          );
        }
        expectedOffset += frame.payloadLength;
        if (frame.direction === 'up') upCount += 1;
        else downCount += 1;
      }
      if (expectedOffset !== framesBinBytes) {
        add(
          'FRAME_OFFSET_MISMATCH',
          `通道 ${channel.id} 帧总长 ${expectedOffset} != frames.bin ${framesBinBytes}`,
          framesIndexPath,
        );
      }
      if (channel.frameCounts) {
        if (channel.frameCounts.up !== upCount || channel.frameCounts.down !== downCount) {
          add(
            'CHANNEL_COUNT_MISMATCH',
            `通道 ${channel.id} 计数 up/down ${channel.frameCounts.up}/${channel.frameCounts.down} != 索引 ${upCount}/${downCount}`,
          );
        }
      }
    } else {
      // WebRTC / WebTransport / SSE / 下载 / 其他：payloadPath 可空；设置了就必须存在。
      requirePayload(`通道 ${channel.id} 的 payloadPath 缺失`);
    }
  }

  // catalog 通道必须与实时事件文件按 ID / URL 关联：
  // 存在通道却没有对应生命周期或消息记录，说明实时事实缺失（规范 §8.5 / §14 条件 5）。
  if (!options.skipRawJournalContentChecks) {
    for (const channel of channelsFile?.channels || []) {
      if (channel.kind === 'webrtc') {
      if (!webrtcRows.some(row => row.peerConnectionId === channel.id)) {
        add(
          'CHANNEL_EVENT_MISSING',
          `catalog 中存在 WebRTC 通道 ${channel.id}，但 raw/realtime/webrtc.jsonl 没有任何对应记录`,
          'raw/realtime/webrtc.jsonl',
        );
      }
    } else if (channel.kind === 'webtransport') {
      if (!webtransportRows.some(row => row.transportId === channel.id)) {
        add(
          'CHANNEL_EVENT_MISSING',
          `catalog 中存在 WebTransport 通道 ${channel.id}，但 raw/realtime/webtransport.jsonl 没有任何对应记录`,
          'raw/realtime/webtransport.jsonl',
        );
      }
    } else if (channel.kind === 'sse') {
      if (!sseRows.some(row => row.url === channel.url)) {
        add(
          'CHANNEL_EVENT_MISSING',
          `catalog 中存在 SSE 通道 ${channel.id}，但 raw/realtime/sse.jsonl 没有任何对应记录`,
          'raw/realtime/sse.jsonl',
        );
      }
    } else if (channel.kind === 'download') {
      if (!downloadRows.some(row => row.url === channel.url)) {
        add(
          'CHANNEL_EVENT_MISSING',
          `catalog 中存在下载通道 ${channel.id}，但 raw/realtime/downloads.jsonl 没有任何对应记录`,
          'raw/realtime/downloads.jsonl',
        );
      }
    }
    }
  }

  // ---- 4. 浏览器状态（截图 / DOM 快照 / 原始 journal） ----
  const screenshotPaths = artifacts
    .map(artifact => artifact.path)
    .filter(path => path.startsWith('raw/browser/screenshots/'));
  const browserStateManifest = jsonOf('manifest.json') as PackV2Manifest | undefined;
  const browserStateIntegrity = jsonOf('integrity.json') as
    | {
        captureIntegrity?: string;
        reasons?: string[];
        gates?: Array<{ id: string; passed: boolean }>;
      }
    | undefined;
  // 窗口在收尾前已销毁时无法补拍；只有明确记下浏览器状态缺口的
  // INCOMPLETE 包可缺少表面工件。无状态的预验证及 COMPLETE 仍严格检查。
  const browserSurfacesUnavailable =
    browserStateManifest?.captureIntegrity === 'INCOMPLETE' &&
    browserStateIntegrity?.captureIntegrity === 'INCOMPLETE' &&
    browserStateIntegrity.reasons?.includes('INCOMPLETE_BROWSER_STATE') === true &&
    browserStateIntegrity.gates?.some(
      gate => gate.id === 'browser-state-written' && gate.passed === false,
    ) === true;
  if (screenshotPaths.length === 0 && !browserSurfacesUnavailable) {
    add('MISSING_SCREENSHOT', '包内没有任何截图（规范 §14 条件 8）');
  }
  const hasDomSnapshot = artifacts.some(artifact =>
    artifact.path.startsWith('raw/browser/dom-snapshots/'),
  );
  if (!hasDomSnapshot && !browserSurfacesUnavailable) {
    add('MISSING_DOM_SNAPSHOT', '包内没有任何 DOM 快照');
  }

  for (const journalPath of ['raw/cdp/events.jsonl', 'raw/cdp/commands.jsonl']) {
    if (!has(journalPath)) continue;
    if (options.skipRawJournalContentChecks) continue;
    let lastSeq = 0;
    const rows = jsonlOf(journalPath);
    for (const [index, row] of rows.entries()) {
      const seq = (row as { seq?: unknown }).seq;
      if (typeof seq !== 'number' || seq <= lastSeq) {
        add('RAW_JOURNAL_INVALID', `${journalPath} 第 ${index} 行 seq 不严格递增：${String(seq)}`, journalPath);
        break;
      }
      lastSeq = seq;
      if (typeof (row as { method?: unknown }).method !== 'string') {
        add('RAW_JOURNAL_INVALID', `${journalPath} 第 ${index} 行缺少 method`, journalPath);
        break;
      }
    }
    // 有网络事实但 journal 为空：journal 未写入（规范 §14 条件 7）。
    if (rows.length === 0 && transactions.length > 0) {
      add('RAW_JOURNAL_EMPTY', `${journalPath} 为空但包内存在 ${transactions.length} 个 HTTP 事务`, journalPath);
    }
  }
  if (options.skipRawJournalContentChecks) {
    // netlog 内容为空性检查由流式通道负责。
  } else {
    const netlog = jsonOf('raw/netlog/netlog.json') as { events?: unknown[] } | undefined;
    if (netlog && (netlog.events || []).length === 0 && transactions.length > 0) {
      add('RAW_JOURNAL_EMPTY', 'raw/netlog/netlog.json 没有任何事件但包内存在 HTTP 事务', 'raw/netlog/netlog.json');
    }
  }

  // ---- 5. 稳定 ID 引用闭环 ----
  const knownIds = new Set<string>();
  for (const row of resources) knownIds.add(row.id);
  const targetsFile = jsonOf('raw/browser/targets.json') as { targets?: PackV2TargetRow[] } | undefined;
  for (const row of targetsFile?.targets || []) knownIds.add(row.id);
  const catalogTargetsFile = jsonOf('catalog/targets.json') as { targets?: PackV2TargetRow[] } | undefined;
  for (const row of catalogTargetsFile?.targets || []) knownIds.add(row.id);
  for (const channel of channelsFile?.channels || []) knownIds.add(channel.id);
  for (const script of scriptIndex?.scripts || []) knownIds.add(script.id);
  if (options.skipRawJournalContentChecks) {
    // raw journal 行 ID 由流式通道收集后注入（同一集合语义，非跳过）。
    for (const id of options.rawJournalIds ?? []) knownIds.add(id);
  } else {
    for (const row of jsonlOf('raw/browser/actions.jsonl') as Array<{ id?: string }>) {
      if (row.id) knownIds.add(row.id);
    }
    for (const row of cryptoRows) knownIds.add(row.id);
    for (const row of jsonlOf('raw/realtime/sse.jsonl') as Array<{ id?: string }>) {
      if (row.id) knownIds.add(row.id);
    }
    for (const row of jsonlOf('raw/realtime/downloads.jsonl') as Array<{ id?: string }>) {
      if (row.id) knownIds.add(row.id);
    }
  }
  interface ValueFlowNodeLike {
    id: string;
    evidencePath?: string;
    evidenceId?: string;
  }
  interface ValueFlowEdgeLike {
    from: string;
    to: string;
    evidencePath?: string;
  }
  const valueFlow = jsonOf('ai/value-flow.json') as
    | { nodes?: ValueFlowNodeLike[]; edges?: ValueFlowEdgeLike[] }
    | undefined;
  for (const node of valueFlow?.nodes || []) knownIds.add(node.id);

  for (const [index, relation] of (
    jsonlOf('catalog/relations.jsonl') as PackV2RelationRow[]
  ).entries()) {
    for (const side of [relation.from, relation.to] as const) {
      if (!knownIds.has(side)) {
        add('UNKNOWN_EVIDENCE_ID', `relations.jsonl 第 ${index} 行引用未知 ID：${side}`, 'catalog/relations.jsonl');
      }
    }
    if (relation.evidencePath && !has(relation.evidencePath)) {
      add(
        'DANGLING_EVIDENCE_PATH',
        `relations.jsonl 第 ${index} 行引用的证据文件缺失：${relation.evidencePath}`,
        'catalog/relations.jsonl',
      );
    }
  }
  const valueFlowNodeIds = new Set((valueFlow?.nodes || []).map(node => node.id));
  for (const node of valueFlow?.nodes || []) {
    if (node.evidencePath && !has(node.evidencePath)) {
      add(
        'DANGLING_EVIDENCE_PATH',
        `value-flow 节点 ${node.id} 引用的证据文件缺失：${node.evidencePath}`,
        'ai/value-flow.json',
      );
    }
    if (node.evidenceId && !knownIds.has(node.evidenceId)) {
      add(
        'UNKNOWN_EVIDENCE_ID',
        `value-flow 节点 ${node.id} 引用未知证据 ID：${node.evidenceId}`,
        'ai/value-flow.json',
      );
    }
  }
  for (const [index, edge] of (valueFlow?.edges || []).entries()) {
    if (!valueFlowNodeIds.has(edge.from) || !valueFlowNodeIds.has(edge.to)) {
      add(
        'VALUE_FLOW_UNKNOWN_NODE',
        `value-flow 第 ${index} 条边引用未知节点：${edge.from} → ${edge.to}`,
        'ai/value-flow.json',
      );
    }
    if (edge.evidencePath && !has(edge.evidencePath)) {
      add(
        'DANGLING_EVIDENCE_PATH',
        `value-flow 第 ${index} 条边引用的证据文件缺失：${edge.evidencePath}`,
        'ai/value-flow.json',
      );
    }
  }
  const replayManifest = jsonOf('replay/manifest.json') as
    | {
        requests?: Array<{
          requestId: string;
          url?: string;
          method?: string;
          requiresDynamicValueIds?: string[];
        }>;
        channels?: Array<{
          channelId: string;
          kind?: string;
          framesIndexPath?: string | null;
          requiresDynamicValueIds?: string[];
        }>;
      }
    | undefined;
  const resourceIds = new Set(resources.map(row => row.id));
  const resourceById = new Map(resources.map(row => [row.id, row]));
  // replay 三处 ID 必须各自唯一：Map/Set 会静默合并重复 ID，导致
  // “重复定义”退化为“最后一次定义生效”，必须先显式报错再建索引。
  const reportDuplicateReplayIds = (ids: string[], label: string, file: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        add('REPLAY_MISMATCH', `${label}中 ID 重复出现：${id}`, file);
      } else {
        seen.add(id);
      }
    }
  };
  reportDuplicateReplayIds(
    (replayManifest?.requests || []).map(request => request.requestId),
    'replay/manifest.json 声明的请求',
    'replay/manifest.json',
  );
  reportDuplicateReplayIds(
    (replayManifest?.channels || []).map(channel => channel.channelId),
    'replay/manifest.json 声明的通道',
    'replay/manifest.json',
  );
  for (const request of replayManifest?.requests || []) {
    if (!resourceIds.has(request.requestId)) {
      add('REPLAY_UNKNOWN_ID', `replay 引用未知请求 ID：${request.requestId}`, 'replay/manifest.json');
    }
    for (const valueId of request.requiresDynamicValueIds || []) {
      if (!valueFlowNodeIds.has(valueId)) {
        add(
          'REPLAY_UNKNOWN_ID',
          `replay 请求 ${request.requestId} 引用未知动态值节点：${valueId}`,
          'replay/manifest.json',
        );
      }
    }
  }
  const channelIds = new Set((channelsFile?.channels || []).map(channel => channel.id));
  const channelById = new Map((channelsFile?.channels || []).map(channel => [channel.id, channel]));
  for (const channel of replayManifest?.channels || []) {
    if (!channelIds.has(channel.channelId)) {
      add('REPLAY_UNKNOWN_ID', `replay 引用未知通道 ID：${channel.channelId}`, 'replay/manifest.json');
    } else if (channel.kind && channelById.get(channel.channelId)?.kind !== channel.kind) {
      add(
        'REPLAY_MISMATCH',
        `replay 通道 ${channel.channelId} 的 kind（${channel.kind}）与 catalog/channels.json 不一致`,
        'replay/manifest.json',
      );
    }
    if (channel.framesIndexPath && !has(channel.framesIndexPath)) {
      add('REPLAY_UNKNOWN_ID', `replay 引用的帧索引缺失：${channel.framesIndexPath}`, 'replay/manifest.json');
    }
    for (const valueId of channel.requiresDynamicValueIds || []) {
      if (!valueFlowNodeIds.has(valueId)) {
        add(
          'REPLAY_UNKNOWN_ID',
          `replay 通道 ${channel.channelId} 引用未知动态值节点：${valueId}`,
          'replay/manifest.json',
        );
      }
    }
  }
  const replayHttpRows = jsonlOf('replay/http.jsonl') as Array<{
    requestId: string;
    url?: string;
    method?: string;
    requestBodyPath?: string | null;
    responseBodyPath?: string | null;
  }>;
  reportDuplicateReplayIds(
    replayHttpRows.map(row => row.requestId),
    'replay/http.jsonl 的行',
    'replay/http.jsonl',
  );
  for (const [index, row] of replayHttpRows.entries()) {
    if (!resourceIds.has(row.requestId)) {
      add('REPLAY_UNKNOWN_ID', `replay/http.jsonl 第 ${index} 行引用未知请求 ID：${row.requestId}`, 'replay/http.jsonl');
    }
    if (row.requestBodyPath && !has(row.requestBodyPath)) {
      add(
        'DANGLING_EVIDENCE_PATH',
        `replay/http.jsonl 第 ${index} 行引用的请求正文缺失：${row.requestBodyPath}`,
        'replay/http.jsonl',
      );
    }
    if (row.responseBodyPath && !has(row.responseBodyPath)) {
      add(
        'DANGLING_EVIDENCE_PATH',
        `replay/http.jsonl 第 ${index} 行引用的响应正文缺失：${row.responseBodyPath}`,
        'replay/http.jsonl',
      );
    }
    // 正文路径不只要求“存在于包内”，还必须与 catalog resource 的 BodyRef
    // 完全一致，否则指向包内另一个真实正文也能通过存在性检查。
    const resource = resourceById.get(row.requestId);
    if (resource) {
      const expectedRequestBodyPath = resource.requestBody?.path ?? null;
      const expectedResponseBodyPath = resource.responseBody?.path ?? null;
      if ((row.requestBodyPath ?? null) !== expectedRequestBodyPath) {
        add(
          'REPLAY_MISMATCH',
          `replay/http.jsonl 第 ${index} 行的请求正文路径与 catalog 资源 ${row.requestId} 不一致：` +
            `${row.requestBodyPath ?? 'null'} vs ${expectedRequestBodyPath ?? 'null'}`,
          'replay/http.jsonl',
        );
      }
      if ((row.responseBodyPath ?? null) !== expectedResponseBodyPath) {
        add(
          'REPLAY_MISMATCH',
          `replay/http.jsonl 第 ${index} 行的响应正文路径与 catalog 资源 ${row.requestId} 不一致：` +
            `${row.responseBodyPath ?? 'null'} vs ${expectedResponseBodyPath ?? 'null'}`,
          'replay/http.jsonl',
        );
      }
    }
  }

  // ---- replay 三方对齐：manifest ↔ replay/http.jsonl ↔ catalog resources ----
  // manifest 声明的请求必须逐项存在于 replay/http.jsonl，且 URL/method 与
  // replay/http.jsonl、catalog resources 一致；反之 replay/http.jsonl 不得出现
  // manifest 未声明的请求（否则删除任一侧的行仍可通过验证）。
  const httpRowById = new Map(replayHttpRows.map(row => [row.requestId, row]));
  for (const request of replayManifest?.requests || []) {
    const row = httpRowById.get(request.requestId);
    if (!row) {
      add(
        'REPLAY_MISMATCH',
        `replay/manifest.json 声明的请求 ${request.requestId} 不存在于 replay/http.jsonl`,
        'replay/manifest.json',
      );
    } else {
      if (request.url && row.url && request.url !== row.url) {
        add(
          'REPLAY_MISMATCH',
          `replay 请求 ${request.requestId} 的 URL 在 manifest 与 replay/http.jsonl 不一致：${request.url} vs ${row.url}`,
          'replay/manifest.json',
        );
      }
      if (request.method && row.method && request.method !== row.method) {
        add(
          'REPLAY_MISMATCH',
          `replay 请求 ${request.requestId} 的 method 在 manifest 与 replay/http.jsonl 不一致：${request.method} vs ${row.method}`,
          'replay/manifest.json',
        );
      }
    }
    const resource = resourceById.get(request.requestId);
    if (resource) {
      if (request.url && request.url !== resource.url) {
        add(
          'REPLAY_MISMATCH',
          `replay 请求 ${request.requestId} 的 URL 与 catalog resources 不一致：${request.url} vs ${resource.url}`,
          'replay/manifest.json',
        );
      }
      if (request.method && request.method !== resource.method) {
        add(
          'REPLAY_MISMATCH',
          `replay 请求 ${request.requestId} 的 method 与 catalog resources 不一致：${request.method} vs ${resource.method}`,
          'replay/manifest.json',
        );
      }
    }
  }
  const manifestRequestIds = new Set((replayManifest?.requests || []).map(request => request.requestId));
  for (const row of replayHttpRows) {
    if (!manifestRequestIds.has(row.requestId)) {
      add(
        'REPLAY_MISMATCH',
        `replay/http.jsonl 出现 manifest 未声明的请求：${row.requestId}`,
        'replay/http.jsonl',
      );
    }
  }

  // ---- replay 通道对齐：manifest channels ↔ replay/channels.json ↔ catalog channels ----
  const replayChannelsFile = jsonOf('replay/channels.json') as
    | { channels?: Array<{ channelId?: string; kind?: string; framesIndexPath?: string | null; requiresDynamicValueIds?: string[] }> }
    | undefined;
  // 通道两侧按完整语义比较：channelId、kind、framesIndexPath 之外，
  // requiresDynamicValueIds 也必须集合相等，否则缺一项或换成另一个合法
  // 动态值 ID 都会被 key 静默吸收。
  const replayChannelKey = (channel: {
    channelId?: string;
    kind?: string;
    framesIndexPath?: string | null;
    requiresDynamicValueIds?: string[];
  }) =>
    `${channel.channelId ?? ''}|${channel.kind ?? ''}|${channel.framesIndexPath ?? ''}|${[
      ...new Set(channel.requiresDynamicValueIds || []),
    ]
      .sort()
      .join(',')}`;
  const manifestChannelKeys = new Set((replayManifest?.channels || []).map(replayChannelKey));
  const replayChannels = replayChannelsFile?.channels || [];
  reportDuplicateReplayIds(
    replayChannels.map(channel => channel.channelId ?? ''),
    'replay/channels.json 的通道',
    'replay/channels.json',
  );
  const replayChannelKeys = new Set(replayChannels.map(replayChannelKey));
  for (const key of manifestChannelKeys) {
    if (!replayChannelKeys.has(key)) {
      add(
        'REPLAY_MISMATCH',
        `replay/manifest.json 声明的通道（${key}）不存在于 replay/channels.json`,
        'replay/manifest.json',
      );
    }
  }
  for (const key of replayChannelKeys) {
    if (!manifestChannelKeys.has(key)) {
      add(
        'REPLAY_MISMATCH',
        `replay/channels.json 出现 manifest 未声明的通道（${key}）`,
        'replay/channels.json',
      );
    }
  }
  for (const channel of replayChannels) {
    if (!channel.channelId) continue;
    if (!channelIds.has(channel.channelId)) {
      add(
        'REPLAY_UNKNOWN_ID',
        `replay/channels.json 引用未知通道 ID：${channel.channelId}`,
        'replay/channels.json',
      );
    } else if (channel.kind && channelById.get(channel.channelId)?.kind !== channel.kind) {
      add(
        'REPLAY_MISMATCH',
        `replay 通道 ${channel.channelId} 的 kind（${channel.kind}）与 catalog/channels.json 不一致`,
        'replay/channels.json',
      );
    }
    if (channel.framesIndexPath && !has(channel.framesIndexPath)) {
      add(
        'REPLAY_UNKNOWN_ID',
        `replay/channels.json 引用的帧索引缺失：${channel.framesIndexPath}`,
        'replay/channels.json',
      );
    }
    for (const valueId of channel.requiresDynamicValueIds || []) {
      if (!valueFlowNodeIds.has(valueId)) {
        add(
          'REPLAY_UNKNOWN_ID',
          `replay 通道 ${channel.channelId} 引用未知动态值节点：${valueId}`,
          'replay/channels.json',
        );
      }
    }
  }

  // ---- 6. 状态文件一致性 ----
  if (options.requireStatusFiles !== false) {
    const manifest = jsonOf('manifest.json') as PackV2Manifest | undefined;
    const integrity = jsonOf('integrity.json') as
      | {
          captureIntegrity?: string;
          reasons?: string[];
          gates?: Array<{ id: string; passed: boolean }>;
        }
      | undefined;
    const aiIndex = jsonOf('ai/index.json') as
      | {
          status?: {
            captureIntegrity?: string;
            workflowStatus?: string;
            classificationStatus?: string;
          };
          loginCandidateRequestIds?: string[];
          kvmLaunchCandidateRequestIds?: string[];
          viewerTargetIds?: string[];
          dynamicScriptIds?: string[];
          workerIds?: string[];
          wasmIds?: string[];
          websocketChannelIds?: string[];
          webrtcChannelIds?: string[];
          webtransportChannelIds?: string[];
        }
      | undefined;
    const dossier = jsonOf('ai/adapter-dossier.json') as
      | { status?: { captureIntegrity?: string; workflowStatus?: string; classificationStatus?: string }; candidateChain?: AdapterDossierStep[] }
      | undefined;

    if (manifest && integrity) {
      if (manifest.captureIntegrity !== integrity.captureIntegrity) {
        add(
          'STATUS_MISMATCH',
          `manifest (${manifest.captureIntegrity}) 与 integrity (${String(integrity.captureIntegrity)}) 完整度不一致`,
          'manifest.json',
        );
      }
      const gateIds = new Set((integrity.gates || []).map(gate => gate.id));
      if ((integrity.gates || []).length !== 10 || gateIds.size !== 10) {
        add('GATE_COUNT_INVALID', `integrity gates 应为 10 个唯一门禁，实际 ${(integrity.gates || []).length} 个 / ${gateIds.size} 个唯一`, 'integrity.json');
      }
      for (const gateId of gateIds) {
        if (!PACK_V2_INTEGRITY_GATE_IDS.includes(gateId as never)) {
          add('GATE_ID_INVALID', `未知门禁 ID：${gateId}`, 'integrity.json');
        }
      }
      if (integrity.captureIntegrity === 'COMPLETE') {
        if ((integrity.reasons || []).length > 0) {
          add('STATUS_ILLEGAL', 'COMPLETE 不允许携带完整度原因代码', 'integrity.json');
        }
        const failedGates = (integrity.gates || []).filter(gate => !gate.passed);
        if (failedGates.length > 0) {
          add(
            'GATE_FAILED_WITH_COMPLETE',
            `COMPLETE 存在未通过的门禁：${failedGates.map(gate => gate.id).join(', ')}`,
            'integrity.json',
          );
        }
        const scriptsWithoutBodies = (scriptIndex?.scripts || []).filter(script => !script.bodyRef);
        if (scriptsWithoutBodies.length > 0) {
          add(
            'STATUS_MISMATCH',
            `COMPLETE 包存在未留存源码的脚本：${scriptsWithoutBodies
              .slice(0, 10)
              .map(script => script.id)
              .join(', ')}`,
            'raw/scripts/index.json',
          );
        }
        // COMPLETE 必须有 Viewer 初始 + 稳定双截图（规范 §7.4 / §14 条件 8；
        // 按阶段标签判定，登录 / 导航等过程截图不再误计为阶段
        // 截图——文件名 = <seq>-<label>.png，viewer-initial 与 stop 是仅有的
        // 阶段截图标签）。
        const viewerInitialShots = screenshotPaths.filter(
          path => screenshotLabelOf(path) === 'viewer-initial',
        );
        const stopShots = screenshotPaths.filter(path => screenshotLabelOf(path) === 'stop');
        if (viewerInitialShots.length === 0 || stopShots.length === 0) {
          add(
            'MISSING_VIEWER_SCREENSHOTS',
            `COMPLETE 包需要带 viewer-initial 与 stop 阶段标签的截图各至少 1 张，实际 viewer-initial ${viewerInitialShots.length} 张 / stop ${stopShots.length} 张`,
          );
        }
      } else if (integrity.captureIntegrity === 'INCOMPLETE') {
        if ((integrity.reasons || []).length === 0) {
          add('REASONS_EMPTY_WITH_INCOMPLETE', 'INCOMPLETE 必须至少携带一个稳定原因代码', 'integrity.json');
        }
      }
      if (manifest.captureIntegrity === 'COMPLETE' || integrity.captureIntegrity === 'COMPLETE') {
        const check = checkPackStatus({
          captureIntegrity: manifest.captureIntegrity,
          workflowStatus: manifest.workflowStatus,
          classificationStatus: manifest.classificationStatus,
        });
        if (!check.legal) {
          add('STATUS_ILLEGAL', check.violations.join('; '), 'manifest.json');
        }
      }
      for (const [name, status] of [
        ['ai/index.json', aiIndex?.status],
        ['ai/adapter-dossier.json', dossier?.status],
      ] as const) {
        if (
          status &&
          (status.captureIntegrity !== manifest.captureIntegrity ||
            status.workflowStatus !== manifest.workflowStatus ||
            status.classificationStatus !== manifest.classificationStatus)
        ) {
          add('STATUS_MISMATCH', `${name} 的状态三元组与 manifest 不一致`, name);
        }
      }
    }

    // dossier 与 ai/index 的证据 ID / 路径引用闭环。
    for (const [index, step] of (dossier?.candidateChain || []).entries()) {
      for (const evidenceId of step.evidenceIds || []) {
        if (!knownIds.has(evidenceId)) {
          add('UNKNOWN_EVIDENCE_ID', `dossier 第 ${index} 步引用未知 ID：${evidenceId}`, 'ai/adapter-dossier.json');
        }
      }
      for (const evidencePath of step.evidencePaths || []) {
        if (!has(evidencePath)) {
          add('UNKNOWN_EVIDENCE_ID', `dossier 第 ${index} 步引用的文件缺失：${evidencePath}`, 'ai/adapter-dossier.json');
        }
      }
    }
    const aiIndexLists: Array<[string, string[] | undefined]> = aiIndex
      ? [
          ['loginCandidateRequestIds', aiIndex.loginCandidateRequestIds],
          ['kvmLaunchCandidateRequestIds', aiIndex.kvmLaunchCandidateRequestIds],
          ['viewerTargetIds', aiIndex.viewerTargetIds],
          ['dynamicScriptIds', aiIndex.dynamicScriptIds],
          ['workerIds', aiIndex.workerIds],
          ['wasmIds', aiIndex.wasmIds],
          ['websocketChannelIds', aiIndex.websocketChannelIds],
          ['webrtcChannelIds', aiIndex.webrtcChannelIds],
          ['webtransportChannelIds', aiIndex.webtransportChannelIds],
        ]
      : [];
    for (const [name, ids] of aiIndexLists) {
      for (const id of ids || []) {
        if (!knownIds.has(id)) {
          add('UNKNOWN_EVIDENCE_ID', `ai/index.json ${name} 引用未知 ID：${id}`, 'ai/index.json');
        }
      }
    }
  }

  // ---- 7. checksums.sha256 ----
  if (options.requireChecksumFile !== false) {
    const checksumText = textOf(CHECKSUM_FILE);
    if (checksumText === null) {
      add('REQUIRED_FILE_MISSING', CHECKSUM_FILE, CHECKSUM_FILE);
    } else {
      const entries = new Map<string, string>();
      for (const line of checksumText.split('\n')) {
        if (!line.trim()) continue;
        const separator = line.indexOf('  ');
        if (separator <= 0) {
          add('CHECKSUM_MISMATCH', `checksums.sha256 行格式非法：${line}`, CHECKSUM_FILE);
          continue;
        }
        const entryPath = line.slice(separator + 2).trim();
        if (entries.has(entryPath)) {
          add('CHECKSUM_MISMATCH', `checksums.sha256 存在重复条目：${entryPath}`, CHECKSUM_FILE);
          continue;
        }
        entries.set(entryPath, line.slice(0, separator));
      }
      const expectedPaths = artifacts
        .map(artifact => artifact.path)
        .filter(path => path !== CHECKSUM_FILE);
      for (const path of expectedPaths) {
        if (!entries.has(path)) {
          add('CHECKSUM_MISSING_ENTRY', `checksums.sha256 缺少 ${path}`, CHECKSUM_FILE);
          continue;
        }
        if (entries.get(path) !== shaOf(path)) {
          add('CHECKSUM_MISMATCH', `${path} 的 sha256 与 checksums.sha256 不一致`, path);
        }
      }
      for (const path of entries.keys()) {
        if (!byPath.has(path)) {
          add('CHECKSUM_EXTRA_ENTRY', `checksums.sha256 含包内不存在的文件：${path}`, CHECKSUM_FILE);
        }
      }
    }
  }

  // ---- 8. 包内 Schema 自校验（规范 §14 条件 10） ----
  if (options.requireSchemaValidation !== false) {
    const packSchemas = new Map<string, string>();
    for (const artifact of artifacts) {
      if (artifact.path.startsWith('schema/') && artifact.path.endsWith('.schema.json')) {
        packSchemas.set(artifact.path.slice('schema/'.length), textOf(artifact.path) || '');
      }
    }
    // 预期 Schema 必须全部在场：缺任意一个都视为自校验不通过，
    // 不允许因缺 Schema 而静默跳过对应文件的校验。
    const expectedSchemaNames = [...new Set(SCHEMA_TARGETS.map(target => target.schema))];
    if (packSchemas.size === 0) {
      add('PACK_SCHEMA_MISSING', '包内 schema/ 目录没有任何 Schema 副本，无法执行自校验', 'schema');
    } else {
      for (const name of expectedSchemaNames) {
        if (!packSchemas.has(name)) {
          add('PACK_SCHEMA_MISSING', `包内 schema/ 缺少 Schema 副本：${name}`, `schema/${name}`);
        }
      }
    }
    if (packSchemas.size > 0) {
      const ajv = new Ajv({
        allErrors: true,
        strict: false,
        validateFormats: false,
        allowUnionTypes: true,
      });
      // 按文件名保存编译出的验证函数：后续校验只按文件名取用，
      // 不再依赖 Schema 自带的 $id 注册表，避免 $id 缺失/篡改导致静默跳过。
      const validators = new Map<string, (data: unknown) => boolean>();
      let compiled = true;
      for (const [name, schemaText] of packSchemas) {
        const expectedId = `${SCHEMA_ID_PREFIX}/${name}`;
        let parsed: unknown;
        try {
          parsed = JSON.parse(schemaText);
        } catch (error) {
          add(
            'SCHEMA_VIOLATION',
            `包内 Schema ${name} 无法解析为 JSON：${error instanceof Error ? error.message : String(error)}`,
            `schema/${name}`,
          );
          compiled = false;
          continue;
        }
        const actualId = (parsed as { $id?: unknown } | null)?.$id;
        if (actualId !== expectedId) {
          add(
            'SCHEMA_VIOLATION',
            `包内 Schema ${name} 的 $id 必须是 ${expectedId}，实际为 ${JSON.stringify(actualId) ?? 'undefined'}`,
            `schema/${name}`,
          );
          compiled = false;
          continue;
        }
        try {
          validators.set(name, ajv.compile(parsed as object) as (data: unknown) => boolean);
        } catch (error) {
          add(
            'SCHEMA_VIOLATION',
            `包内 Schema ${name} 无法编译：${error instanceof Error ? error.message : String(error)}`,
            `schema/${name}`,
          );
          compiled = false;
        }
      }
      if (compiled) {
        for (const [path] of byPath) {
          const target = schemaFor(path);
          // Schema 缺失时已在上方报告 PACK_SCHEMA_MISSING；此处只校验 Schema 在场的文件，
          // 不再因缺 Schema 静默放过额外问题（checksums / 状态检查仍独立生效）。
          if (!target || !packSchemas.has(target.schema)) continue;
          // raw journal 内容校验被委托给流式通道（哈希背书工件没有内容可解析）。
          if (skipRawJournalContent && isRawJournalPath(path)) continue;
          const validate = validators.get(target.schema);
          if (!validate) {
            // 理论上不可达（$id/编译失败会先报 SCHEMA_VIOLATION）；
            // 防御性报错：验证函数缺失时禁止静默跳过该文件。
            add(
              'SCHEMA_VIOLATION',
              `无法获得 ${target.schema} 的验证函数，拒绝在未校验的情况下放行 ${path}`,
              path,
            );
            continue;
          }
          const values = target.jsonl ? jsonlOf(path) : [jsonOf(path)];
          for (const value of values) {
            if (value === undefined) continue;
            const valid = validate(value);
            if (!valid) {
              const errors = (validate as unknown as { errors?: Array<{ instancePath?: string; message?: string }> })
                .errors;
              const firstError = (errors || [])[0];
              add(
                'SCHEMA_VIOLATION',
                `${path} 不符合 ${target.schema}：${firstError ? `${firstError.instancePath || '/'} ${firstError.message || ''}` : 'invalid'}`,
                path,
              );
              break;
            }
          }
        }
      }
    }
  }

  return { valid: problems.length === 0, problems };
}
