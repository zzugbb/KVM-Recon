/**
 * raw/browser/storage.json 的流式事实提取（规范 §8.3，阶段 6 刀 1）。
 *
 * storage.json 的 indexedDb records 内联无上界（零截断红线不允许写盘裁剪），
 * 而证据图只消费 cookie 对、sessionStorage / localStorage 值与 capturedAt
 * （valueFlowEngine 的观察事实）。因此用 stream-json 逐 token 走查：
 * 只跟踪被消费字段的键值（单 cookie 对 / 单 storage 值），indexedDb /
 * cacheStorage / additionalContexts 的内容整块跳过——内存上界 = 单个
 * token，绝不整体载入文件。
 *
 * 语义与整读 JSON.parse 等价（被消费字段）：
 * - 重复键 last-wins（storage 对象按源内 Map 去重、cookies 数组重开时清空）；
 * - 非法类型条目跳过（cookie 缺 name/value 字符串、storage 值非字符串）；
 * - 空输入 / 非法 JSON / 多根一律抛错（读取失败由调用方显式记账降级，
 *   不允许静默当作空快照）。
 */

import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { parser } from 'stream-json';

import type {
  ValueFlowCookieFact,
  ValueFlowStorageValueFact,
} from './valueFlowEngine';

export interface StorageSnapshotFacts {
  /** 快照时间（缺省 / 非字符串时为 null，由调用方决定回退值）。 */
  capturedAt: string | null;
  storageCookies: ValueFlowCookieFact[];
  storageValues: ValueFlowStorageValueFact[];
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

/**
 * 从 utf8 文本流提取证据图实际消费的 storage 快照事实。
 * 残缺 / 空输入 / 多根 JSON 抛错；合法但缺字段的文档返回空维度。
 */
export async function readStorageSnapshotFacts(source: Readable): Promise<StorageSnapshotFacts> {
  const p = parser.asStream();
  let sawRoot = false;
  let depth = 0;
  let topKey: string | null = null;
  let capturedAt: string | null = null;
  // cookies 数组：重复顶层键 last-wins（重开数组即清空已收集内容）
  let storageCookies: ValueFlowCookieFact[] = [];
  let inCookies = false;
  let cookieElement: { name?: string; value?: string } | null = null;
  let cookieKey: string | null = null;
  // storage 对象：源内重复键 last-wins（Map 覆写）；源间同键共存（与整读一致）
  const sessionStorage = new Map<string, string>();
  const localStorage = new Map<string, string>();
  let storageKey: string | null = null;

  const handleToken = (tok: Token): void => {
    switch (tok.name) {
      case 'startObject':
      case 'startArray': {
        depth += 1;
        if (depth === 1) {
          sawRoot = true;
          return;
        }
        if (depth === 2 && topKey === 'cookies') {
          if (tok.name !== 'startArray') return;
          // 重复的 cookies 键：后者覆盖前者（JSON.parse last-wins）
          inCookies = true;
          storageCookies = [];
          return;
        }
        if (depth === 3 && topKey === 'cookies' && inCookies && tok.name === 'startObject') {
          cookieElement = {};
          return;
        }
        return;
      }
      case 'endObject':
      case 'endArray': {
        if (depth === 3 && topKey === 'cookies' && cookieElement) {
          if (
            cookieElement.name !== undefined &&
            cookieElement.value !== undefined
          ) {
            storageCookies.push({ name: cookieElement.name, value: cookieElement.value });
          }
          cookieElement = null;
          cookieKey = null;
        }
        if (depth === 2 && topKey === 'cookies' && tok.name === 'endArray') {
          inCookies = false;
        }
        if (depth === 1) {
          topKey = null;
        }
        depth -= 1;
        return;
      }
      case 'keyValue': {
        if (depth === 1) {
          topKey = String(tok.value);
          storageKey = null;
          return;
        }
        if (depth === 3 && topKey === 'cookies' && cookieElement) {
          cookieKey = String(tok.value);
          return;
        }
        if (
          depth === 2 &&
          (topKey === 'sessionStorage' || topKey === 'localStorage')
        ) {
          storageKey = String(tok.value);
          return;
        }
        return;
      }
      default: {
        if (!isValueToken(tok.name)) return;
        if (depth === 1 && topKey === 'capturedAt') {
          // last-wins：后出现的 capturedAt 覆盖先前的
          capturedAt = tok.name === 'stringValue' ? String(tok.value) : null;
          return;
        }
        if (depth === 3 && topKey === 'cookies' && cookieElement) {
          if (tok.name !== 'stringValue' || cookieKey === null) return;
          if (cookieKey === 'name') cookieElement.name = String(tok.value);
          else if (cookieKey === 'value') cookieElement.value = String(tok.value);
          return;
        }
        if (
          depth === 2 &&
          storageKey !== null &&
          (topKey === 'sessionStorage' || topKey === 'localStorage')
        ) {
          if (tok.name !== 'stringValue') {
            // 非字符串值条目跳过（与整读的 Object.entries + typeof 过滤一致）
            storageKey = null;
            return;
          }
          const target = topKey === 'sessionStorage' ? sessionStorage : localStorage;
          target.set(storageKey, String(tok.value));
          storageKey = null;
          return;
        }
        return;
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    p.on('data', (tok: Token) => {
      try {
        handleToken(tok);
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        p.destroy(wrapped);
        finish(wrapped);
      }
    });
    p.on('error', (error: Error) => finish(error));
    p.on('end', () => finish());
    void pipeline(source, p).catch((error: Error) => finish(error));
  });

  if (!sawRoot) {
    throw new Error('storage 快照为空或不可解析');
  }

  return {
    capturedAt,
    storageCookies,
    storageValues: [...sessionStorage, ...localStorage].map(([key, value]) => ({ key, value })),
  };
}
