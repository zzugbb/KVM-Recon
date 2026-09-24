/**
 * capture:start 失败收尾（规范 §9：失败显式记账；派生物失败不阻断现场保留）。
 *
 * start() 中途失败（writeProbeFile 落盘失败、窗口创建失败等）时，工作区
 * 已创建并持有租约；不做收尾会把作业滞留在 active + 租约被持有——
 * stop / export / discard 全部拒绝，重启后恢复流程又对缺 capture-facts 的
 * active 工作区反复挂起，只能人工删目录。
 *
 * best-effort 收尾（与手动 stop 同一路径）：controller.stop() 的收尾序列
 * 自身补写 capture-facts（真实摘要）并 finalize（现场保留）。finalize
 * 落盘成功 → finalized=true，调用方接管为当前作业（activeController），
 * 界面可导出未完整包 / 零观察事实时直接丢弃。finalize 未落盘（收尾序列
 * 中 finalize 失败，已记 droppedEvent）→ 退化为释放窗口与租约
 * （workspace.close()），现场资料保留在磁盘，重启后走恢复卡。
 */

import type { JobWorkspace } from '../../core/job-workspace/createJobWorkspace';
import { recordCaptureWindowLog } from './captureWindowDiagnostics';

/** 生产 Controller 的收尾面（结构子集：失败注入测试用真实采集会话替身）。 */
export interface FailedStartController {
  readonly session: { readonly workspace: JobWorkspace };
  stop(): Promise<void>;
  closeWindows(): Promise<void>;
}

export interface FailedStartOutcome {
  /** true = 已收尾（调用方置 activeController = controller，UI 可导出/丢弃）。 */
  finalized: boolean;
  /** 给用户的显式错误：原始失败原因 + 作业去向。 */
  error: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function finalizeFailedStart(
  controller: FailedStartController,
  cause: unknown,
): Promise<FailedStartOutcome> {
  const workspace = controller.session.workspace;
  const causeText = messageOf(cause);
  recordCaptureWindowLog(`capture-start-failed ${workspace.jobId} ${causeText}`);
  try {
    await controller.stop();
    if (workspace.state !== 'finalized') {
      throw new Error('收尾序列未把工作区带入 finalized（finalize 失败已记 droppedEvent）');
    }
    await controller.closeWindows();
    return {
      finalized: true,
      error: `采集启动失败（作业 ${workspace.jobId} 已收尾保留：可在界面上导出未完整包，零观察事实时可直接丢弃）：${causeText}`,
    };
  } catch (finalizeError) {
    recordCaptureWindowLog(`capture-start-finalize-failed ${workspace.jobId} ${messageOf(finalizeError)}`);
    // 窗口与租约 best-effort 释放；作业已不可接管，释放失败只记日志
    await controller.closeWindows().catch(error =>
      recordCaptureWindowLog(`capture-start-close-windows-failed ${workspace.jobId} ${messageOf(error)}`),
    );
    await workspace.close().catch(error =>
      recordCaptureWindowLog(`capture-start-close-failed ${workspace.jobId} ${messageOf(error)}`),
    );
    return {
      finalized: false,
      error: `采集启动失败且收尾未完成（作业 ${workspace.jobId} 已释放租约，现场资料保留；重启后将按恢复卡提示处理）：${causeText}`,
    };
  }
}
