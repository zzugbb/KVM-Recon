/**
 * 作业工作区 → Capture Pack 2.0 ZIP 导出（规范 §9 / §11 / §14，阶段 2）。
 *
 * 派生文件（00_START_HERE / manifest / integrity / report / ai/* / replay/* /
 * schema 副本）由 assembleCapturePackV2 从完整度事实生成；raw/ 与 catalog/
 * 工件全部来自 workspace，逐文件流式写出（ZIP64），checksums 由导出器生成，
 * 绝不在内存拼整包。派生路径与工作区工件冲突（或重复）时导出器拒绝；
 * 包一致性门禁（含全部必需文件与 Schema 校验）不通过时拒绝导出。
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import {
  assembleCapturePackV2,
  type AssembleCapturePackV2Input,
} from '../capture-pack-v2/assembleCapturePackV2';
import type { DerivedPackIntegrity, PackV2StatusTriple } from '../capture-pack-v2/types';
import { exportPackV2Zip, type PackV2ZipExportResult, type ZipArtifact } from './exportPackV2Zip';

export interface ExportJobWorkspaceZipInput {
  workspace: JobWorkspace;
  /** zipPath 与 zipDir 二选一：给目录时按装配出的规范 §10 文件名落盘。 */
  zipPath?: string;
  zipDir?: string;
  /** 包装配输入（环境与完整度事实；workspace 由本函数注入）。 */
  assembly: Omit<AssembleCapturePackV2Input, 'workspace'>;
  /** 额外工件（如崩溃恢复时补充的导出说明）；路径冲突时导出器拒绝。 */
  extraArtifacts?: ReadonlyArray<ZipArtifact>;
}

export interface ExportJobWorkspaceZipResult {
  export: PackV2ZipExportResult;
  status: PackV2StatusTriple;
  derived: DerivedPackIntegrity;
  /** 规范 §10 ZIP 文件名（装配派生，调用方落盘命名参考）。 */
  fileName: string;
}

export async function exportJobWorkspaceZip(
  input: ExportJobWorkspaceZipInput,
): Promise<ExportJobWorkspaceZipResult> {
  if (input.zipPath ? Boolean(input.zipDir) : !input.zipDir) {
    throw new Error('zipPath 与 zipDir 必须二选一');
  }
  const assembled = await assembleCapturePackV2({
    ...input.assembly,
    workspace: input.workspace,
  });
  const paths = await input.workspace.artifactPaths();
  const artifacts: ZipArtifact[] = paths.map(path => ({
    path,
    source: { kind: 'file', absolutePath: join(input.workspace.dir, path) },
  }));
  artifacts.push(
    ...assembled.files.map(file => ({
      path: file.path,
      source: { kind: 'bytes' as const, data: file.content },
    })),
  );
  if (input.extraArtifacts?.length) {
    artifacts.push(...input.extraArtifacts);
  }
  if (input.zipDir) {
    await mkdir(input.zipDir, { recursive: true });
  }
  const zipPath = input.zipPath ?? join(input.zipDir!, assembled.fileName);
  const result = await exportPackV2Zip({ zipPath, artifacts });
  return {
    export: result,
    status: assembled.status,
    derived: assembled.derived,
    fileName: assembled.fileName,
  };
}
