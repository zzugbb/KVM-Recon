/**
 * 无界 raw journal 的流式内容校验（阶段 1 导出门禁，规范 §9 磁盘优先）。
 *
 * 元数据/索引规模的结构化文件（catalog、replay、ai、状态、Schema 副本）
 * 由 validatePackV2Consistency 在内存校验；CDP journal、NetLog、HTTP 事务、
 * 浏览器/实时/运行时 JSONL、WS 帧索引这类无界原始日志在这里逐行流式校验：
 * 逐行 JSON 解析 + 按包内 Schema 副本的 Ajv 校验 + 各自领域检查
 * （seq 递增、帧偏移与计数、通道↔事件关联、BodyRef 闭环、空 journal 检测），
 * 并把行内稳定 ID 收集回传给元数据校验（knownIds 闭合同一语义）。
 * NetLog 用 stream-json 严格校验「恰好一个完整根对象」的 JSON 语法。
 *
 * 内存上界 = 最大单行 + 通道/索引等小元数据，绝不整文件载入；通道关联用
 * 集合（O(不同 ID) 而非 O(行数)），问题列表上限 200 项并明确截断。
 * 仍驻留内存的跨文件闭包索引（catalog/resources、catalog/relations、
 * replay/http、ai/value-flow）是 O(不同事实数) 的元数据——磁盘化跨文件
 * 索引属于阶段 3 证据图（规范 §18/§19），不在阶段 1 范围。
 * path→Schema 映射复用 packV2Consistency 的同一事实源（单一实现）。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import Ajv from 'ajv';
import { parser } from 'stream-json';

import {
  packV2SchemaTargetFor,
  isRawJournalPath,
  SCHEMA_ID_PREFIX,
} from '../capture-pack-v2/packV2Consistency';
import type { ZipArtifact } from './exportPackV2Zip';

export interface RawJournalProblem {
  code: string;
  detail: string;
  path?: string;
}

export interface StreamedRawJournalInput {
  artifacts: ReadonlyArray<ZipArtifact>;
  /** 预计算 SHA-256（与 checksums 一致），供 BodyRef 比对。 */
  sha256ByPath: ReadonlyMap<string, string>;
  /** 预计算字节数，供 BodyRef / frames.bin 长度比对。 */
  bytesByPath: ReadonlyMap<string, number>;
}

export interface StreamedRawJournalResult {
  problems: RawJournalProblem[];
  /** raw journal 行内的稳定 ID（actions/sse/downloads/crypto/webrtc/webtransport）。 */
  rawJournalIds: Set<string>;
}

async function artifactBytes(artifact: ZipArtifact): Promise<Buffer> {
  if (artifact.source.kind === 'bytes') {
    return typeof artifact.source.data === 'string'
      ? Buffer.from(artifact.source.data, 'utf8')
      : Buffer.from(artifact.source.data);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(artifact.source.absolutePath)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** 读取工件字节（大索引流式通道复用：Schema 副本属元数据规模，可整体读）。 */
export async function readArtifactBytes(artifact: ZipArtifact): Promise<Buffer> {
  return artifactBytes(artifact);
}

/** 按行流式读取（file 源流式；bytes 源本身就在内存）。 */
export async function* linesOf(artifact: ZipArtifact): AsyncIterable<string> {
  if (artifact.source.kind === 'file') {
    const input = createReadStream(artifact.source.absolutePath, { encoding: 'utf8' });
    const reader = createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      yield line;
    }
  } else {
    const text =
      typeof artifact.source.data === 'string'
        ? artifact.source.data
        : Buffer.from(artifact.source.data).toString('utf8');
    for (const line of text.split('\n')) {
      yield line;
    }
  }
}

interface CompiledSchemas {
  validators: Map<string, (data: unknown) => boolean>;
}
/** 从包内 Schema 副本编译目标校验器（副本 $id/编译问题由元数据校验报告）。 */
export async function compileTargetSchemas(
  artifacts: ReadonlyArray<ZipArtifact>,
): Promise<CompiledSchemas> {
  const copies = new Map<string, Buffer>();
  for (const artifact of artifacts) {
    if (!artifact.path.startsWith('schema/') || !artifact.path.endsWith('.schema.json')) continue;
    copies.set(artifact.path.slice('schema/'.length), await artifactBytes(artifact));
  }
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, allowUnionTypes: true });
  const validators = new Map<string, (data: unknown) => boolean>();
  for (const [name, bytes] of copies) {
    // 与元数据校验一致：$id 必须与文件名对应，否则不编译（问题由元数据校验报告）。
    const parsed = JSON.parse(bytes.toString('utf8')) as { $id?: unknown } & object;
    if ((parsed as { $id?: unknown }).$id !== `${SCHEMA_ID_PREFIX}/${name}`) continue;
    validators.set(name, ajv.compile(parsed as object) as (data: unknown) => boolean);
  }
  return { validators };
}

