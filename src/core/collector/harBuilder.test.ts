/**
 * HAR entry 时序语义。
 *
 * CDP timing 语义：sendMs = sendEnd−sendStart（请求发送）、waitMs =
 * receiveHeadersEnd−sendEnd（等待响应）、receiveMs = requestTime→
 * receiveHeadersEnd 的**累计偏移**（不是正文时长）。因此：
 * - entry.time 不得把 receiveMs 与 sendMs+waitMs 相加（双重计数），
 *   记 max(receiveMs, sendMs+waitMs)（到响应头的时间）；
 * - timings.receive 记 -1（正文时长不可知，receiveMs 不是该值）。
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackV2HttpTransactionRow } from '../capture-pack-v2/types';
import { createBodyStore } from '../body-store/createBodyStore';
import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import { buildHarIntoWorkspace, harContentOf, harEntry } from './harBuilder';

function tx(overrides: Partial<PackV2HttpTransactionRow> = {}): PackV2HttpTransactionRow {
  return {
    id: 'http-0001',
    targetId: 'target-root',
    startedAt: '2026-09-21T02:00:00.000Z',
    method: 'GET',
    url: 'http://bmc.test/login',
    resourceType: 'document',
    requestHeaders: {},
    status: 200,
    responseHeaders: { 'content-type': 'text/html' },
    ...overrides,
  };
}

describe('harEntry 时序（CDP timing 语义）', () => {
  it('time 不双重计数 receiveMs：max(receiveMs, sendMs+waitMs)，receive 段记 -1', () => {
    const entry = harEntry(
      tx({ timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 } }),
      harContentOf('text/html', undefined, null),
      null,
    );
    // 旧双重计数：500+2000+2600=5100 ≠ 到响应头时间 2600
    expect(entry.time).toBe(2600);
    expect(entry.timings).toEqual({ send: 500, wait: 2000, receive: -1 });
  });

  it('receiveMs 缺席（异常形状）时 time 退回 sendMs+waitMs，不编造', () => {
    const entry = harEntry(
      tx({ timing: { sendMs: 500, waitMs: 2000, receiveMs: 0 } }),
      harContentOf('text/html', undefined, null),
      null,
    );
    expect(entry.time).toBe(2500);
    expect(entry.timings).toEqual({ send: 500, wait: 2000, receive: -1 });
  });

  it('timing 缺失：time=-1、timings 三段 -1（诚实下限）', () => {
    const entry = harEntry(tx(), harContentOf('text/html', undefined, null), null);
    expect(entry.time).toBe(-1);
    expect(entry.timings).toEqual({ send: -1, wait: -1, receive: -1 });
  });
});

describe('HAR 正文流式导出', () => {
  it('大脚本与二进制正文完整进入 HAR，构建期间不整文件读取', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kvm-recon-har-test-'));
    const workspace = await startJobWorkspace({ jobId: 'har-stream', rootDir, deviceLabel: 'test', safetyMarginBytes: 1 });
    try {
      const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
      const script = Buffer.from(`${'a'.repeat(65535)}你\n"${'b'.repeat(12 * 1024 * 1024)}`, 'utf8');
      const image = Buffer.alloc(1024 * 1024 + 2, 0xfb);
      const scriptWriter = await store.openWriter();
      await scriptWriter.write(script);
      const scriptRef = await scriptWriter.finish();
      const imageWriter = await store.openWriter();
      await imageWriter.write(image);
      const imageRef = await imageWriter.finish();
      await workspace.appendJsonl('raw/http/transactions.jsonl', tx({
        responseBody: scriptRef,
        responseHeaders: { 'content-type': 'application/javascript' },
      }));
      await workspace.appendJsonl('raw/http/transactions.jsonl', tx({
        id: 'http-0002',
        url: 'http://bmc.test/screenshot',
        method: 'POST',
        requestBody: imageRef,
        responseBody: imageRef,
        responseHeaders: { 'content-type': 'image/png' },
      }));
      const originalRead = workspace.readArtifact.bind(workspace);
      workspace.readArtifact = async () => { throw new Error('HAR 构建不得整文件读取正文'); };
      expect(await buildHarIntoWorkspace(workspace)).toEqual({ entries: 2 });
      workspace.readArtifact = originalRead;
      const har = JSON.parse((await workspace.readArtifact('raw/http/session.har')).toString('utf8')) as {
        log: { entries: Array<{
          request: { postData?: { text: string; encoding?: string } };
          response: { content: { text: string; encoding?: string } };
        }> };
      };
      expect(har.log.entries[0].response.content.text).toBe(script.toString('utf8'));
      expect(har.log.entries[1].response.content.encoding).toBe('base64');
      expect(Buffer.from(har.log.entries[1].response.content.text, 'base64')).toEqual(image);
      expect(har.log.entries[1].request.postData?.encoding).toBe('base64');
      expect(Buffer.from(har.log.entries[1].request.postData?.text ?? '', 'base64')).toEqual(image);
    } finally {
      await workspace.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
