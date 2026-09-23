/**
 * HAR entry 时序语义（第 12 轮附加项）。
 *
 * CDP timing 语义：sendMs = sendEnd−sendStart（请求发送）、waitMs =
 * receiveHeadersEnd−sendEnd（等待响应）、receiveMs = requestTime→
 * receiveHeadersEnd 的**累计偏移**（不是正文时长）。因此：
 * - entry.time 不得把 receiveMs 与 sendMs+waitMs 相加（双重计数），
 *   记 max(receiveMs, sendMs+waitMs)（到响应头的时间）；
 * - timings.receive 记 -1（正文时长不可知，receiveMs 不是该值）。
 */

import { describe, expect, it } from 'vitest';

import type { PackV2HttpTransactionRow } from '../capture-pack-v2/types';
import { harContentOf, harEntry } from './harBuilder';

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
  it('time 不双重计数 receiveMs：max(receiveMs, sendMs+waitMs)，receive 段记 -1（第 12 轮）', () => {
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
