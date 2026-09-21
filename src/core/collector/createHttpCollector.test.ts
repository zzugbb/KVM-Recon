/**
 * HTTP 采集器 journal 写失败记账（规范 §3「缺失必须显式」）。
 * 反例（P3-4）：事务行 appendJsonl 失败时行永久丢失（committed 已置位，
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
});
