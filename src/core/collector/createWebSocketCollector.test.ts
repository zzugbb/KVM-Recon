/**
 * WebSocket 采集器 flush 失败语义（规范 §9：收尾 best-effort）。
 * 反例：flush 循环中任一 socket 失败直接抛出，剩余 socket 的
 * pending 帧（index/bin）与 metadata 全部静默丢失且无 channelGaps 记账。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import { createWebSocketCollector } from './createWebSocketCollector';
import { createCollectorEvidence } from './collectorEvidence';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('WebSocket 采集器 flush 失败语义', () => {
  it('flush 单 socket 失败：记账后继续，其余 socket 帧与 metadata 不丢失', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kvm-recon-ws-flush-test-'));
    tempRoots.push(rootDir);
    const appended = new Map<string, Array<Record<string, unknown>>>();
    const evidence = createCollectorEvidence();
    const workspace = {
      dir: rootDir,
      appendJsonl: async (path: string, row: Record<string, unknown>) => {
        const rows = appended.get(path) ?? [];
        rows.push(row);
        appended.set(path, rows);
      },
      writeArtifact: async (path: string) => {
        if (path.includes('chan-a')) throw new Error('磁盘写入失败（模拟）');
      },
      trackInFlightWrite: () => () => {},
      assertWritable: () => {},
    } as unknown as JobWorkspace;
    const collector = createWebSocketCollector(workspace, evidence);
    const opened = { url: 'ws://bmc.test/ws', targetId: 'target-root', createdAt: '2026-09-21T01:00:00.000Z' };
    collector.open({ channelId: 'chan-a', ...opened });
    collector.open({ channelId: 'chan-b', ...opened });
    const frame = (payload: string) => ({
      direction: 'down' as const,
      opcode: 'text' as const,
      timestamp: '2026-09-21T01:00:01.000Z',
      payload: Buffer.from(payload),
    });
    await collector.addFrame('chan-a', frame('frame-a'));
    await collector.addFrame('chan-b', frame('frame-b'));
    // flush 允许把首个错误抛给调用方（stop 序列里由 safeStep 记账），
    // 但其余 socket 必须完整落盘。
    await collector.flush().catch(() => {});

    const chanBIndex = appended.get('raw/websocket/chan-b/frames.index.jsonl') ?? [];
    expect(chanBIndex).toHaveLength(1);
    expect((chanBIndex[0] as { payloadLength?: number }).payloadLength).toBe(
      Buffer.byteLength('frame-b'),
    );
    // chan-a 失败有 channelGaps 记账，不是静默
    expect(evidence.diagnostics().gapCounts['channelGaps']).toBeGreaterThanOrEqual(1);
  });
});
