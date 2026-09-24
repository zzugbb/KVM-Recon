/**
 * Chromium NetLog → raw/netlog/netlog.json 流式包装（规范 §8.1）。
 *
 * 源文件（Electron netLog.stopLogging 产生的完整 JSON 对象）用 stream-json
 * 逐 token 流式解析：events 数组逐条装配、逐条写出，内存上界 = 单个事件；
 * constants 与其余顶层字段原样透传（当前解析器不认识的字段不丢弃）。
 * 输出经工作区写租赁逐块写入（租赁先于首个 await），收尾 fsync。
 *
 * 残缺源（截断 / 多根 / 非法 JSON / events 非数组 / 缺 events）一律抛错，
 * 由调用方记账并落兜底文件；绝不输出静默截断的 netlog.json 假装采集成功。
 */

import { createReadStream } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parser } from 'stream-json';

import { JsonAssembler } from './jsonAssembler';
import type { Token } from './streamJsonTypes';
import { PACK_V2_SCHEMA_VERSION } from '../capture-pack-v2/types';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';

export const NETLOG_PATH = 'raw/netlog/netlog.json';

export interface NetlogWrapResult {
  eventsCount: number;
  /** 透传的顶层字段名（constants 等；不含 events / envelope 字段）。 */
  passthroughKeys: string[];
}

/**
 * 把 Chromium NetLog 源文件包装写入工作区 raw/netlog/netlog.json。
 * captureMode：Electron netLog 采集模式（如 include-sensitive）。
 */
export async function wrapNetlogIntoWorkspace(
  sourcePath: string,
  workspace: JobWorkspace,
  captureMode: string,
): Promise<NetlogWrapResult> {
  // 写租赁在第一个 await 前取得（assertWritable + 登记同一步完成）
  const release = workspace.trackInFlightWrite();
  try {
    workspace.assertWritable();
    const absolute = join(workspace.dir, NETLOG_PATH);
    await mkdir(dirname(absolute), { recursive: true });
    const handle = await open(absolute, 'w');
    try {
      const result = await transform(sourcePath, captureMode, handle);
      await handle.sync();
      return result;
    } finally {
      await handle.close();
    }
  } finally {
    release();
  }
}

async function transform(
  sourcePath: string,
  captureMode: string,
  handle: FileHandle,
): Promise<NetlogWrapResult> {
  const p = parser.asStream();
  const feed = (async () => {
    const source = createReadStream(sourcePath, { encoding: 'utf8' });
    for await (const chunk of source) {
      if (!p.write(chunk as string)) {
        await new Promise<void>(resolve => p.once('drain', resolve));
      }
    }
    p.end();
  })();

  const passthrough: Array<[string, unknown]> = [];
  const ENVELOPE_KEYS = new Set(['schemaVersion', 'captureMode', 'events']);
  let sawEventsKey = false;
  let eventsMode = false;
  let eventsCount = 0;
  let depth = 0;
  let topKey: string | null = null;
  let eventAssembler: JsonAssembler | null = null;
  let passthroughAssembler: JsonAssembler | null = null;
  let wroteAnyEvent = false;

  await handle.write(
    `{"schemaVersion":${JSON.stringify(PACK_V2_SCHEMA_VERSION)},"captureMode":${JSON.stringify(captureMode)},"events":[`,
  );

  const recordPassthrough = (key: string, value: unknown): void => {
    if (!ENVELOPE_KEYS.has(key)) passthrough.push([key, value]);
  };

  try {
    for await (const tok of p as unknown as AsyncIterable<Token>) {
      const name = tok.name;
      if (name === 'startObject' || name === 'startArray') {
        depth += 1;
        if (depth === 2 && topKey === 'events') {
          if (name !== 'startArray') {
            throw new Error('NetLog 源的 events 不是数组');
          }
          eventsMode = true;
          sawEventsKey = true;
          topKey = null;
          continue;
        }
        if (depth === 2 && topKey) {
          passthroughAssembler = new JsonAssembler();
          passthroughAssembler.consume(tok);
          continue;
        }
        if (eventsMode && depth === 3 && !eventAssembler) {
          if (name !== 'startObject') {
            throw new Error('NetLog events 数组包含非对象元素');
          }
          eventAssembler = new JsonAssembler();
          eventAssembler.consume(tok);
          continue;
        }
        passthroughAssembler?.consume(tok);
        eventAssembler?.consume(tok);
        continue;
      }
      if (name === 'endObject' || name === 'endArray') {
        if (eventAssembler) {
          eventAssembler.consume(tok);
          depth -= 1;
          if (eventAssembler.done) {
            const element = eventAssembler.value;
            eventAssembler = null;
            eventsCount += 1;
            await handle.write(`${wroteAnyEvent ? ',' : ''}${JSON.stringify(element)}`);
            wroteAnyEvent = true;
          }
          continue;
        }
        if (passthroughAssembler) {
          passthroughAssembler.consume(tok);
          depth -= 1;
          if (passthroughAssembler.done && depth === 1) {
            recordPassthrough(topKey!, passthroughAssembler.value);
            passthroughAssembler = null;
            topKey = null;
          }
          continue;
        }
        depth -= 1;
        if (eventsMode && depth === 1) eventsMode = false;
        continue;
      }
      if (name === 'keyValue') {
        if (depth === 1) {
          topKey = String(tok.value);
        } else {
          passthroughAssembler?.consume(tok);
          eventAssembler?.consume(tok);
        }
        continue;
      }
      // 标量值 token（含 chunked 字符串/数字的中间 token）
      if (depth === 1 && topKey) {
        if (topKey === 'events') {
          throw new Error('NetLog 源的 events 不是数组');
        }
        if (!passthroughAssembler) passthroughAssembler = new JsonAssembler();
      }
      passthroughAssembler?.consume(tok);
      eventAssembler?.consume(tok);
      if (
        passthroughAssembler &&
        passthroughAssembler.done &&
        depth === 1 &&
        topKey
      ) {
        recordPassthrough(topKey, passthroughAssembler.value);
        passthroughAssembler = null;
        topKey = null;
      }
    }
  } finally {
    await feed.catch(() => {
      // 解析错误优先由 for-await 抛出；feed 失败不吞主错误
    });
  }
  await feed;

  if (!sawEventsKey) {
    throw new Error('NetLog 源缺少 events 数组');
  }

  let tail = ']';
  for (const [key, value] of passthrough) {
    tail += `,${JSON.stringify(key)}:${JSON.stringify(value)}`;
  }
  tail += '}\n';
  await handle.write(tail);

  return { eventsCount, passthroughKeys: passthrough.map(([key]) => key) };
}
