/**
 * 崩溃恢复（规范 §3 / §4.2）。
 *
 * 恢复止步于 finalize：不导出、不 markExported、不自动打开目录——
 * 由用户在恢复卡上手动选择目录导出（exportRecoveredJob），ZIP 自检
 * 成功才 markExported；取消/失败保留待导出状态（finalized-unexported，
 * 下次启动幂等再恢复提示）。
 *
 * 恢复阶段：recoverActiveJobWorkspace 接管 → 读 catalog/capture-facts.json
 * （单一事实来源）→ active 作业用保守证据摘要覆写 facts（recovered=true）
 * → finalize。
 *
 * capture-facts 缺失（stop 收尾从未落盘）按恢复作业挂起：finalize 后
 * 挂起为待导出（只有确无其他现场证据时恢复卡才允许丢弃），不再 close 后留
 * active 标记造成每次启动重复接管、重复拒绝。target/environment 缺失
 * （采集未真正开始但 facts 已落盘）仍显式拒绝恢复，现场资料保留供
 * 人工检查。装配/导出门禁失败同样保留工作区，绝不产生半包。
 */

import type { DerivedPackIntegrity, PackV2Status } from '../capture-pack-v2/types';
import {
  CAPTURE_FACTS_PATH,
  conservativeRecoveredEvidenceSummary,
  readCaptureFacts,
  type CaptureFacts,
} from '../collector/captureFacts';
import {
  recoverActiveJobWorkspace,
  type JobWorkspace,
} from '../job-workspace/createJobWorkspace';
import { exportJobWorkspaceZip } from './exportJobWorkspaceZip';
import type { PackV2ZipExportResult } from './exportPackV2Zip';

export interface RecoverCrashedJobInput {
  rootDir: string;
  tool: { version: string; buildId: string };
  /** 已确认单实例（requestSingleInstanceLock）后接管已死属主的工作区。 */
  resetStaleOwner?: boolean;
  now?: () => string;
}

export type RecoverCrashedJobResult =
  | { kind: 'no-workspace'; jobId?: undefined }
  | {
      kind: 'recovered';
      jobId: string;
      workspaceId: string;
      /** 恢复后的工作区（finalized-unexported）：由调用方持有，导出成功才 markExported。 */
      workspace: JobWorkspace;
      /** true = 保守摘要（硬崩溃覆写，或摘要是上次恢复写入的保守值）；false = stop 收尾落盘的真实摘要。 */
      conservative: boolean;
      workflowStatus: CaptureFacts['workflowStatus'];
      targetUrl: string;
      deviceLabel: string;
    }
  | { kind: 'refused'; jobId: string; reason: string }
  | { kind: 'failed'; jobId: string; error: string };

