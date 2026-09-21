/**
 * 崩溃恢复导出（规范 §3 / §4.2，阶段 2）。
 *
 * 应用启动时恢复上一个未完成作业：recoverActiveJobWorkspace 接管 →
 * 读 catalog/capture-facts.json（单一事实来源）→ active 作业用保守证据摘要
 * 覆写 facts（recovered=true）→ finalize → exportJobWorkspaceZip → markExported。
 *
 * 显式拒绝：capture-facts 缺失（首个根挂载前崩溃，没有可装配的事实）或
 * target/environment 缺失（采集未真正开始）时拒绝恢复导出，现场资料保留
 * 供人工检查。装配/导出门禁失败同样保留工作区，绝不产生半包。
 */

import type { DerivedPackIntegrity, PackV2StatusTriple } from '../capture-pack-v2/types';
import {
  CAPTURE_FACTS_PATH,
  conservativeRecoveredEvidenceSummary,
  readCaptureFacts,
  type CaptureFacts,
} from '../collector/captureFacts';
import { recoverActiveJobWorkspace } from '../job-workspace/createJobWorkspace';
import { exportJobWorkspaceZip } from './exportJobWorkspaceZip';

export interface RecoverCrashedJobExportInput {
  rootDir: string;
  zipDir: string;
  tool: { version: string; buildId: string };
  /** 已确认单实例（requestSingleInstanceLock）后接管已死属主的工作区。 */
  resetStaleOwner?: boolean;
  schemaSourceDir?: string;
  now?: () => string;
}

export type RecoverCrashedJobExportResult =
  | { kind: 'no-workspace'; jobId?: undefined }
  | {
      kind: 'exported';
      jobId: string;
      workspaceId: string;
      zipPath: string;
      fileName: string;
      status: PackV2StatusTriple;
      derived: DerivedPackIntegrity;
      /** 恢复用了保守摘要（硬崩溃）还是 facts 里的真实摘要（stop 后未导出）。 */
      conservative: boolean;
    }
  | { kind: 'refused'; jobId: string; reason: string }
  | { kind: 'failed'; jobId: string; error: string };

export async function recoverCrashedJobExport(
  input: RecoverCrashedJobExportInput,
): Promise<RecoverCrashedJobExportResult> {
  const workspace = await recoverActiveJobWorkspace(input.rootDir, {
    resetStaleOwner: input.resetStaleOwner ?? false,
  });
  if (!workspace) return { kind: 'no-workspace' };
  try {
    const facts = await readCaptureFacts(workspace);
    if (!facts) {
      return {
        kind: 'refused',
        jobId: workspace.jobId,
        reason:
          'catalog/capture-facts.json 缺失（首个根窗口挂载前已崩溃），没有可装配的事实，拒绝恢复导出；现场资料已保留',
      };
    }
    if (!facts.target || !facts.environment) {
      return {
        kind: 'refused',
        jobId: workspace.jobId,
        reason: `capture-facts 缺少 ${!facts.target ? 'target' : 'environment'}（采集未真正开始），拒绝装配导出；现场资料已保留`,
      };
    }

    let evidenceSummary = facts.evidenceSummary;
    let conservative = false;
    const now = input.now ?? (() => new Date().toISOString());
    if (!evidenceSummary) {
      conservative = true;
      evidenceSummary = conservativeRecoveredEvidenceSummary(facts, {
        storageLimitReached: workspace.storageLimited,
        workflowStatus: facts.workflowStatus,
      });
      // 硬崩溃：用保守摘要覆写 facts（recovered=true 是导出包里的显式痕迹）
      await workspace.writeArtifact(
        CAPTURE_FACTS_PATH,
        `${JSON.stringify(recoveredFacts(facts, evidenceSummary, now()), null, 2)}\n`,
      );
    }
    const endedAt = facts.endedAt ?? now();
    if (workspace.state === 'active') {
      await workspace.finalize();
    }

    const result = await exportJobWorkspaceZip({
      workspace,
      zipDir: input.zipDir,
      assembly: {
        tool: input.tool,
        environment: facts.environment,
        evidenceSummary,
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
      kind: 'exported',
      jobId: workspace.jobId,
      workspaceId: workspace.workspaceId,
      zipPath: result.export.zipPath,
      fileName: result.fileName,
      status: result.status,
      derived: result.derived,
      conservative,
    };
  } catch (error) {
    return {
      kind: 'failed',
      jobId: workspace.jobId,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await workspace.close();
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
