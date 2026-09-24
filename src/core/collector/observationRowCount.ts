/**
 * 工作区观察事实行数（事务 / 通道 / 动作）——「零观察事实」丢弃放宽的
 * 单一判定源。
 *
 * 红线：未导出的现场资料必须保留；零观察事实（无事务行 / 无通道行 /
 * 无动作行）= 没有现场资料，允许不导出直接丢弃（诊断随判定消息显式
 * 记账，无记账的静默丢弃等于编造）。
 *
 * 流式计数（内存上界 = 单块 / 单 token，不整体载入文件）：
 * - raw/http/transactions.jsonl 与 raw/browser/actions.jsonl：非空行数；
 * - catalog/channels.json：顶层 channels 数组的元素个数。
 * 文件缺失 = 0 行（该观察面未产生任何事实）。打开或解析失败 = -1
 * （行数不可读）：不能证明零观察就不放宽丢弃（宁可保留，不可错删）。
 */

import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { parser } from 'stream-json';

import type { PackArtifactReader } from '../capture-pack-v2/readPackFacts';

/** 行数不可读（保守方向：视作非零，拒绝丢弃放宽）。 */
export const OBSERVATION_ROWS_UNKNOWN = -1;

export interface ObservationRowCounts {
  transactions: number;
  channels: number;
  actions: number;
}

export function isZeroObservation(counts: ObservationRowCounts): boolean {
  return counts.transactions === 0 && counts.channels === 0 && counts.actions === 0;
}

interface Token {
  name: string;
  value?: unknown;
}

const isValueToken = (name: string): boolean =>
  name === 'stringValue' ||
  name === 'numberValue' ||
  name === 'trueValue' ||
  name === 'falseValue' ||
  name === 'nullValue';

async function artifactExists(reader: PackArtifactReader, path: string): Promise<boolean | null> {
  try {
    return (await reader.artifactPaths()).includes(path);
  } catch {
    return null;
  }
}

async function countJsonlRows(reader: PackArtifactReader, path: string): Promise<number> {
  const exists = await artifactExists(reader, path);
  if (exists === null) return OBSERVATION_ROWS_UNKNOWN;
  if (!exists) return 0;
  try {
    const stream = await reader.openArtifactStream(path);
    let count = 0;
    let rest = '';
    for await (const chunk of stream) {
      const text = rest + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      // 残行拼接：块边界切开的行不重复计数
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) count += 1;
      }
    }
    if (rest.trim()) count += 1;
    return count;
  } catch {
    return OBSERVATION_ROWS_UNKNOWN;
  }
}

/**
 * 顶层 `key` 数组的元素个数（流式 token 走查；重复键 last-wins，
 * 重开数组即清空先前计数）。根缺失 / channels 值不是数组 / 非法 JSON
 * 抛错，由调用方按行数不可读处理。
 */
async function countTopLevelArrayElements(source: Readable, key: string): Promise<number> {
  const p = parser.asStream();
  let sawRoot = false;
  let depth = 0;
  let topKey: string | null = null;
  let counting = false;
  let count = 0;
  p.on('data', (tok: Token) => {
    switch (tok.name) {
      case 'startObject':
      case 'startArray': {
        // channels 键的值不是数组（对象等畸形形态）：行数不可证明为零，
        // 抛错走不可读分支；根不是对象同样不可读（顶层 channels 找不到）
        if (depth === 1 && topKey === key && tok.name !== 'startArray') {
          throw new Error(`${key} 不是数组`);
        }
        if (depth === 0 && tok.name !== 'startObject') {
          throw new Error('JSON 根不是对象');
        }
        depth += 1;
        if (depth === 1) {
          sawRoot = true;
          return;
        }
        if (depth === 2 && topKey === key) {
          counting = true;
          count = 0;
          return;
        }
        if (counting && depth === 3 && tok.name === 'startObject') count += 1;
        return;
      }
      case 'endObject':
      case 'endArray': {
        if (depth === 2 && counting && tok.name === 'endArray') counting = false;
        if (depth === 1) topKey = null;
        depth -= 1;
        return;
      }
      case 'keyValue': {
        if (depth === 1) topKey = String(tok.value);
        return;
      }
      default: {
        // channels 键的值是标量（null / 字符串等，到达时仍在 depth 1）：
        // 行数不可证明为零，抛错走不可读分支
        if (depth === 1 && topKey === key && isValueToken(tok.name)) {
          throw new Error(`${key} 不是数组`);
        }
        return;
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    p.on('error', (error: Error) => finish(error));
    p.on('end', () => finish());
    void pipeline(source, p).catch((error: Error) => finish(error));
  });
  if (!sawRoot) {
    throw new Error('JSON 文档为空或不可解析');
  }
  return count;
}

async function countChannelRows(reader: PackArtifactReader): Promise<number> {
  const path = 'catalog/channels.json';
  const exists = await artifactExists(reader, path);
  if (exists === null) return OBSERVATION_ROWS_UNKNOWN;
  if (!exists) return 0;
  try {
    const stream = await reader.openArtifactStream(path);
    return await countTopLevelArrayElements(stream, 'channels');
  } catch {
    return OBSERVATION_ROWS_UNKNOWN;
  }
}

/** 数观察事实行数：事务 / 通道 / 动作（丢弃门禁的判定输入）。 */
export async function countObservationRows(reader: PackArtifactReader): Promise<ObservationRowCounts> {
  const [transactions, actions, channels] = await Promise.all([
    countJsonlRows(reader, 'raw/http/transactions.jsonl'),
    countJsonlRows(reader, 'raw/browser/actions.jsonl'),
    countChannelRows(reader),
  ]);
  return { transactions, channels, actions };
}
