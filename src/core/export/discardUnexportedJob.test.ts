import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startJobWorkspace } from '../job-workspace/createJobWorkspace';
import { checkUnexportedDiscard } from './discardUnexportedJob';

/**
 * 未导出作业的丢弃门禁（零观察事实放宽）。
 * 红线：未导出的现场资料必须保留——有观察事实 / 未收尾 / 行数不可读
 * 一律拒绝；零观察事实（无事务 / 通道 / 动作行）= 没有现场资料，允许
 * cleanup({ allowUnexportedDiscard: true })，普通 cleanup() 仍拒绝。
 */

const roots: string[] = [];

async function newRootDir() {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-discard-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('checkUnexportedDiscard（零观察事实丢弃门禁）', () => {
  it('finalized + 零观察事实：放行，allowUnexportedDiscard 清理删除目录', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-zero', rootDir });
    await workspace.finalize();

    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(true);
    expect(check.counts).toEqual({ transactions: 0, channels: 0, actions: 0 });
    expect(check.note).toContain('零观察事实');

    await workspace.cleanup({ allowUnexportedDiscard: true });
    await expect(stat(workspace.dir)).rejects.toThrow();
  });

  it('反例：零观察事实也不放宽普通 cleanup（不带门禁标志仍拒绝）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-guard', rootDir });
    await workspace.finalize();

    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(true);
    await expect(workspace.cleanup()).rejects.toThrow(/尚未导出/);
    await workspace.close();
  });

  it('反例：有观察事实（事务行）：拒绝丢弃，先导出再丢弃', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-rows', rootDir });
    await workspace.writeArtifact(
      'raw/http/transactions.jsonl',
      `${JSON.stringify({ requestId: 'http-000001', url: 'https://kvm.test/login', method: 'GET' })}\n`,
    );
    await workspace.finalize();

    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(false);
    expect(check.counts.transactions).toBe(1);
    expect(check.note).toContain('先导出再丢弃');
    await workspace.close();
  });

  it('反例：没有三类观察行但有截图或脚本，未导出资料仍须保留', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-screenshot', rootDir });
    await workspace.writeArtifact('raw/browser/screenshots/viewer.png', Buffer.from('image'));
    await workspace.finalize();
    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(false);
    expect(check.note).toContain('viewer.png');
    await workspace.close();
  });

  it('反例：没有三类观察行但 Probe 已运行，仍须导出现场资料', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-probe', rootDir });
    await workspace.writeArtifact('raw/probe/index.json', JSON.stringify({ schemaVersion: '2.0.0', probeRan: true, facts: [{ kind: 'tls', reachable: true }] }));
    await workspace.finalize();
    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(false);
    expect(check.note).toContain('raw/probe/index.json');
    await workspace.close();
  });

  it('反例：HAR 单独留存而事务 journal 为空，不能按零行清理', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-har', rootDir });
    await workspace.writeArtifact('raw/http/session.har', '{"log":{"entries":[{"request":{"url":"https://bmc.test/"}}]}}');
    await workspace.finalize();
    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(false);
    expect(check.note).toContain('raw/http/session.har');
    await workspace.close();
  });

  it('反例：active（未收尾）：一律拒绝——收尾序列可能仍在写观察事实', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-active', rootDir });

    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(false);
    expect(check.note).toContain('先停止并收尾');
    await workspace.close();
  });

  it('反例：观察行数不可读（channels.json 畸形）：不能证明零观察，拒绝', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-unreadable', rootDir });
    await workspace.writeArtifact('catalog/channels.json', '{"schemaVersion":"2.0.0","channels":null}\n');
    await workspace.finalize();

    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(false);
    expect(check.note).toContain('不可读');
    expect(check.note).toContain('保留');
    await workspace.close();
  });

  it('契约：allowUnexportedDiscard 标志不复核行数——门禁是单一判定源，标志信任先过门禁的调用方', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({ jobId: 'job-discard-flag', rootDir });
    await workspace.writeArtifact(
      'raw/browser/actions.jsonl',
      `${JSON.stringify({ actionId: 'act-000001', kind: 'user-action' })}\n`,
    );
    await workspace.finalize();

    // 有观察事实：门禁拒绝——主进程 IPC 丢弃路径先过门禁，拒绝时不置位
    const check = await checkUnexportedDiscard(workspace);
    expect(check.ok).toBe(false);
    expect(check.counts.actions).toBe(1);

    // 标志本身不做行数复核（行为边界如实断言，供审计核对）：绕过门禁硬置
    // 标志的调用方可以删掉未导出现场——所以置位只能发生在门禁放行之后
    await workspace.cleanup({ allowUnexportedDiscard: true });
    await expect(stat(workspace.dir)).rejects.toThrow();
  });
});
