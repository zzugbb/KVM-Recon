import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startJobWorkspace, type JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { PackIntegrityEvidenceSummary } from '../capture-pack-v2/types';
import { exportJobWorkspaceZip } from './exportJobWorkspaceZip';
import { parseChecksumsManifest, sha256OfContent } from './checksumsManifest';
import { verifyPackV2Zip } from './exportPackV2Zip';

/**
 * 阶段 2 完整导出链：workspace raw/catalog 工件 + assembleCapturePackV2 派生
 * 文件（manifest / integrity / report / ai / replay / schema 副本）→ 流式 ZIP →
 * 重开逐条目校验。反例：缺必需工件拒绝导出且不留 ZIP；顶层额外文件拒绝；
 * environment 缺失拒绝装配。
 */

const roots: string[] = [];

async function newRootDir() {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-export-ws-'));
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

function evidenceSummary(workflowStatus: PackIntegrityEvidenceSummary['workflowStatus']): PackIntegrityEvidenceSummary {
  return {
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
    workflowStatus,
  };
}

/** 最小合法 workspace 工件集（PACK_V2_REQUIRED_FILES 中由采集链路落盘的部分）。 */
async function writeMinimalWorkspaceArtifacts(workspace: JobWorkspace, skip?: string) {
  const write = async (path: string, content: string | Uint8Array) => {
    if (path === skip) return;
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

function assemblyInput() {
  return {
    tool: { version: '0.3.0-dev', buildId: 'test-build' },
    environment: { ...ENVIRONMENT },
    evidenceSummary: evidenceSummary('TARGET_OPENED'),
    target: { host: '127.0.0.1', port: 48080, scheme: 'http' as const, originalInput: '127.0.0.1:48080' },
    job: { endedAt: '2026-09-21T10:01:00.000Z', deviceLabel: '测试设备 / 未知厂商' },
  };
}

/** verify 期望清单 = checksums 清单 + checksums.sha256 自身哈希。 */
function expectedEntries(checksums: string) {
  const expected = parseChecksumsManifest(checksums);
  expected.set('checksums.sha256', sha256OfContent(checksums));
  return expected;
}

describe('exportJobWorkspaceZip（阶段 2 完整包装配导出）', () => {
  it('workspace 工件 + 派生文件装配导出，重开逐条目校验通过，TARGET_OPENED 恒为 INCOMPLETE', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-export-full',
      rootDir,
      deviceLabel: '测试设备 / 未知厂商',
      targetUrl: 'http://127.0.0.1:48080',
      startedAt: '2026-09-21T10:00:00.000Z',
    });
    await writeMinimalWorkspaceArtifacts(workspace);

    const zipPath = join(rootDir, 'pack.zip');
    const result = await exportJobWorkspaceZip({
      workspace,
      zipPath,
      assembly: assemblyInput(),
    });

    expect(result.export.zipBytes).toBeGreaterThan(0);
    // 22 个 workspace 工件 + 12 个派生文件 + 32 个 schema 副本 + checksums.sha256
    expect(result.export.entryCount).toBe(22 + 12 + 32 + 1);
    expect(result.status.captureIntegrity).toBe('INCOMPLETE');
    expect(result.derived.reasons).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    expect(result.fileName).toMatch(/^KVM-Recon_\d{8}-\d{6}_127-0-0-1_TARGET-OPENED_INCOMPLETE_[0-9a-f]{6}\.zip$/);
    await verifyPackV2Zip(zipPath, expectedEntries(result.export.checksums));
    await workspace.close();
  });

  it('workspace 额外证据文件（如第二张 DOM 快照）原样进包；checksums 覆盖全部条目', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-export-extra', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact('raw/browser/dom-snapshots/0002-viewer.html', '<!doctype html><p>viewer</p>');

    const zipPath = join(rootDir, 'pack-extra.zip');
    const result = await exportJobWorkspaceZip({
      workspace,
      zipPath,
      assembly: assemblyInput(),
    });
    expect(result.export.entryCount).toBe(22 + 1 + 12 + 32 + 1);
    expect(parseChecksumsManifest(result.export.checksums).has('raw/browser/dom-snapshots/0002-viewer.html')).toBe(true);
    await verifyPackV2Zip(zipPath, expectedEntries(result.export.checksums));
    await workspace.close();
  });

  it('反例：缺必需工件（raw/browser/storage.json）拒绝导出且不留 ZIP', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-export-missing', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace, 'raw/browser/storage.json');

    const zipPath = join(rootDir, 'pack-missing.zip');
    await expect(
      exportJobWorkspaceZip({ workspace, zipPath, assembly: assemblyInput() }),
    ).rejects.toThrow('REQUIRED_FILE_MISSING');
    await expect(stat(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await workspace.close();
  });

  it('反例：顶层额外工件（RECOVERY.md）被布局门禁拒绝', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-export-toplevel', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);

    const zipPath = join(rootDir, 'pack-toplevel.zip');
    await expect(
      exportJobWorkspaceZip({
        workspace,
        zipPath,
        assembly: assemblyInput(),
        extraArtifacts: [
          { path: 'RECOVERY.md', source: { kind: 'bytes', data: '崩溃恢复导出说明\n' } },
        ],
      }),
    ).rejects.toThrow('UNEXPECTED_TOP_LEVEL_ENTRY');
    await expect(stat(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await workspace.close();
  });

  it('反例：额外工件与派生路径冲突（manifest.json）被导出器拒绝', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-export-conflict', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);

    const zipPath = join(rootDir, 'pack-conflict.zip');
    await expect(
      exportJobWorkspaceZip({
        workspace,
        zipPath,
        assembly: assemblyInput(),
        extraArtifacts: [
          { path: 'manifest.json', source: { kind: 'bytes', data: '{}' } },
        ],
      }),
    ).rejects.toThrow('ZIP 内路径重复');
    await workspace.close();
  });

  it('反例：environment 缺失（页面环境未采集）拒绝装配导出', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-export-noenv', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);

    const zipPath = join(rootDir, 'pack-noenv.zip');
    const input = assemblyInput();
    await expect(
      exportJobWorkspaceZip({
        workspace,
        zipPath,
        assembly: { ...input, environment: null },
      }),
    ).rejects.toThrow('采集环境缺失');
    await expect(stat(zipPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await workspace.close();
  });
});