export async function recoverCrashedJob(
  input: RecoverCrashedJobInput,
): Promise<RecoverCrashedJobResult> {
  const workspace = await recoverActiveJobWorkspace(input.rootDir, {
    resetStaleOwner: input.resetStaleOwner ?? false,
  });
  if (!workspace) return { kind: 'no-workspace' };
  try {
    const facts = await readCaptureFacts(workspace);
    if (!facts) {
      // capture-facts 缺失 = stop 收尾从未落盘（首根挂载前 / 挂载中途崩溃；
      // 挂载中途崩溃时仍可能有截图、脚本或探测事实，丢弃门禁会一并检查，
      // 不在这里假设）。finalize 后按恢复作业挂起（恢复卡上的导出 / 零观察
      // 事实丢弃是清理出口），不再「close 后留 active 标记」——那会让每次
      // 启动重复接管、重复拒绝，用户没有 UI 入口清理，只能人工删目录。
      // 现场资料保留在磁盘上（finalize 只收尾不删数据）；恢复卡上的导出会
      // 因 facts 缺失被拒绝（诚实报错），零观察事实丢弃是清理出口。
      if (workspace.state === 'active') {
        await workspace.finalize();
      }
      return {
        kind: 'recovered',
        jobId: workspace.jobId,
        workspaceId: workspace.workspaceId,
        workspace,
        conservative: true,
        // 没有任何观察事实，派生不出更高状态：诚实下限
        workflowStatus: 'TARGET_OPENED',
        targetUrl: workspace.targetUrl ?? '',
        deviceLabel: workspace.deviceLabel ?? '',
      };
    }
    if (!facts.target || !facts.environment) {
      await workspace.close().catch(() => undefined);
      return {
        kind: 'refused',
        jobId: workspace.jobId,
        reason: `capture-facts 缺少 ${!facts.target ? 'target' : 'environment'}（采集未真正开始），拒绝恢复；现场资料已保留`,
      };
    }

    let conservative = false;
    const now = input.now ?? (() => new Date().toISOString());
    if (!facts.evidenceSummary) {
      conservative = true;
      const evidenceSummary = conservativeRecoveredEvidenceSummary(facts, {
        storageLimitReached: workspace.storageLimited,
        workflowStatus: facts.workflowStatus,
      });
      // 硬崩溃：用保守摘要覆写 facts（recovered=true 是导出包里的显式痕迹）
      await workspace.writeArtifact(
        CAPTURE_FACTS_PATH,
        `${JSON.stringify(recoveredFacts(facts, evidenceSummary, now()), null, 2)}\n`,
      );
    } else if (facts.recovered === true) {
      // facts 的摘要是上次恢复覆写的保守摘要（recovered=true 痕迹），
      // 不是 stop 收尾落盘的真实摘要——不得标成「真实摘要」。
      conservative = true;
    }
    if (workspace.state === 'active') {
      await workspace.finalize();
    }
    return {
      kind: 'recovered',
      jobId: workspace.jobId,
      workspaceId: workspace.workspaceId,
      workspace,
      conservative,
      workflowStatus: facts.workflowStatus,
      targetUrl: facts.targetUrl ?? '',
      deviceLabel: facts.deviceLabel ?? '',
    };
  } catch (error) {
    await workspace.close().catch(() => undefined);
    return {
      kind: 'failed',
      jobId: workspace.jobId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ExportRecoveredJobInput {
  /** recoverCrashedJob 返回的待导出工作区（finalized-unexported）。 */
  workspace: JobWorkspace;
  zipDir: string;
  tool: { version: string; buildId: string };
  schemaSourceDir?: string;
  now?: () => string;
}

export type ExportRecoveredJobResult =
  | {
      ok: true;
      export: PackV2ZipExportResult;
      zipPath: string;
      fileName: string;
      status: PackV2Status;
      derived: DerivedPackIntegrity;
    }
  | { ok: false; error: string };

/**
 * 恢复作业手动导出：重新读 capture-facts（单一事实来源）→
 * exportJobWorkspaceZip → ZIP 自检成功才 markExported；失败不 markExported
 * （待导出状态保留，可重试），不 close 工作区。
 */
export async function exportRecoveredJob(
  input: ExportRecoveredJobInput,
): Promise<ExportRecoveredJobResult> {
  const { workspace } = input;
  try {
    const facts = await readCaptureFacts(workspace);
    if (!facts) {
      return { ok: false, error: 'catalog/capture-facts.json 缺失，无法导出；现场资料已保留' };
    }
    if (!facts.target || !facts.environment || !facts.evidenceSummary) {
      return {
        ok: false,
        error: `capture-facts 缺少 ${!facts.target ? 'target' : !facts.environment ? 'environment' : 'evidenceSummary'}，拒绝装配导出；现场资料已保留`,
      };
    }
    const now = input.now ?? (() => new Date().toISOString());
    const endedAt = facts.endedAt ?? now();
    const result = await exportJobWorkspaceZip({
      workspace,
      zipDir: input.zipDir,
      assembly: {
        tool: input.tool,
        environment: facts.environment,
        evidenceSummary: facts.evidenceSummary,
        target: { ...facts.target },
        job: {
          endedAt,
          deviceLabel: facts.deviceLabel ?? undefined,
        },
        ...(input.schemaSourceDir ? { schemaSourceDir: input.schemaSourceDir } : {}),
      },
    });
    await workspace.markExported();
    return {
      ok: true,
      export: result.export,
      zipPath: result.export.zipPath,
      fileName: result.fileName,
      status: result.status,
      derived: result.derived,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function recoveredFacts(
  facts: CaptureFacts,
  evidenceSummary: CaptureFacts['evidenceSummary'],
  endedAt: string,
): CaptureFacts {
  return {
    ...facts,
    endedAt,
    stopped: true,
    recovered: true,
    evidenceSummary,
  };
}
