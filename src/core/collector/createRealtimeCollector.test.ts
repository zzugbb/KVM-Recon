/**
 * 实时通道 journal 写失败记账（规范 §3「缺失必须显式」）。
 * 反例（P2-1）：raw/realtime/downloads.jsonl append 抛错（模拟非 ENOSPC
 * 磁盘故障）时只有进程内 droppedEvent 计数，包内证据摘要无作证，
 * derivePackIntegrity 派生假 COMPLETE。
 */

import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { derivePackIntegrity } from '../capture-pack-v2/packStatus';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import { createCollectorEvidence } from './collectorEvidence';
import { createRealtimeCollector } from './createRealtimeCollector';

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

const summaryInput = {
  collectorReadyBeforeFirstNavigation: true,
  rawJournalsClosed: true,
  browserStateWritten: true,
  evidenceReferencesClosed: true,
  workflowStatus: 'TARGET_OPENED' as const,
};

describe('实时通道 journal 写失败记账', () => {
  it('downloads 行写入失败：持久进入证据摘要并派生 INCOMPLETE_RAW_JOURNAL', async () => {
    const workspace = createFailingWorkspace('raw/realtime/downloads.jsonl');
    const evidence = createCollectorEvidence();
    const realtime = createRealtimeCollector(workspace, evidence);
    await expect(
      realtime.recordDownloadStart({
        id: 'download-0001',
        url: 'https://bmc.test/firmware.jnlp',
        targetId: 'target-root',
        occurredAt: '2026-09-21T10:00:00.000Z',
      }),
    ).rejects.toThrow('磁盘写入失败（模拟）');

    const summary = evidence.summary(summaryInput);
    expect(summary.journalWriteFailures).toEqual([
      expect.objectContaining({
        id: 'download-0001',
        detail: expect.stringContaining('downloads.jsonl'),
      }),
    ]);
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_RAW_JOURNAL');
  });
});
