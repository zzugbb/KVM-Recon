import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import {
  conservativeRecoveredEvidenceSummary,
  parseCaptureTarget,
  readCaptureFacts,
  readCaptureFactsFromBuffer,
  type CaptureFacts,
} from './captureFacts';

/**
 * capture-facts 反例先行：targetUrl 解析失败不猜（null 显式返回）；
 * 残缺 facts 拒绝解析；硬崩溃恢复的保守证据摘要把无法证明的门禁
 * 全部置为不通过（缺失必须显式，规范 §3）。
 */

const tempRoots: string[] = [];

async function newRootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-facts-'));
  tempRoots.push(root);
  return root;
}

describe('parseCaptureTarget（targetUrl → manifest target）', () => {
  it('https / http / 默认端口解析', () => {
    expect(parseCaptureTarget('https://10.10.8.111:8443/login')).toEqual({
      host: '10.10.8.111',
      port: 8443,
      scheme: 'https',
    });
    expect(parseCaptureTarget('http://bmc.local')).toEqual({
      host: 'bmc.local',
      port: 80,
      scheme: 'http',
    });
    expect(parseCaptureTarget('https://bmc.local')).toEqual({
      host: 'bmc.local',
      port: 443,
      scheme: 'https',
    });
  });

  it('反例：空值 / 非 http(s) / 非法 URL 一律 null，不猜', () => {
    expect(parseCaptureTarget(null)).toBeNull();
    expect(parseCaptureTarget('')).toBeNull();
    expect(parseCaptureTarget('ftp://10.10.8.111')).toBeNull();
    expect(parseCaptureTarget('not a url')).toBeNull();
    expect(parseCaptureTarget('http://')).toBeNull();
  });
});

describe('readCaptureFacts（工作区事实读取）', () => {
  it('读取完整 facts；缺失返回 null', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-facts-read', rootDir });
    expect(await readCaptureFacts(workspace)).toBeNull();

    const facts: CaptureFacts = {
      schemaVersion: '1.0.0',
      jobId: workspace.jobId,
      workspaceId: workspace.workspaceId,
      startedAt: workspace.startedAt,
      endedAt: '2026-09-21T10:01:00.000Z',
      deviceLabel: '测试 BMC',
      targetUrl: 'https://10.10.8.111',
      target: { host: '10.10.8.111', port: 443, scheme: 'https' },
      environment: null,
      workflowStatus: 'TARGET_OPENED',
      stopped: true,
      evidenceSummary: {
        collectorReadyBeforeFirstNavigation: true,
        rawJournalsClosed: true,
        browserStateWritten: true,
        evidenceReferencesClosed: true,
        storageLimitReached: false,
        targetAttachFailures: [],
        missingBodies: [],
        missingWorkerSources: [],
        channelGaps: [],
        unsupportedChannels: [],
        journalWriteFailures: [],
        browserStateGaps: [],
        evidenceGraphFailures: [],
        exportValidationFailures: [],
        workflowStatus: 'TARGET_OPENED',
      },
      droppedEventByMethod: { 'observer-hook-failed': 1 },
    };
    await workspace.writeArtifact('catalog/capture-facts.json', JSON.stringify(facts));
    const read = await readCaptureFacts(workspace);
    expect(read?.stopped).toBe(true);
    expect(read?.evidenceSummary?.workflowStatus).toBe('TARGET_OPENED');
    // droppedEventByMethod 快照随 facts 往返保留（包内可见的诊断记账）
    expect(read?.droppedEventByMethod).toEqual({ 'observer-hook-failed': 1 });
    await workspace.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('反例：残缺 facts（缺 workflowStatus / stopped）拒绝解析', () => {
    const base = {
      schemaVersion: '1.0.0',
      jobId: 'job',
      workspaceId: 'ws',
      startedAt: '2026-09-21T10:00:00.000Z',
    };
    expect(() =>
      readCaptureFactsFromBuffer(Buffer.from(JSON.stringify({ ...base, stopped: true }))),
    ).toThrow('capture-facts 不完整');
    expect(() =>
      readCaptureFactsFromBuffer(
        Buffer.from(JSON.stringify({ ...base, stopped: 'yes', workflowStatus: 'TARGET_OPENED' })),
      ),
    ).toThrow('capture-facts 不完整');
    expect(() =>
      readCaptureFactsFromBuffer(
        Buffer.from(JSON.stringify({ ...base, stopped: true, workflowStatus: 'KVM' })),
      ),
    ).toThrow('workflowStatus 非法');
  });

  it('旧格式摘要（缺 browserStateGaps/evidenceGraphFailures）读取侧补缺省空数组（三轮 T10）', () => {
    // 第 12 轮新数组字段落盘前写的真实摘要：读取后两个新字段补 []，
    // 其余字段原样透传——derivePackIntegrity 不因 undefined 崩溃
    const base = {
      schemaVersion: '1.0.0',
      jobId: 'job',
      workspaceId: 'ws',
      startedAt: '2026-09-21T10:00:00.000Z',
      stopped: true,
      workflowStatus: 'TARGET_OPENED',
      evidenceSummary: {
        collectorReadyBeforeFirstNavigation: true,
        rawJournalsClosed: true,
        browserStateWritten: true,
        evidenceReferencesClosed: true,
        storageLimitReached: false,
        targetAttachFailures: [],
        missingBodies: [],
        missingWorkerSources: [],
        channelGaps: [{ id: 'ws-1', detail: '旧格式已有字段' }],
        unsupportedChannels: [],
        journalWriteFailures: [],
        exportValidationFailures: [],
        workflowStatus: 'TARGET_OPENED',
      },
    };
    const facts = readCaptureFactsFromBuffer(Buffer.from(JSON.stringify(base)));
    expect(facts.evidenceSummary?.browserStateGaps).toEqual([]);
    expect(facts.evidenceSummary?.evidenceGraphFailures).toEqual([]);
    // 真实摘要原样透传（不改写既有字段）
    expect(facts.evidenceSummary?.channelGaps).toEqual([{ id: 'ws-1', detail: '旧格式已有字段' }]);
  });
});

describe('conservativeRecoveredEvidenceSummary（硬崩溃恢复保守摘要）', () => {
  it('无法证明的门禁全部不通过；磁盘可证明的 storageLimited 保留', () => {
    const facts = {
      schemaVersion: '1.0.0',
      jobId: 'job',
      workspaceId: 'ws',
      startedAt: '2026-09-21T10:00:00.000Z',
      endedAt: null,
      deviceLabel: null,
      targetUrl: null,
      target: null,
      environment: null,
      workflowStatus: 'TARGET_OPENED',
      stopped: false,
      evidenceSummary: null,
      droppedEventByMethod: null,
    } as const satisfies CaptureFacts;
    const summary = conservativeRecoveredEvidenceSummary(facts, {
      storageLimitReached: true,
      workflowStatus: 'TARGET_OPENED',
    });
    expect(summary.collectorReadyBeforeFirstNavigation).toBe(false);
    expect(summary.browserStateWritten).toBe(false);
    expect(summary.evidenceReferencesClosed).toBe(false);
    expect(summary.storageLimitReached).toBe(true);
    expect(summary.rawJournalsClosed).toBe(true); // FIN 后视 + 延迟落盘设计保证
    expect(summary.workflowStatus).toBe('TARGET_OPENED');
  });
});