interface BodyRefLike {
  sha256?: string;
  bytes?: number;
  path?: string;
}

interface ChannelLike {
  id?: string;
  kind?: string;
  url?: string;
  payloadPath?: string;
  frameCounts?: { up?: number; down?: number };
}

export async function streamValidateRawJournals(
  input: StreamedRawJournalInput,
): Promise<StreamedRawJournalResult> {
  const { artifacts, sha256ByPath, bytesByPath } = input;
  const problems: RawJournalProblem[] = [];
  const rawJournalIds = new Set<string>();
  const paths = new Set(artifacts.map(artifact => artifact.path));
  const compiled = await compileTargetSchemas(artifacts);

  // 错误数量上限：坏包可能产生海量问题，只保留前 MAX_PROBLEMS 项并明确
  // 截断（定位足够，不无限驻留内存）。
  const MAX_PROBLEMS = 200;
  let truncated = false;
  const add = (code: string, detail: string, path?: string) => {
    if (problems.length < MAX_PROBLEMS) {
      problems.push({ code, detail, ...(path ? { path } : {}) });
    } else if (!truncated) {
      truncated = true;
      problems.push({
        code: 'PROBLEM_LIST_TRUNCATED',
        detail: `校验问题超过 ${MAX_PROBLEMS} 项，其余问题已截断`,
      });
    }
  };
  const has = (path: string) => paths.has(path);
  const checkBodyRef = (ref: BodyRefLike | undefined, owner: string, code: string) => {
    if (!ref || !ref.path) return;
    if (!has(ref.path)) {
      add(code, `${owner} 引用的正文文件缺失：${ref.path}`, ref.path);
      return;
    }
    const actualSha = sha256ByPath.get(ref.path);
    if (ref.sha256 && actualSha && actualSha !== ref.sha256) {
      add('BODY_HASH_MISMATCH', `${owner} 引用的 ${ref.path} sha256 不一致`, ref.path);
    }
    const actualBytes = bytesByPath.get(ref.path);
    if (ref.bytes !== undefined && actualBytes !== undefined && actualBytes !== ref.bytes) {
      add(
        'BODY_HASH_MISMATCH',
        `${owner} 引用的 ${ref.path} 字节数 ${actualBytes} != ${ref.bytes}`,
        ref.path,
      );
    }
  };

  /** 逐行 JSONL：解析 + Schema 校验 + 逐行回调；返回行数。 */
  const forEachJsonlRow = async (
    artifact: ZipArtifact,
    schemaName: string,
    onRow: (row: Record<string, unknown>, lineIndex: number) => void,
  ): Promise<number> => {
    const validate = compiled.validators.get(schemaName);
    let rowCount = 0;
    let lineIndex = 0;
    for await (const line of linesOf(artifact)) {
      const index = lineIndex;
      lineIndex += 1;
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (error) {
        add(
          'PARSE_ERROR',
          `${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
          artifact.path,
        );
        continue;
      }
      const record = (row ?? {}) as Record<string, unknown>;
      if (validate && !validate(record)) {
        const v = validate as unknown as { errors?: Array<{ instancePath?: string; message?: string }> };
        const firstError = (v.errors || [])[0];
        add(
          'SCHEMA_VIOLATION',
          `${artifact.path} 第 ${index} 行不符合 ${schemaName}：${
            firstError ? `${firstError.instancePath || '/'} ${firstError.message || ''}` : 'invalid'
          }`,
          artifact.path,
        );
      }
      onRow(record, index);
      rowCount += 1;
    }
    return rowCount;
  };

  const byPath = new Map(artifacts.map(artifact => [artifact.path, artifact]));
  const channelsJson = byPath.has('catalog/channels.json')
    ? (JSON.parse((await artifactBytes(byPath.get('catalog/channels.json')!)).toString('utf8')) as {
        channels?: ChannelLike[];
      })
    : { channels: [] };
  const channels = channelsJson.channels || [];

  let transactionCount = 0;

  // ---- 事务 / crypto / 实时 / 浏览器 / 帧索引行 ----
  for (const artifact of artifacts) {
    if (!isRawJournalPath(artifact.path)) continue;
    const target = packV2SchemaTargetFor(artifact.path);
    if (artifact.path === 'raw/netlog/netlog.json') {
      continue; // NetLog 在事务计数完成后单独校验（RAW_JOURNAL_EMPTY 依赖计数）。
    }
    if (artifact.path === 'raw/cdp/events.jsonl' || artifact.path === 'raw/cdp/commands.jsonl') {
      continue; // CDP journal 由下方专用循环单遍处理（避免整份日志被读取两遍）。
    }
    if (!target || !target.jsonl) continue;

    if (artifact.path === 'raw/http/transactions.jsonl') {
      transactionCount = await forEachJsonlRow(artifact, target.schema, row => {
        checkBodyRef(
          row.requestBody as BodyRefLike | undefined,
          `事务 ${String(row.id)}`,
          'DANGLING_BODY_REF',
        );
        checkBodyRef(
          row.responseBody as BodyRefLike | undefined,
          `事务 ${String(row.id)}`,
          'DANGLING_BODY_REF',
        );
      });
    } else if (artifact.path === 'raw/runtime/crypto.jsonl') {
      await forEachJsonlRow(artifact, target.schema, row => {
        if (typeof row.id === 'string') rawJournalIds.add(row.id);
        checkBodyRef(
          row.inputRef as BodyRefLike | undefined,
          `crypto ${String(row.id)} 输入`,
          'DANGLING_BODY_REF',
        );
        checkBodyRef(
          row.outputRef as BodyRefLike | undefined,
          `crypto ${String(row.id)} 输出`,
          'DANGLING_BODY_REF',
        );
      });
    } else if (artifact.path === 'raw/realtime/webrtc.jsonl') {
      const peerIds = new Set<unknown>();
      await forEachJsonlRow(artifact, target.schema, row => {
        peerIds.add(row.peerConnectionId);
        checkBodyRef(
          row.messageRef as BodyRefLike | undefined,
          `WebRTC 消息 ${String(row.peerConnectionId)}`,
          'DANGLING_BODY_REF',
        );
      });
      for (const channel of channels) {
        if (channel.kind === 'webrtc' && !peerIds.has(channel.id)) {
          add(
            'CHANNEL_EVENT_MISSING',
            `catalog 中存在 WebRTC 通道 ${channel.id}，但 raw/realtime/webrtc.jsonl 没有任何对应记录`,
            'raw/realtime/webrtc.jsonl',
          );
        }
      }
    } else if (artifact.path === 'raw/realtime/webtransport.jsonl') {
      const transportIds = new Set<unknown>();
      await forEachJsonlRow(artifact, target.schema, row => {
        transportIds.add(row.transportId);
        checkBodyRef(
          row.messageRef as BodyRefLike | undefined,
          `WebTransport 消息 ${String(row.transportId)}`,
          'DANGLING_BODY_REF',
        );
      });
      for (const channel of channels) {
        if (channel.kind === 'webtransport' && !transportIds.has(channel.id)) {
          add(
            'CHANNEL_EVENT_MISSING',
            `catalog 中存在 WebTransport 通道 ${channel.id}，但 raw/realtime/webtransport.jsonl 没有任何对应记录`,
            'raw/realtime/webtransport.jsonl',
          );
        }
      }
    } else if (artifact.path === 'raw/realtime/sse.jsonl') {
      const urls = new Set<unknown>();
      await forEachJsonlRow(artifact, target.schema, row => {
        urls.add(row.url);
        if (typeof row.id === 'string') rawJournalIds.add(row.id);
        checkBodyRef(
          row.dataRef as BodyRefLike | undefined,
          `SSE 数据 ${String(row.id)}`,
          'DANGLING_BODY_REF',
        );
      });
      for (const channel of channels) {
        if (channel.kind === 'sse' && !urls.has(channel.url)) {
          add(
            'CHANNEL_EVENT_MISSING',
            `catalog 中存在 SSE 通道 ${channel.id}，但 raw/realtime/sse.jsonl 没有任何对应记录`,
            'raw/realtime/sse.jsonl',
          );
        }
      }
    } else if (artifact.path === 'raw/realtime/downloads.jsonl') {
      const urls = new Set<unknown>();
      await forEachJsonlRow(artifact, target.schema, row => {
        urls.add(row.url);
        if (typeof row.id === 'string') rawJournalIds.add(row.id);
        checkBodyRef(
          row.fileRef as BodyRefLike | undefined,
          `下载 ${String(row.id)}`,
          'DANGLING_BODY_REF',
        );
      });
      for (const channel of channels) {
        if (channel.kind === 'download' && !urls.has(channel.url)) {
          add(
            'CHANNEL_EVENT_MISSING',
            `catalog 中存在下载通道 ${channel.id}，但 raw/realtime/downloads.jsonl 没有任何对应记录`,
            'raw/realtime/downloads.jsonl',
          );
        }
      }
    } else if (artifact.path === 'raw/browser/actions.jsonl') {
      await forEachJsonlRow(artifact, target.schema, row => {
        if (typeof row.id === 'string') rawJournalIds.add(row.id);
      });
    } else if (/^raw\/websocket\/[^/]+\/frames\.index\.jsonl$/.test(artifact.path)) {
      await validateFramesIndex(artifact, target.schema);
    } else {
      // console / timeline 等：解析 + Schema（领域检查与元数据校验一致）。
      await forEachJsonlRow(artifact, target.schema, () => {});
    }
  }

  // ---- CDP journal：seq 严格递增 + method 字符串 + 空 journal 检测 ----
  for (const artifact of artifacts) {
    if (artifact.path !== 'raw/cdp/events.jsonl' && artifact.path !== 'raw/cdp/commands.jsonl') {
      continue;
    }
    const target = packV2SchemaTargetFor(artifact.path)!;
    const validate = compiled.validators.get(target.schema);
    let lastSeq = 0;
    let rowCount = 0;
    let lineIndex = 0;
    for await (const line of linesOf(artifact)) {
      const index = lineIndex;
      lineIndex += 1;
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (error) {
        add(
          'PARSE_ERROR',
          `${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
          artifact.path,
        );
        continue;
      }
      const record = (row ?? {}) as Record<string, unknown>;
      if (validate && !validate(record)) {
        const v = validate as unknown as { errors?: Array<{ instancePath?: string; message?: string }> };
        const firstError = (v.errors || [])[0];
        add(
          'SCHEMA_VIOLATION',
          `${artifact.path} 第 ${index} 行不符合 ${target.schema}：${
            firstError ? `${firstError.instancePath || '/'} ${firstError.message || ''}` : 'invalid'
          }`,
          artifact.path,
        );
      }
      const seq = record.seq;
      if (typeof seq !== 'number' || seq <= lastSeq) {
        add('RAW_JOURNAL_INVALID', `${artifact.path} 第 ${index} 行 seq 不严格递增：${String(seq)}`, artifact.path);
        break;
      }
      lastSeq = seq;
      if (typeof record.method !== 'string') {
        add('RAW_JOURNAL_INVALID', `${artifact.path} 第 ${index} 行缺少 method`, artifact.path);
        break;
      }
      rowCount += 1;
    }
    if (rowCount === 0 && transactionCount > 0) {
      add('RAW_JOURNAL_EMPTY', `${artifact.path} 为空但包内存在 ${transactionCount} 个 HTTP 事务`, artifact.path);
    }
  }

  // ---- NetLog：在事务计数完成后校验（RAW_JOURNAL_EMPTY 依赖计数） ----
  for (const artifact of artifacts) {
    if (artifact.path === 'raw/netlog/netlog.json') {
      await validateNetlog(artifact);
    }
  }

  // ---- WS 帧索引：偏移连续性 + frames.bin 越界/总长 + 方向计数 ----
  async function validateFramesIndex(artifact: ZipArtifact, schemaName: string): Promise<void> {
    const channelDir = artifact.path.replace(/\/[^/]*$/, '');
    const payloadPath = `${channelDir}/frames.bin`;
    const channel = channels.find(candidate => candidate.payloadPath === payloadPath);
    const framesBinBytes = bytesByPath.get(payloadPath) ?? 0;
    let expectedOffset = 0;
    let upCount = 0;
    let downCount = 0;
    await forEachJsonlRow(artifact, schemaName, (row, index) => {
      const frame = row as {
        frameIndex?: unknown;
        payloadOffset?: unknown;
        payloadLength?: unknown;
        direction?: unknown;
      };
      const label = channel?.id ?? channelDir;
      if (frame.frameIndex !== index) {
        add(
          'FRAME_OFFSET_MISMATCH',
          `通道 ${label} 第 ${index} 行 frameIndex 不连续：${String(frame.frameIndex)}`,
          artifact.path,
        );
      }
      if (frame.payloadOffset !== expectedOffset) {
        add(
          'FRAME_OFFSET_MISMATCH',
          `通道 ${label} 第 ${index} 帧 payloadOffset ${String(frame.payloadOffset)} != 期望 ${expectedOffset}`,
          artifact.path,
        );
      }
      if (
        typeof frame.payloadOffset === 'number' &&
        typeof frame.payloadLength === 'number' &&
        frame.payloadOffset + frame.payloadLength > framesBinBytes
      ) {
        add(
          'FRAME_OFFSET_MISMATCH',
          `通道 ${label} 第 ${index} 帧越界：${frame.payloadOffset}+${frame.payloadLength} > ${framesBinBytes}`,
          artifact.path,
        );
      }
      if (typeof frame.payloadLength === 'number') expectedOffset += frame.payloadLength;
      if (frame.direction === 'up') upCount += 1;
      else downCount += 1;
    });
    // 无条件比较总长：空索引 + 非空 frames.bin 也是不一致（完整度缺口），
    // 不允许「清空索引仍导出 COMPLETE」。
    if (expectedOffset !== framesBinBytes) {
      add(
        'FRAME_OFFSET_MISMATCH',
        `通道 ${channel?.id ?? channelDir} 帧总长 ${expectedOffset} != frames.bin ${framesBinBytes}`,
        artifact.path,
      );
    }
    if (
      channel?.frameCounts &&
      (channel.frameCounts.up !== upCount || channel.frameCounts.down !== downCount)
    ) {
      add(
        'CHANNEL_COUNT_MISMATCH',
        `通道 ${channel.id} 计数 up/down ${channel.frameCounts.up}/${channel.frameCounts.down} != 索引 ${upCount}/${downCount}`,
      );
    }
  }

  /**
   * NetLog：用成熟流式 JSON parser（stream-json）逐 token 校验——它严格
   * 保证「恰好一个完整根对象」的 JSON 语法（尾部垃圾/第二个根/未闭合
   * 一律报错），此基础上再做 Schema 字段与事件逐项检查：
   * - 顶层 schemaVersion 必须是 "2.0.0"、captureMode 非空、events 必须是数组；
   * - events 数组元素必须是对象；事件计数用于空 journal 检测。
   * 内存 O(1)：token 流式消费，不整文件载入。
   */
  async function validateNetlog(artifact: ZipArtifact): Promise<void> {
    const source: AsyncIterable<string> =
      artifact.source.kind === 'file'
        ? createReadStream(artifact.source.absolutePath, { encoding: 'utf8' })
        : Readable.from([
            typeof artifact.source.data === 'string'
              ? artifact.source.data
              : Buffer.from(artifact.source.data).toString('utf8'),
          ]);

    const p = parser.asStream();
    let depth = 0;
    let eventsDepth = -1;
    let eventsElementDepth = -1;
    let expectElement = false;
    let pendingTopKey: 'schemaVersion' | 'captureMode' | 'events' | null = null;
    let awaitingKeyValue = false;
    let sawEventsKey = false;
    let eventsIsNotArray = false;
    let nonObjectElement = false;
    let schemaVersion: string | null = null;
    let captureMode = '';
    let eventsCount = 0;
    let parseError: string | null = null;

    const handleToken = (tok: { name: string; value?: unknown }) => {
      switch (tok.name) {
        case 'startObject': {
          depth += 1;
          if (eventsDepth >= 0 && depth === eventsDepth + 1 && expectElement) {
            eventsElementDepth = depth;
            expectElement = false;
          }
          if (pendingTopKey === 'events' && eventsDepth === -1) {
            eventsIsNotArray = true;
            pendingTopKey = null;
          }
          break;
        }
        case 'endObject': {
          if (eventsDepth >= 0 && depth === eventsElementDepth) {
            eventsCount += 1;
            eventsElementDepth = -1;
            expectElement = true;
          }
          depth -= 1;
          break;
        }
        case 'startArray': {
          depth += 1;
          if (pendingTopKey === 'events' && depth === 2) {
            eventsDepth = depth;
            expectElement = true;
            pendingTopKey = null;
          }
          if (eventsDepth >= 0 && depth === eventsDepth + 1 && expectElement) {
            nonObjectElement = true;
            expectElement = false;
          }
          break;
        }
        case 'endArray': {
          if (eventsDepth >= 0 && depth === eventsDepth) {
            eventsDepth = -1;
            expectElement = false;
          }
          depth -= 1;
          break;
        }
        case 'keyValue': {
          if (depth === 1) {
            if (tok.value === 'schemaVersion' || tok.value === 'captureMode') {
              pendingTopKey = tok.value;
              awaitingKeyValue = true;
            } else if (tok.value === 'events') {
              pendingTopKey = 'events';
              awaitingKeyValue = false;
              sawEventsKey = true;
            } else {
              pendingTopKey = null;
              awaitingKeyValue = false;
            }
          }
          break;
        }
        default: {
          // 只处理终结值 token（stringValue / numberValue / trueValue ...），
          // 字符串/键的中间 token（startString / stringChunk / endString）
          // 不参与判定，否则会把 awaitingKeyValue 误清。
          const isValueToken =
            tok.name === 'stringValue' ||
            tok.name === 'numberValue' ||
            tok.name === 'trueValue' ||
            tok.name === 'falseValue' ||
            tok.name === 'nullValue';
          if (!isValueToken) break;
          if (awaitingKeyValue && depth === 1) {
            if (tok.name === 'stringValue') {
              if (pendingTopKey === 'schemaVersion') schemaVersion = String(tok.value);
              else if (pendingTopKey === 'captureMode') captureMode = String(tok.value);
            } else {
              // 值不是字符串：schema 违反 minLength/type。
              if (pendingTopKey === 'schemaVersion') schemaVersion = '';
              else captureMode = '';
            }
            awaitingKeyValue = false;
          } else if (pendingTopKey === 'events' && depth === 1) {
            eventsIsNotArray = true;
            pendingTopKey = null;
          } else if (eventsDepth >= 0 && depth === eventsDepth && expectElement) {
            nonObjectElement = true;
            expectElement = false;
          }
          break;
        }
      }
    };

    // pipeline() 保证源流错误（文件缺失/读取失败）作为正常的 reject 返回，
    // 不会以未处理 error 崩溃 Node 进程。
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = (error?: string) => {
        if (!settled) {
          settled = true;
          if (error) parseError = error;
          resolve();
        }
      };
      p.on('data', (tok: { name: string; value?: unknown }) => {
        try {
          handleToken(tok);
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
          p.destroy();
        }
      });
      p.on('error', error => finish(error instanceof Error ? error.message : String(error)));
      p.on('end', () => finish());
      void pipeline(Readable.from(source), p).catch(error => {
        finish(error instanceof Error ? error.message : String(error));
      });
    });

    if (schemaVersion !== '2.0.0') {
      add('SCHEMA_VIOLATION', 'raw/netlog/netlog.json 的 schemaVersion 必须是 2.0.0', artifact.path);
    }
    if (captureMode.length === 0) {
      add('SCHEMA_VIOLATION', 'raw/netlog/netlog.json 缺少非空 captureMode', artifact.path);
    }
    if (!sawEventsKey || eventsIsNotArray) {
      add('SCHEMA_VIOLATION', 'raw/netlog/netlog.json 的 events 必须是数组', artifact.path);
    }
    if (nonObjectElement) {
      add('SCHEMA_VIOLATION', 'raw/netlog/netlog.json 的 events 数组元素必须是对象', artifact.path);
    }
    if (parseError) {
      add('PARSE_ERROR', `raw/netlog/netlog.json: ${parseError}`, artifact.path);
    }
    if (eventsCount === 0 && transactionCount > 0) {
      add('RAW_JOURNAL_EMPTY', 'raw/netlog/netlog.json 没有任何事件但包内存在 HTTP 事务', artifact.path);
    }
  }

  return { problems, rawJournalIds };
}
