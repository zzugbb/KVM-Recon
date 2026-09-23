/**
 * HTTP 采集器 journal 写失败记账（规范 §3「缺失必须显式」）。
 * 反例：事务行 appendJsonl 失败时行永久丢失（committed 已置位，
 * flush 不再重试），只有 droppedEvent 进程内计数，不进导出包的证据摘要
 * ——包内摘要无对应缺失记录，「应有而未有」无人作证。
 */

import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import { derivePackIntegrity } from '../capture-pack-v2/packStatus';
import { createCollectorEvidence } from './collectorEvidence';
import { createHttpCollector } from './createHttpCollector';
import type { HttpHopInput } from './createHttpCollector';

/** appendJsonl 对指定路径抛错（模拟非 ENOSPC 的磁盘写故障），其余路径 no-op。 */
function createFailingWorkspace(failPath: string): JobWorkspace {
  return {
    dir: tmpdir(),
    appendJsonl: async (path: string, _row: Record<string, unknown>) => {
      if (path === failPath) throw new Error('磁盘写入失败（模拟）');
    },
    trackInFlightWrite: () => () => {},
    assertWritable: () => {},
  } as unknown as JobWorkspace;
}

/** 包内持久可见的全部缺口类别（droppedEvent 不在其中——只在进程内）。 */
function persistentGaps(summary: ReturnType<ReturnType<typeof createCollectorEvidence>['summary']>) {
  return [
    ...summary.targetAttachFailures,
    ...summary.missingBodies,
    ...summary.missingWorkerSources,
    ...summary.channelGaps,
    ...summary.unsupportedChannels,
    ...summary.journalWriteFailures,
    ...summary.exportValidationFailures,
  ];
}

const summaryInput = {
  collectorReadyBeforeFirstNavigation: true,
  rawJournalsClosed: true,
  browserStateWritten: true,
  evidenceReferencesClosed: true,
  workflowStatus: 'TARGET_OPENED' as const,
};

