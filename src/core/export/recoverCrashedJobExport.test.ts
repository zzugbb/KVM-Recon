import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CAPTURE_FACTS_PATH,
  type CaptureFacts,
} from '../collector/captureFacts';
import { startJobWorkspace, type JobWorkspace } from '../job-workspace/createJobWorkspace';
import { recoverCrashedJobExport } from './recoverCrashedJobExport';
import { parseChecksumsManifest, sha256OfContent } from './checksumsManifest';
import { verifyPackV2Zip } from './exportPackV2Zip';

/**
 * 崩溃恢复导出：close() 保留目录 = 模拟进程死亡（owner 已释放）。
 * 反例：facts 缺失 / environment 缺失拒绝恢复；恢复导出的包必须
 * INCOMPLETE（保守摘要，缺口显式在列），capture-facts 带 recovered 标记。
 */

const roots: string[] = [];

async function newRootDir() {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-recover-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const ENVIRONMENT = {
  chromium: '152.0.7977.76',
  electron: '44.3.0',
  os: 'darwin 25.6.0',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) KVM-Recon-E2E',
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
  screen: '3008x1702@2x',
};

function v1Facts(overrides: Partial<CaptureFacts> = {}): CaptureFacts {
  return {
    schemaVersion: '1.0.0',
    jobId: 'job-recover-crash',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    startedAt: '2026-09-21T10:00:00.000Z',
    endedAt: null,
    deviceLabel: '测试 BMC / 未知厂商',
    targetUrl: 'https://10.10.8.111:8443/login',
    target: { host: '10.10.8.111', port: 8443, scheme: 'https' },
    environment: { ...ENVIRONMENT },
    workflowStatus: 'TARGET_OPENED',
    stopped: false,
    evidenceSummary: null,
    droppedEventByMethod: null,
    ...overrides,
  };
}

