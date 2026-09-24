import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startCaptureSession, type CaptureSession } from '../../core/collector/createCaptureSession';
import { readCaptureFacts } from '../../core/collector/captureFacts';
import { recoverCrashedJob } from '../../core/export/recoverCrashedJob';
import { finalizeFailedStart, type FailedStartController } from './failedStartFinalizer';

/**
 * capture:start 失败收尾：start 中途失败不得把作业滞留在
 * active + 租约被持有（stop/export/discard 全拒绝的死状态）。
 * 用真实采集会话（core，无 Electron）+ 结构 Controller 替身注入失败：
 * - 收尾成功：finalize 落盘 + capture-facts（真实摘要）+ UI 可接管；
 * - 收尾失败（stop 抛错 / finalize 未落盘）：租约释放 + 现场保留，
 *   重启恢复不再死循环（facts 缺失 → 恢复卡 + 零观察事实丢弃出口）。
 */

const roots: string[] = [];

async function newRootDir() {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-failed-start-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function controllerOf(
  session: CaptureSession,
  overrides: Partial<FailedStartController> = {},
): FailedStartController {
  return {
    session,
    stop: () => session.stop(),
    closeWindows: async () => {},
    ...overrides,
  };
}

const TOOL = { version: '0.3.0-dev', buildId: 'test-build' };

describe('finalizeFailedStart（启动失败收尾）', () => {
  it('收尾成功：finalize 落盘 + capture-facts 真实摘要，作业可接管（UI 可导出/丢弃）', async () => {
    const rootDir = await newRootDir();
    const session = await startCaptureSession({
      jobId: 'job-start-fail-finalized',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    const controller = controllerOf(session);

    const outcome = await finalizeFailedStart(controller, new Error('writeProbeFile 落盘失败'));

    expect(outcome.finalized).toBe(true);
    expect(outcome.error).toContain('采集启动失败');
    expect(outcome.error).toContain('job-start-fail-finalized');
    expect(outcome.error).toContain('已收尾保留');

    // 收尾序列自身补写 capture-facts（stop 序列的 safeStep）+ finalize
    expect(session.workspace.state).toBe('finalized');
    expect(session.workspace.exported).toBe(false);
    const facts = await readCaptureFacts(session.workspace);
    expect(facts?.stopped).toBe(true);
    expect(facts?.evidenceSummary).not.toBeNull();
    expect(facts?.target).not.toBeNull();

    await session.workspace.close();
    // 重启：facts 在场（target 有、environment 缺——窗口从未挂载）：
    // 按既有反例拒绝恢复、不挂恢复卡、不阻塞新作业；现场资料保留
    const restart = await recoverCrashedJob({ rootDir, tool: TOOL });
    expect(restart.kind).toBe('refused');
    if (restart.kind !== 'refused') return;
    expect(restart.reason).toContain('environment');
  });

  it('反例：stop 抛错（收尾序列失败）：租约释放 + 现场保留，重启不再死循环', async () => {
    const rootDir = await newRootDir();
    const session = await startCaptureSession({
      jobId: 'job-start-fail-stop-throws',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    const controller = controllerOf(session, {
      stop: async () => {
        throw new Error('收尾序列崩溃');
      },
    });

    const outcome = await finalizeFailedStart(controller, new Error('采集窗口创建失败'));

    expect(outcome.finalized).toBe(false);
    expect(outcome.error).toContain('收尾未完成');
    expect(outcome.error).toContain('租约');
    // 租约已释放（.owner 不在）：重启后 recoverCrashedJob 可接管
    await expect(readFile(join(rootDir, 'current', '.owner'), 'utf-8')).rejects.toThrow();
    expect(session.workspace.state).toBe('active');

    // 重启恢复：capture-facts 缺失 → finalize + 恢复卡挂起（不再 refused
    // 死循环）；零观察事实丢弃是清理出口
    const restart = await recoverCrashedJob({ rootDir, tool: TOOL });
    expect(restart.kind).toBe('recovered');
    if (restart.kind !== 'recovered') return;
    expect(restart.workspace.state).toBe('finalized');
    await restart.workspace.close();
  });

  it('反例：stop 成功但 finalize 未落盘：退化为释放租约，重启走恢复卡', async () => {
    const rootDir = await newRootDir();
    const session = await startCaptureSession({
      jobId: 'job-start-fail-no-finalize',
      rootDir,
      targetUrl: 'https://10.10.8.111:8443/login',
    });
    // stop 是 no-op（模拟收尾序列里 finalize 步骤失败：状态检查不过）
    const controller = controllerOf(session, { stop: async () => {} });

    const outcome = await finalizeFailedStart(controller, new Error('writeProbeFile 落盘失败'));

    expect(outcome.finalized).toBe(false);
    expect(outcome.error).toContain('重启后');
    await expect(readFile(join(rootDir, 'current', '.owner'), 'utf-8')).rejects.toThrow();

    const restart = await recoverCrashedJob({ rootDir, tool: TOOL });
    expect(restart.kind).toBe('recovered');
    if (restart.kind !== 'recovered') return;
    expect(restart.workspace.state).toBe('finalized');
    await restart.workspace.close();
  });
});
