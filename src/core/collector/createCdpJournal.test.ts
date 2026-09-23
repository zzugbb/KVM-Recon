import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { derivePackIntegrity } from '../capture-pack-v2/packStatus';
import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import { createCollectorEvidence } from './collectorEvidence';
import { createCdpJournal } from './createCdpJournal';

/**
 * 反例（多根挂载并发写入）：主窗口 + popup 并发 recordEvent/recordCommand
 * 时，seq 赋值顺序必须与落盘顺序一致——否则包一致性门禁以
 * RAW_JOURNAL_INVALID（seq 不严格递增）拒绝导出。
 */

const roots: string[] = [];

async function newRootDir() {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-journal-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('createCdpJournal（并发 seq 顺序）', () => {
  it('并发写入：events/commands 的 seq 在文件里严格递增', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-journal-concurrent', rootDir });
    const journal = createCdpJournal(workspace, createCollectorEvidence());

    const writes = Array.from({ length: 200 }, (_, index) =>
      index % 2 === 0
        ? journal.recordEvent({
            timestamp: '2026-09-21T10:00:00.000Z',
            method: 'Network.eventWillBeSent',
            targetId: `target-window-${index % 3}`,
            params: { index },
          })
        : journal.recordCommand({
            timestamp: '2026-09-21T10:00:00.000Z',
            method: 'Network.getResponseBody',
            targetId: `target-window-${index % 3}`,
            params: { index },
            result: {},
          }),
    );
    await Promise.all(writes);

    const eventSeqs = (await workspace.readArtifact('raw/cdp/events.jsonl'))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { seq: number }).seq);
    const commandSeqs = (await workspace.readArtifact('raw/cdp/commands.jsonl'))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { seq: number }).seq);

    expect(eventSeqs).toHaveLength(100);
    expect(commandSeqs).toHaveLength(100);
    for (let i = 1; i < eventSeqs.length; i += 1) {
      expect(eventSeqs[i]).toBe(eventSeqs[i - 1] + 1);
    }
    for (let i = 1; i < commandSeqs.length; i += 1) {
      expect(commandSeqs[i]).toBe(commandSeqs[i - 1] + 1);
    }
    await workspace.close();
  });

  it('事件行写入失败持久记账：粘性丢列逐条作证，派生 INCOMPLETE_RAW_JOURNAL', async () => {
    // 反例：appendJsonl 抛错（模拟非 ENOSPC 磁盘故障）时，
    // 粘性链把第一条失败放大为后续全部事件丢行——只有进程内 droppedEvent
    // 计数，包内证据摘要无作证，derivePackIntegrity 派生假 COMPLETE。
    const evidence = createCollectorEvidence();
    const appended: string[] = [];
    const workspace = {
      dir: tmpdir(),
      appendJsonl: async (path: string, _row: Record<string, unknown>) => {
        appended.push(path);
        if (path === 'raw/cdp/events.jsonl') throw new Error('磁盘写入失败（模拟）');
      },
      trackInFlightWrite: () => () => {},
      assertWritable: () => {},
    } as unknown as JobWorkspace;
    const journal = createCdpJournal(workspace, evidence);
    const event = (index: number) => ({
      timestamp: '2026-09-21T10:00:00.000Z',
      method: 'Network.eventWillBeSent',
      targetId: 'target-root',
      params: { index },
    });
    await expect(journal.recordEvent(event(1))).rejects.toThrow('磁盘写入失败（模拟）');
    // 粘性链已断：第二条不再尝试落盘（写序必须等于 seq 序），但丢行必须逐条作证
    await expect(journal.recordEvent(event(2))).rejects.toThrow();
    // 命令行不受事件链影响（独立链），仍正常写入
    await journal.recordCommand({
      timestamp: '2026-09-21T10:00:01.000Z',
      method: 'Network.getResponseBody',
      targetId: 'target-root',
      params: {},
      result: {},
    });
    expect(appended).toContain('raw/cdp/commands.jsonl');

    const summary = evidence.summary({
      collectorReadyBeforeFirstNavigation: true,
      rawJournalsClosed: true,
      browserStateWritten: true,
      evidenceReferencesClosed: true,
      workflowStatus: 'TARGET_OPENED',
    });
    expect(summary.journalWriteFailures).toHaveLength(2);
    expect(summary.journalWriteFailures[0]).toMatchObject({ id: expect.stringContaining('events') });
    const derived = derivePackIntegrity(summary);
    expect(derived.reasons).toContain('INCOMPLETE_RAW_JOURNAL');
    expect(derived.gates.find(gate => gate.id === 'raw-journals-closed')?.passed).toBe(false);
  });
});
