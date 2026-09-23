/**
 * raw/http/session.har 互操作副本构建（规范 §8.2：HAR 不取代原始索引与正文文件）。
 *
 * 逐行流式读 transactions.jsonl、单份正文逐个读入，逐块写出：内存上界 =
 * 单条事务 + 单份正文，不整文件载入。文本正文内嵌 HAR；二进制正文不内嵌
 * （避免无意义膨胀），记录 size 与包内 bodyRef 注释，原始文件仍在包内。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { PackV2BodyRef, PackV2HttpTransactionRow } from '../capture-pack-v2/types';

export const HAR_PATH = 'raw/http/session.har';
const TRANSACTIONS_PATH = 'raw/http/transactions.jsonl';

export const HAR_CREATOR = { name: 'KVM-Recon', version: '0.3.0' };

/** 文本类 MIME（正文可无损内嵌为 HAR text）。 */
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

async function readBody(workspace: JobWorkspace, ref: PackV2BodyRef | undefined): Promise<Buffer | null> {
  if (!ref) return null;
  try {
    return await workspace.readArtifact(ref.path);
  } catch {
    // 捕获正文文件读取失败：HAR 内嵌留空 + 注释标明缺正文
    return null;
  }
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  comment?: string;
}

/**
 * 响应正文 content 构造（真实构建与样例包共用，形状不得漂移）。
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
  comment?: string;
}

/**
 * 请求正文 postData 构造（真实构建与样例包共用）。
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
      await handle.write(
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
        const requestMime = headerOf(transaction.requestHeaders, 'content-type');
        const responseBytes = await readBody(workspace, transaction.responseBody);
        const responseContent = harContentOf(
          headerOf(transaction.responseHeaders, 'content-type'),
          transaction.responseBody,
          responseBytes === null ? null : responseBytes.toString('utf8'),
        );
        let postData: HarPostData | null = null;
        if (transaction.requestBody) {
          const requestBytes = await readBody(workspace, transaction.requestBody);
          postData = harPostDataOf(
            requestMime,
            transaction.requestBody,
            requestBytes === null ? null : requestBytes.toString('utf8'),
          );
        }
        const entry = harEntry(transaction, responseContent, postData);
        await handle.write(`${entries > 0 ? ',' : ''}${JSON.stringify(entry)}`);
        entries += 1;
      }
      await handle.write(']}}\n');
      await handle.sync();
      return { entries };
    } finally {
      await handle.close();
    }
  } finally {
    release();
  }
}
