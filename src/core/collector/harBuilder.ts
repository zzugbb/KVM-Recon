/**
 * raw/http/session.har 互操作副本构建（规范 §8.2：HAR 不取代原始索引与正文文件）。
 *
 * 逐行读取事务，正文从 BodyStore 逐块转义/编码写入 HAR；不会为生成
 * 互操作副本而把大脚本或下载文件整体载入内存。原始正文仍单独留在包中。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { PackV2BodyRef, PackV2HttpTransactionRow } from '../capture-pack-v2/types';

export const HAR_PATH = 'raw/http/session.har';
const TRANSACTIONS_PATH = 'raw/http/transactions.jsonl';

export const HAR_CREATOR = { name: 'KVM-Recon', version: '0.3.0' };

/** 可作为 UTF-8 文本内嵌的 MIME；其他正文按原始字节 Base64 编码。 */
const TEXTUAL_MIME = /(?:^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|csv|html|svg|plain)/i;

interface HarHeader {
  name: string;
  value: string;
}

function harHeaders(headers: Record<string, string>): HarHeader[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

export function headerOf(headers: Record<string, string>, name: string): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : '';
}

function timingOf(transaction: PackV2HttpTransactionRow): { send: number; wait: number; receive: number } {
  const timing = transaction.timing;
  return {
    send: timing?.sendMs ?? -1,
    wait: timing?.waitMs ?? -1,
    // receiveMs 是 requestTime→响应头的累计偏移，不是正文时长：
    // 正文时长不可知，按 HAR 语义记 -1，不得把累计偏移伪装成正文段时长
    receive: -1,
  };
}

/** 到响应头的时间：max(receiveMs, sendMs+waitMs)，不做双重计数。 */
function timeToHeadersOf(transaction: PackV2HttpTransactionRow): number {
  const timing = transaction.timing;
  if (!timing) return -1;
  return Math.max(timing.receiveMs || 0, (timing.sendMs || 0) + (timing.waitMs || 0));
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: 'base64';
  comment?: string;
}

/**
 * 响应正文 content 构造，供样例包生成使用。
 * text 为 null 表示正文不可读（内嵌留空 + 注释标明缺正文）。
 */
export function harContentOf(
  mimeType: string,
  ref: PackV2BodyRef | undefined,
  text: string | null,
): HarContent {
  if (!ref) {
    return { size: 0, mimeType };
  }
  if (text === null) {
    return {
      size: ref.bytes,
      mimeType,
      text: '',
      comment: `正文文件不可读：${ref.path}（sha256=${ref.sha256}）`,
    };
  }
  if (mimeType && TEXTUAL_MIME.test(mimeType)) {
    return { size: ref.bytes, mimeType, text };
  }
  return {
    size: ref.bytes,
    mimeType,
    text: '',
    comment: `二进制正文不内嵌 HAR：包内路径 ${ref.path}（sha256=${ref.sha256}，${ref.bytes} 字节）`,
  };
}

export interface HarPostData {
  mimeType: string;
  text: string;
  encoding?: 'base64';
  comment?: string;
}

/**
 * 请求正文 postData 构造，供样例包生成使用。
 * text 为 null 表示正文不可读。
 */
export function harPostDataOf(
  mimeType: string,
  ref: PackV2BodyRef | undefined,
  text: string | null,
): HarPostData | null {
  if (!ref) return null;
  const textual = TEXTUAL_MIME.test(mimeType) || !mimeType;
  if (textual && text !== null) {
    return { mimeType, text };
  }
  if (text === null) {
    return {
      mimeType,
      text: '',
      comment: `正文文件不可读：${ref.path}（sha256=${ref.sha256}）`,
    };
  }
  return {
    mimeType,
    text: '',
    comment: `二进制请求正文不内嵌 HAR：包内路径 ${ref.path}（sha256=${ref.sha256}，${ref.bytes} 字节）`,
  };
}

export function harEntry(
  transaction: PackV2HttpTransactionRow,
  responseContent: HarContent,
  postData: HarPostData | null,
): Record<string, unknown> {
  return {
    startedDateTime: transaction.startedAt,
    time: timeToHeadersOf(transaction),
    request: {
      method: transaction.method,
      url: transaction.url,
      httpVersion: 'HTTP/1.1',
      headers: harHeaders(transaction.requestHeaders),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: transaction.requestBody?.bytes ?? 0,
      ...(transaction.requestBody && postData ? { postData } : {}),
    },
    response: {
      status: transaction.status,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: harHeaders(transaction.responseHeaders),
      cookies: [],
      content: responseContent,
      redirectURL: '',
      headersSize: -1,
      bodySize: transaction.responseBody?.bytes ?? 0,
    },
    cache: {},
    timings: timingOf(transaction),
    ...(transaction.remoteIpAddress ? { serverIPAddress: transaction.remoteIpAddress } : {}),
    ...(transaction.connectionId !== undefined ? { connection: String(transaction.connectionId) } : {}),
  };
}

