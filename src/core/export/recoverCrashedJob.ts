/**
 * 崩溃恢复（规范 §3 / §4.2，阶段 2；第 12 轮拆分）。
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
 * 显式拒绝：capture-facts 缺失（首个根挂载前崩溃，没有可装配的事实）或
 * target/environment 缺失（采集未真正开始）时拒绝恢复，现场资料保留
 * 供人工检查。装配/导出门禁失败同样保留工作区，绝不产生半包。
 */

import type { DerivedPackIntegrity, PackV2StatusTriple } from '../capture-pack-v2/types';
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
      // 拒绝恢复也释放句柄与 .owner 租约：现场资料保留在磁盘上，但本进程
      // 不再滞留持有（下次启动照常幂等再接管、再拒绝）
      await workspace.close().catch(() => undefined);
      return {
        kind: 'refused',
        jobId: workspace.jobId,
        reason:
          'catalog/capture-facts.json 缺失（首个根窗口挂载前已崩溃），没有可装配的事实，拒绝恢复；现场资料已保留',
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
      status: PackV2StatusTriple;
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