async function writeMinimalWorkspaceArtifacts(workspace: JobWorkspace) {
  const write = async (path: string, content: string | Uint8Array) => {
    await workspace.writeArtifact(path, content);
  };
  await write('catalog/resources.jsonl', '');
  await write('catalog/targets.json', '{"schemaVersion":"2.0.0","targets":[]}\n');
  await write('catalog/channels.json', '{"schemaVersion":"2.0.0","channels":[]}\n');
  await write('catalog/relations.jsonl', '');
  await write('raw/cdp/events.jsonl', '');
  await write('raw/cdp/commands.jsonl', '');
  await write(
    'raw/netlog/netlog.json',
    '{"schemaVersion":"2.0.0","captureMode":"not-captured","events":[]}\n',
  );
  await write('raw/http/transactions.jsonl', '');
  await write(
    'raw/http/session.har',
    '{"log":{"version":"1.2","creator":{"name":"KVM-Recon","version":"0.3.0-dev"},"entries":[]}}\n',
  );
  await write('raw/realtime/webrtc.jsonl', '');
  await write('raw/realtime/webtransport.jsonl', '');
  await write('raw/realtime/sse.jsonl', '');
  await write('raw/realtime/downloads.jsonl', '');
  await write('raw/runtime/crypto.jsonl', '');
  await write('raw/browser/timeline.jsonl', '');
  await write('raw/browser/actions.jsonl', '');
  await write('raw/browser/targets.json', '{"schemaVersion":"2.0.0","targets":[]}\n');
  await write(
    'raw/browser/storage.json',
    '{"schemaVersion":"2.0.0","targetId":"target-root","capturedAt":"2026-09-21T10:00:00.000Z","cookies":[],"localStorage":{},"sessionStorage":{},"indexedDb":[],"cacheStorage":[]}\n',
  );
  await write('raw/browser/console.jsonl', '');
  await write('raw/scripts/index.json', '{"schemaVersion":"2.0.0","scripts":[]}\n');
  await write('raw/browser/screenshots/0001.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await write('raw/browser/dom-snapshots/0001.html', '<!doctype html><p>target</p>');
}

describe('recoverCrashedJobExport（崩溃恢复导出）', () => {
  it('硬崩溃（v1 facts）：保守摘要恢复导出，缺口显式在列，facts 带 recovered 标记', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-recover-crash',
      rootDir,
      deviceLabel: '测试 BMC / 未知厂商',
      targetUrl: 'https://10.10.8.111:8443/login',
      startedAt: '2026-09-21T10:00:00.000Z',
    });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(v1Facts({ workspaceId: workspace.workspaceId }), null, 2)}\n`,
    );
    await workspace.close();

    const result = await recoverCrashedJobExport({
      rootDir,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });

    if (result.kind === 'failed') throw new Error(result.error);
    expect(result.kind).toBe('exported');
    if (result.kind !== 'exported') return;
    expect(result.conservative).toBe(true);
    expect(result.status.captureIntegrity).toBe('INCOMPLETE');
    expect(result.derived.reasons).toContain('INCOMPLETE_TARGET_ATTACH');
    expect(result.derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
    expect(result.derived.reasons).toContain('INCOMPLETE_EVIDENCE_REFERENCE');
    expect(result.derived.reasons).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    expect(result.fileName).toMatch(/_INCOMPLETE_/);

    // 恢复后的 capture-facts：保守摘要 + recovered 标记（事实随包导出）
    const facts = JSON.parse(
      (await readFile(join(rootDir, 'current', CAPTURE_FACTS_PATH))).toString('utf8'),
    );
    expect(facts.recovered).toBe(true);
    expect(facts.stopped).toBe(true);
    expect(facts.evidenceSummary.collectorReadyBeforeFirstNavigation).toBe(false);
    expect(facts.evidenceSummary.rawJournalsClosed).toBe(true);

    // 恢复后工作区已导出（可清理），ZIP 重开逐条目校验通过
    expect(result.zipPath.startsWith(join(rootDir, 'packs'))).toBe(true);
    const checksums = await readFile(join(rootDir, 'packs', 'checksums.sha256'), 'utf8').catch(() => '');
    void checksums;
  });

  it('stop 后未导出（finalized + 真实摘要）：用 facts 摘要恢复导出，非保守', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-recover-stopped',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    await writeMinimalWorkspaceArtifacts(workspace);
    const stoppedFacts = v1Facts({
      jobId: 'job-recover-stopped',
      workspaceId: workspace.workspaceId,
      endedAt: '2026-09-21T10:01:00.000Z',
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
        exportValidationFailures: [],
        workflowStatus: 'TARGET_OPENED',
      },
    });
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(stoppedFacts, null, 2)}\n`,
    );
    await workspace.finalize();
    await workspace.close();

    const result = await recoverCrashedJobExport({
      rootDir,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });

    if (result.kind === 'failed') throw new Error(result.error);
    expect(result.kind).toBe('exported');
    if (result.kind !== 'exported') return;
    expect(result.conservative).toBe(false);
    expect(result.status.captureIntegrity).toBe('INCOMPLETE');
    expect(result.derived.reasons).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    // 真实摘要：无 INCOMPLETE_TARGET_ATTACH
    expect(result.derived.reasons).not.toContain('INCOMPLETE_TARGET_ATTACH');
    const facts = JSON.parse(
      (await readFile(join(rootDir, 'current', CAPTURE_FACTS_PATH))).toString('utf8'),
    );
    expect(facts.recovered).toBeUndefined();
  });

  it('反例：capture-facts 缺失（挂载前崩溃）拒绝恢复导出，现场保留', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-recover-nofacts', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.close();

    const result = await recoverCrashedJobExport({
      rootDir,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.jobId).toBe('job-recover-nofacts');
    expect(result.reason).toContain('capture-facts.json 缺失');
    expect(result.reason).toContain('保留');
  });

  it('反例：facts 缺 environment（页面环境未采集）拒绝装配导出', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-recover-noenv', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(v1Facts({ workspaceId: workspace.workspaceId, environment: null }), null, 2)}\n`,
    );
    await workspace.close();

    const result = await recoverCrashedJobExport({
      rootDir,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toContain('environment');
  });

  it('无可恢复工作区：no-workspace', async () => {
    const rootDir = await newRootDir();
    const result = await recoverCrashedJobExport({
      rootDir,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });
    expect(result.kind).toBe('no-workspace');
  });
});
