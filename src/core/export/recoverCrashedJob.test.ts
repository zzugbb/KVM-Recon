import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CAPTURE_FACTS_PATH,
  type CaptureFacts,
} from '../collector/captureFacts';
import {
  recoverActiveJobWorkspace,
  startJobWorkspace,
  type JobWorkspace,
} from '../job-workspace/createJobWorkspace';
import { checkUnexportedDiscard } from './discardUnexportedJob';
import { exportRecoveredJob, recoverCrashedJob } from './recoverCrashedJob';

/**
 * 崩溃恢复：恢复只接管 + 保守摘要覆写 + finalize，
 * **不导出、不 markExported、不自动打开目录**——导出由用户在恢复卡上
 * 手动选择目录（exportRecoveredJob），成功才 markExported；取消/失败
 * 保留待导出状态（下次启动幂等再恢复）。
 * close() 保留目录 = 模拟进程死亡（owner 已释放）。
 * capture-facts 缺失按恢复作业挂起（零观察事实丢弃是清理出口）；
 * 反例：environment 缺失拒绝恢复；导出失败不 markExported。
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

describe('recoverCrashedJob（崩溃恢复：只恢复，不导出）', () => {
  it('硬崩溃（v1 facts）：保守摘要覆写 + finalize，不导出、不 markExported', async () => {
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

    const result = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });

    if (result.kind === 'failed') throw new Error(result.error);
    expect(result.kind).toBe('recovered');
    if (result.kind !== 'recovered') return;
    expect(result.conservative).toBe(true);
    expect(result.jobId).toBe('job-recover-crash');
    // 恢复止步于 finalize：工作区保持 finalized-unexported，由用户手动导出
    expect(result.workspace.state).toBe('finalized');
    expect(result.workspace.exported).toBe(false);

    // 恢复后的 capture-facts：保守摘要 + recovered 标记
    const facts = JSON.parse(
      (await readFile(join(rootDir, 'current', CAPTURE_FACTS_PATH))).toString('utf8'),
    );
    expect(facts.recovered).toBe(true);
    expect(facts.stopped).toBe(true);
    expect(facts.evidenceSummary.collectorReadyBeforeFirstNavigation).toBe(false);
    expect(facts.evidenceSummary.rawJournalsClosed).toBe(true);

    // 未导出：不产生任何 ZIP / packs 目录（导出只能由用户手动触发）
    await expect(readFile(join(rootDir, 'packs'))).rejects.toThrow();

    // 收尾：手动导出前释放句柄（模拟待导出挂起）
    await result.workspace.close();
  });

  it('幂等再恢复：恢复覆写过的摘要是保守摘要，二次恢复不得标成真实摘要（三轮审查 T2）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-recover-idempotent',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(v1Facts({ workspaceId: workspace.workspaceId }), null, 2)}\n`,
    );
    await workspace.close();

    const first = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });
    expect(first.kind).toBe('recovered');
    if (first.kind !== 'recovered') return;
    expect(first.conservative).toBe(true);
    await first.workspace.close();

    // 第二次启动：facts.evidenceSummary 已在场，但它是第一次恢复写入的
    // 保守摘要（recovered=true）——不得标成「真实摘要」。
    const second = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      resetStaleOwner: true,
      now: () => '2026-09-21T10:03:00.000Z',
    });
    expect(second.kind).toBe('recovered');
    if (second.kind !== 'recovered') return;
    expect(second.conservative).toBe(true);
    await second.workspace.close();
  });

  it('capture-facts 缺失：恢复后仍有截图与 DOM 证据，不得按零观察行直接丢弃', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-recover-nofacts', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.close();

    const result = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });

    // 不再 refused：refused + active 标记会让每次启动重复拒绝，用户没有
    // UI 入口清理，只能人工删目录
    expect(result.kind).toBe('recovered');
    if (result.kind !== 'recovered') return;
    expect(result.jobId).toBe('job-recover-nofacts');
    expect(result.conservative).toBe(true);
    expect(result.workflowStatus).toBe('TARGET_OPENED');
    expect(result.workspace.state).toBe('finalized');
    expect(result.workspace.exported).toBe(false);

    // 幂等再恢复：二次启动仍是恢复卡（finalized-unexported 可再接管）
    await result.workspace.close();
    const second = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      resetStaleOwner: true,
    });
    expect(second.kind).toBe('recovered');
    if (second.kind !== 'recovered') return;

    // 三类观察行虽然为空，截图和 DOM 仍是现场资料，不能不导出直接清理。
    const check = await checkUnexportedDiscard(second.workspace);
    expect(check.ok).toBe(false);
    expect(check.counts).toEqual({ transactions: 0, channels: 0, actions: 0 });
    expect(check.note).toMatch(/raw\/browser\/(?:screenshots|dom-snapshots)\//);
    await second.workspace.close();
    const third = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });
    expect(third.kind).toBe('recovered');
    if (third.kind === 'recovered') await third.workspace.close();
  });

  it('反例：facts 缺失但有观察事实（挂载中途崩溃）：恢复卡挂起，丢弃门禁拒绝（现场资料保留）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-recover-nofacts-rows', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact(
      'raw/http/transactions.jsonl',
      `${JSON.stringify({ requestId: 'http-000001', url: 'https://10.10.8.111:8443/login', method: 'GET' })}\n`,
    );
    await workspace.close();

    const result = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });
    expect(result.kind).toBe('recovered');
    if (result.kind !== 'recovered') return;

    const check = await checkUnexportedDiscard(result.workspace);
    expect(check.ok).toBe(false);
    expect(check.counts.transactions).toBe(1);
    expect(check.note).toContain('先导出再丢弃');
    await result.workspace.close();
  });

  it('反例：facts 缺 environment（页面环境未采集）拒绝恢复', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-recover-noenv', rootDir });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(v1Facts({ workspaceId: workspace.workspaceId, environment: null }), null, 2)}\n`,
    );
    await workspace.close();

    const result = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toContain('environment');
    // 正式包仍拒绝伪造环境；原始工作区可安全保留并释放下一台入口。
    const retained = await recoverActiveJobWorkspace(rootDir, { resetStaleOwner: true });
    expect(retained).not.toBeNull();
    await retained!.finalize();
    const path = await retained!.retainUnexported();
    expect(await readFile(join(path, 'raw/browser/screenshots/0001.png'))).toHaveLength(4);
    const next = await startJobWorkspace({ jobId: 'job-after-retain', rootDir });
    await next.finalize();
    await next.markExported();
    await next.cleanup();
  });

  it('无可恢复工作区：no-workspace', async () => {
    const rootDir = await newRootDir();
    const result = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });
    expect(result.kind).toBe('no-workspace');
  });
});

describe('exportRecoveredJob（恢复作业手动导出）', () => {
  it('导出成功才 markExported：包 INCOMPLETE 缺口显式在列，ZIP 落在所选目录', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-recover-crash',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(v1Facts({ workspaceId: workspace.workspaceId }), null, 2)}\n`,
    );
    await workspace.close();

    const recovery = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });
    expect(recovery.kind).toBe('recovered');
    if (recovery.kind !== 'recovered') return;

    const result = await exportRecoveredJob({
      workspace: recovery.workspace,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:04:00.000Z',
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.status.captureIntegrity).toBe('INCOMPLETE');
    expect(result.derived.reasons).toContain('INCOMPLETE_TARGET_ATTACH');
    expect(result.derived.reasons).toContain('INCOMPLETE_BROWSER_STATE');
    expect(result.derived.reasons).toContain('INCOMPLETE_EVIDENCE_REFERENCE');
    expect(result.derived.reasons).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    expect(result.fileName).toMatch(/_INCOMPLETE_/);
    expect(result.zipPath.startsWith(join(rootDir, 'packs'))).toBe(true);
    // ZIP 成功后：markExported（此后才允许清理 / 启动下一作业）
    expect(recovery.workspace.exported).toBe(true);
    await recovery.workspace.close();
  });

  it('stop 后未导出（finalized + 真实摘要）：导出用 facts 摘要，非保守', async () => {
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
        browserStateGaps: [],
        evidenceGraphFailures: [],
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

    const recovery = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });
    expect(recovery.kind).toBe('recovered');
    if (recovery.kind !== 'recovered') return;
    expect(recovery.conservative).toBe(false);

    const result = await exportRecoveredJob({
      workspace: recovery.workspace,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:04:00.000Z',
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.status.captureIntegrity).toBe('INCOMPLETE');
    expect(result.derived.reasons).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    // 真实摘要：无 INCOMPLETE_TARGET_ATTACH
    expect(result.derived.reasons).not.toContain('INCOMPLETE_TARGET_ATTACH');
    const facts = JSON.parse(
      (await readFile(join(rootDir, 'current', CAPTURE_FACTS_PATH))).toString('utf8'),
    );
    expect(facts.recovered).toBeUndefined();
    await recovery.workspace.close();
  });

  it('旧格式真实摘要（缺 browserStateGaps/evidenceGraphFailures）：读取侧补缺省空数组，恢复导出不崩溃', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-recover-legacy-summary',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    await writeMinimalWorkspaceArtifacts(workspace);
    // 新字段落盘前写的旧格式 stopped facts：真实摘要没有两个新字段
    const legacySummary = {
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
    } as Record<string, unknown>;
    const legacyFacts = v1Facts({
      jobId: 'job-recover-legacy-summary',
      workspaceId: workspace.workspaceId,
      endedAt: '2026-09-21T10:01:00.000Z',
      stopped: true,
      evidenceSummary: null,
    });
    const onDisk: Record<string, unknown> = { ...legacyFacts, evidenceSummary: legacySummary };
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(onDisk, null, 2)}\n`,
    );
    await workspace.finalize();
    await workspace.close();

    const recovery = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });
    expect(recovery.kind).toBe('recovered');
    if (recovery.kind !== 'recovered') return;
    expect(recovery.conservative).toBe(false);

    const result = await exportRecoveredJob({
      workspace: recovery.workspace,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:04:00.000Z',
    });
    // 旧格式摘要按空缺口数组处理：门禁走布尔通道全过，导出成功，不抛 TypeError
    if (!result.ok) throw new Error(result.error);
    expect(result.status.captureIntegrity).toBe('INCOMPLETE');
    expect(result.derived.reasons).toContain('INCOMPLETE_WORKFLOW_NOT_REACHED');
    expect(result.derived.reasons).not.toContain('INCOMPLETE_BROWSER_STATE');
    expect(result.derived.reasons).not.toContain('INCOMPLETE_EVIDENCE_REFERENCE');
    await recovery.workspace.close();
  });

  it('导出失败不 markExported：待导出状态保留可重试', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-recover-retry',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    await writeMinimalWorkspaceArtifacts(workspace);
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(v1Facts({ workspaceId: workspace.workspaceId }), null, 2)}\n`,
    );
    await workspace.close();

    const recovery = await recoverCrashedJob({
      rootDir,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
      now: () => '2026-09-21T10:02:00.000Z',
    });
    expect(recovery.kind).toBe('recovered');
    if (recovery.kind !== 'recovered') return;

    // zipDir 是一个已存在的文件：mkdir 失败 → 导出失败
    const blockedPath = join(rootDir, 'not-a-dir');
    await writeFile(blockedPath, 'x');
    const failed = await exportRecoveredJob({
      workspace: recovery.workspace,
      zipDir: blockedPath,
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toBeTruthy();
    // 失败不 markExported：待导出状态保留
    expect(recovery.workspace.exported).toBe(false);

    // 重试（换有效目录）成功
    const retried = await exportRecoveredJob({
      workspace: recovery.workspace,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });
    if (!retried.ok) throw new Error(retried.error);
    expect(recovery.workspace.exported).toBe(true);
    await recovery.workspace.close();
  });

  it('反例：facts 缺 evidenceSummary（未经恢复接管的畸形现场）拒绝导出，现场保留', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-recover-nosummary',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    await writeMinimalWorkspaceArtifacts(workspace);
    // v1Facts 默认 evidenceSummary: null —— 绕过 recoverCrashedJob 的保守摘要覆写直接导出
    await workspace.writeArtifact(
      CAPTURE_FACTS_PATH,
      `${JSON.stringify(v1Facts({ workspaceId: workspace.workspaceId }), null, 2)}\n`,
    );
    await workspace.finalize();
    await workspace.close();

    const recovered = await recoverActiveJobWorkspace(rootDir, { resetStaleOwner: true });
    expect(recovered).not.toBeNull();
    if (!recovered) return;
    const result = await exportRecoveredJob({
      workspace: recovered,
      zipDir: join(rootDir, 'packs'),
      tool: { version: '0.3.0-dev', buildId: 'test-build' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('evidenceSummary');
    expect(result.error).toContain('保留');
    expect(recovered.exported).toBe(false);
    await recovered.close();
  });
});
