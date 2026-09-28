/**
 * 实时通道 journal 写失败记账（规范 §3「缺失必须显式」）。
 * 反例：raw/realtime/downloads.jsonl append 抛错（模拟非 ENOSPC
 * 磁盘故障）时只有进程内 droppedEvent 计数，包内证据摘要无作证，
 * derivePackIntegrity 派生假 COMPLETE。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { derivePackIntegrity } from '../capture-pack-v2/packStatus';
import { startJobWorkspace, type JobWorkspace } from '../job-workspace/createJobWorkspace';
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

function createBodyFailingWorkspace(): JobWorkspace {
  return {
    dir: tmpdir(),
    trackInFlightWrite() {
      throw new Error('正文写入失败（模拟）');
    },
  } as unknown as JobWorkspace;
}

const summaryInput = {
  collectorReadyBeforeFirstNavigation: true,
  rawJournalsClosed: true,
  browserStateWritten: true,
  evidenceReferencesClosed: true,
  workflowStatus: 'TARGET_OPENED' as const,
};

const tempRoots: string[] = [];
const workspaces: JobWorkspace[] = [];

async function realWorkspace(): Promise<JobWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), 'kvm-recon-realtime-test-'));
  tempRoots.push(rootDir);
  const workspace = await startJobWorkspace({
    rootDir,
    jobId: 'job-realtime-test',
    safetyMarginBytes: 1,
  });
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(workspace => workspace.close()));
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

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

describe('实时消息正文与通道身份', () => {
  it('WebRTC/SSE 正文落盘失败时写入 channelGaps 并拒绝 COMPLETE', async () => {
    const evidence = createCollectorEvidence();
    const realtime = createRealtimeCollector(createBodyFailingWorkspace(), evidence);
    const at = '2026-09-21T10:00:00.000Z';
    await expect(realtime.recordObserverEvent('webrtc', {
      pcId: 'pc-1', eventKind: 'datachannel-message', direction: 'down', messageB64: 'YQ==',
    }, 'target-root', at)).rejects.toThrow('正文写入失败');
    await expect(realtime.recordObserverEvent('sse', {
      sseId: 'sse-1', eventKind: 'event', dataB64: 'Yg==',
    }, 'target-root', at)).rejects.toThrow('正文写入失败');
    const summary = evidence.summary(summaryInput);
    expect(summary.channelGaps).toEqual([
      { id: 'pc-1', detail: 'WebRTC DataChannel 消息正文落盘失败' },
      { id: 'sse-1', detail: 'SSE 事件正文落盘失败' },
    ]);
    expect(derivePackIntegrity(summary).reasons).toContain('INCOMPLETE_CHANNEL_GAP');
  });

  it('WebRTC/SSE 缺失或无效正文记 channelGaps，合法空消息留零字节 BodyRef', async () => {
    const workspace = await realWorkspace();
    const evidence = createCollectorEvidence();
    const realtime = createRealtimeCollector(workspace, evidence);
    const at = '2026-09-21T10:00:00.000Z';
    await realtime.recordObserverEvent('webrtc', {
      pcId: 'pc-1', eventKind: 'datachannel-message', direction: 'down', messageB64: null,
    }, 'target-root', at);
    await realtime.recordObserverEvent('sse', {
      sseId: 'sse-1', eventKind: 'event', dataB64: '@@@',
    }, 'target-root', at);
    await realtime.recordObserverEvent('webrtc', {
      pcId: 'pc-1', eventKind: 'datachannel-message', direction: 'down', messageB64: '',
    }, 'target-root', at);
    await realtime.recordObserverEvent('sse', {
      sseId: 'sse-1', eventKind: 'event', dataB64: '',
    }, 'target-root', at);

    const summary = evidence.summary(summaryInput);
    expect(summary.channelGaps.map(gap => gap.id)).toEqual(['pc-1', 'sse-1']);
    expect(derivePackIntegrity(summary).reasons).toContain('INCOMPLETE_CHANNEL_GAP');
    const rtcRows = (await workspace.readArtifact('raw/realtime/webrtc.jsonl')).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    const sseRows = (await workspace.readArtifact('raw/realtime/sse.jsonl')).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rtcRows[0].messageRef).toBeUndefined();
    expect(sseRows[0].dataRef).toBeUndefined();
    expect(rtcRows[1].messageRef.bytes).toBe(0);
    expect(sseRows[1].dataRef.bytes).toBe(0);
  });

  it('不同 target 报相同本地 ID 时保持独立通道与原始行身份', async () => {
    const workspace = await realWorkspace();
    const evidence = createCollectorEvidence();
    const realtime = createRealtimeCollector(workspace, evidence);
    const at = '2026-09-21T10:00:00.000Z';
    for (const targetId of ['target-root', 'target-popup']) {
      await realtime.recordObserverEvent('webrtc', {
        pcId: 'pc-1', eventKind: 'datachannel-message', direction: 'down', messageB64: 'YQ==',
      }, targetId, at);
      await realtime.recordObserverEvent('sse', {
        sseId: 'sse-1', eventKind: 'event', dataB64: 'Yg==',
      }, targetId, at);
      await realtime.recordObserverEvent('webtransport', {
        wtId: 'wt-1', eventKind: 'created', url: 'https://bmc.test/wt',
      }, targetId, at);
    }
    const rows = realtime.channelRows();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(row => row.id)).size).toBe(6);
    for (const kind of ['webrtc', 'sse', 'webtransport'] as const) {
      expect(rows.filter(row => row.kind === kind).map(row => row.targetId).sort()).toEqual(['target-popup', 'target-root']);
    }
    const rtcRows = (await workspace.readArtifact('raw/realtime/webrtc.jsonl')).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(new Set(rtcRows.map(row => row.peerConnectionId)).size).toBe(2);
    expect(evidence.summary(summaryInput).unsupportedChannels).toHaveLength(2);
  });
});