describe('HTTP 采集器 journal 写失败记账', () => {
  const HOP: HttpHopInput = {
    id: 'req-1',
    targetId: 'target-root',
    startedAt: '2026-09-21T01:00:00.000Z',
    method: 'GET',
    url: 'https://bmc.test/console',
    resourceType: 'document',
    requestHeaders: {},
  };

  it('事务行写入失败：缺口持久进入证据摘要，而非只有进程内计数', async () => {
    const workspace = createFailingWorkspace('raw/http/transactions.jsonl');
    const evidence = createCollectorEvidence();
    const http = createHttpCollector(workspace, evidence);
    http.openHop(HOP);
    // commit 抛错给调用方（事件链/flush 由 droppedEvent 计数），但行丢失必须持久作证
    await expect(http.commit('req-1')).rejects.toThrow('磁盘写入失败（模拟）');
    const summary = evidence.summary(summaryInput);
    const gaps = persistentGaps(summary);
    expect(gaps.some(gap => gap.id === 'req-1')).toBe(true);
    expect(summary.journalWriteFailures).toEqual([
      expect.objectContaining({ id: 'req-1', detail: expect.stringContaining('transactions.jsonl') }),
    ]);
  });

  it('资源索引行写入失败：同上持久记账', async () => {
    const workspace = createFailingWorkspace('catalog/resources.jsonl');
    const evidence = createCollectorEvidence();
    const http = createHttpCollector(workspace, evidence);
    http.openHop(HOP);
    await expect(http.commit('req-1')).rejects.toThrow('磁盘写入失败（模拟）');
    const summary = evidence.summary(summaryInput);
    const gaps = persistentGaps(summary);
    expect(gaps.some(gap => gap.id === 'req-1')).toBe(true);
    expect(summary.journalWriteFailures).toEqual([
      expect.objectContaining({ id: 'req-1', detail: expect.stringContaining('resources.jsonl') }),
    ]);
  });

  it('journal 行写入失败派生 INCOMPLETE_RAW_JOURNAL（raw journal 缺行，规范 §14）', async () => {
    const workspace = createFailingWorkspace('raw/http/transactions.jsonl');
    const evidence = createCollectorEvidence();
    const http = createHttpCollector(workspace, evidence);
    http.openHop(HOP);
    await http.commit('req-1').catch(() => {});
    const derived = derivePackIntegrity(evidence.summary(summaryInput));
    expect(derived.reasons).toContain('INCOMPLETE_RAW_JOURNAL');
    const gate = derived.gates.find(row => row.id === 'raw-journals-closed');
    expect(gate?.passed).toBe(false);
  });

  it('204/205/304 明确无正文语义：不记 missingBodies 缺口', async () => {
    const evidence = createCollectorEvidence();
    const http = createHttpCollector(createFailingWorkspace('__never__'), evidence);
    http.openHop({ ...HOP, id: 'req-204' });
    http.patchHop('req-204', { status: 204 });
    http.openHop({ ...HOP, id: 'req-205', url: 'https://bmc.test/reset' });
    http.patchHop('req-205', { status: 205 });
    http.openHop({ ...HOP, id: 'req-304', url: 'https://bmc.test/redirect-target' });
    http.patchHop('req-304', { status: 304 });
    await http.commit('req-204');
    await http.commit('req-205');
    await http.commit('req-304');
    // 状态码已知的明确无正文语义：不是「应有而未有」，不得作证缺失
    expect(evidence.summary(summaryInput).missingBodies).toEqual([]);
  });

  it('patchHop 对已 commit 的 hop 返回 false 且不改行（三轮 T4：journal 只追加）', async () => {
    const evidence = createCollectorEvidence();
    const http = createHttpCollector(createFailingWorkspace('__never__'), evidence);
    http.openHop({ ...HOP, id: 'req-committed' });
    await http.commit('req-committed');
    // commit 之后的晚到事实（status / 正文引用）不得无痕写进内存行——
    // 行已落盘，改内存行等于编造落盘内容
    const patched = http.patchHop('req-committed', { status: 200 });
    expect(patched).toBe(false);
    const rows = http.transactionRows();
    expect(rows[0].status).toBeNull();
    expect(rows[0].responseBody).toBeUndefined();
  });

  // （规范 §7.4「非持续响应正文全部落盘」）：在途非持续请求视图
  // 供自动收尾看门狗等待；EventSource / event-stream / multipart 流式响应
  // 是持续通道，等它完成等于永不收尾。
  it('在途非持续 hop 在列；EventSource / 流式响应不在列；完成后移除', async () => {
    const evidence = createCollectorEvidence();
    const http = createHttpCollector(createFailingWorkspace('__never__'), evidence);
    http.openHop({ ...HOP, id: 'req-xhr', resourceType: 'XHR' });
    http.openHop({ ...HOP, id: 'req-es', resourceType: 'EventSource' });
    http.openHop({ ...HOP, id: 'req-sse', resourceType: 'XHR' });
    http.patchHop('req-sse', {
      status: 200,
      responseHeaders: { 'content-type': 'text/event-stream' },
    });
    http.openHop({ ...HOP, id: 'req-mjpeg', resourceType: 'Media' });
    http.patchHop('req-mjpeg', {
      responseHeaders: { 'content-type': 'multipart/x-mixed-replace; boundary=frame' },
    });

    expect(http.pendingNonStreamingHops().map(hop => hop.id)).toEqual(['req-xhr']);

    // 完成后（commit）从在途视图移除
    await http.commit('req-xhr');
    expect(http.pendingNonStreamingHops()).toEqual([]);
  });

  it('响应头未到达的 EventSource hop（resourceType 已知）也不阻塞自动收尾', () => {
    const evidence = createCollectorEvidence();
    const http = createHttpCollector(createFailingWorkspace('__never__'), evidence);
    // EventSource 在 requestWillBeSent 即携带 resourceType——头未到达也可判持续
    http.openHop({ ...HOP, id: 'req-es-early', resourceType: 'EventSource' });
    expect(http.pendingNonStreamingHops()).toEqual([]);
  });
});