type HarBodySlot = { marker: string; ref: PackV2BodyRef; encoding: 'utf8' | 'base64' };

async function writeText(handle: Awaited<ReturnType<typeof open>>, text: string): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten === 0) throw new Error('HAR 写入未取得进展');
    offset += result.bytesWritten;
  }
}

async function writeBody(workspace: JobWorkspace, handle: Awaited<ReturnType<typeof open>>, slot: HarBodySlot): Promise<void> {
  const stream = await workspace.openArtifactStream(slot.ref.path);
  if (slot.encoding === 'utf8') {
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of stream) {
      const text = decoder.decode(chunk as Buffer, { stream: true });
      if (text) await writeText(handle, JSON.stringify(text).slice(1, -1));
    }
    const tail = decoder.decode();
    if (tail) await writeText(handle, JSON.stringify(tail).slice(1, -1));
    return;
  }
  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const chunk of stream) {
    const bytes = remainder.length ? Buffer.concat([remainder, chunk as Buffer]) : chunk as Buffer;
    const complete = bytes.length - (bytes.length % 3);
    if (complete) await writeText(handle, bytes.subarray(0, complete).toString('base64'));
    remainder = bytes.subarray(complete);
  }
  if (remainder.length) await writeText(handle, remainder.toString('base64'));
}

async function writeEntry(
  workspace: JobWorkspace,
  handle: Awaited<ReturnType<typeof open>>,
  transaction: PackV2HttpTransactionRow,
): Promise<void> {
  const slots: HarBodySlot[] = [];
  const marker = () => `__KVM_RECON_BODY_${randomUUID()}__`;
  const requestMime = headerOf(transaction.requestHeaders, 'content-type');
  const responseMime = headerOf(transaction.responseHeaders, 'content-type');
  const responseContent: HarContent = { size: transaction.responseBody?.bytes ?? 0, mimeType: responseMime };
  if (transaction.responseBody) {
    const encoding = TEXTUAL_MIME.test(responseMime) ? 'utf8' : 'base64';
    const token = marker();
    responseContent.text = token;
    if (encoding === 'base64') responseContent.encoding = 'base64';
    slots.push({ marker: token, ref: transaction.responseBody, encoding });
  }
  let postData: HarPostData | null = null;
  if (transaction.requestBody) {
    const encoding = TEXTUAL_MIME.test(requestMime) ? 'utf8' : 'base64';
    const token = marker();
    postData = { mimeType: requestMime, text: token };
    if (encoding === 'base64') {
      postData.encoding = 'base64';
      postData.comment = 'Base64 编码的请求正文；原始字节也保存在包内 BodyStore。';
    }
    slots.push({ marker: token, ref: transaction.requestBody, encoding });
  }
  const serialized = JSON.stringify(harEntry(transaction, responseContent, postData));
  const replacements = slots.map(slot => ({ slot, needle: JSON.stringify(slot.marker), at: serialized.indexOf(JSON.stringify(slot.marker)) }))
    .sort((a, b) => a.at - b.at);
  let cursor = 0;
  for (const { slot, needle, at } of replacements) {
    if (at < cursor) throw new Error(`HAR 正文占位符未找到：${slot.ref.path}`);
    await writeText(handle, serialized.slice(cursor, at));
    await writeText(handle, '"');
    await writeBody(workspace, handle, slot);
    await writeText(handle, '"');
    cursor = at + needle.length;
  }
  await writeText(handle, serialized.slice(cursor));
}

/**
 * 从工作区事务与正文构建 raw/http/session.har。
 * 返回 entry 数；空事务表产生空 entries 的合法 HAR。
 */
export async function buildHarIntoWorkspace(workspace: JobWorkspace): Promise<{ entries: number }> {
  // 写租赁在第一个 await 前取得（assertWritable + 登记同一步完成）
  const release = workspace.trackInFlightWrite();
  try {
    workspace.assertWritable();
    const absolute = join(workspace.dir, HAR_PATH);
    await mkdir(dirname(absolute), { recursive: true });
    const handle = await open(absolute, 'w');
    try {
      await writeText(handle,
        `{"log":{"version":"1.2","creator":${JSON.stringify(HAR_CREATOR)},"entries":[`,
      );
      let entries = 0;
      const lines = createInterface({
        input: createReadStream(join(workspace.dir, TRANSACTIONS_PATH), { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const transaction = JSON.parse(line) as PackV2HttpTransactionRow;
        if (entries > 0) await writeText(handle, ',');
        await writeEntry(workspace, handle, transaction);
        entries += 1;
      }
      await writeText(handle, ']}}\n');
      await handle.sync();
      return { entries };
    } finally {
      await handle.close();
    }
  } finally {
    release();
  }
}
