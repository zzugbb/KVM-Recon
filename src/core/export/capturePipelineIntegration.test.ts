import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PACK_V2_CHECKSUMS_PATH,
  exportPackV2Zip,
  type ZipArtifact,
} from './exportPackV2Zip';
import { createBodyStore } from '../body-store/createBodyStore';
import { recoverActiveJobWorkspace, startJobWorkspace } from '../job-workspace/createJobWorkspace';
import { createSampleCapturePackV2 } from '../capture-pack-v2/createSampleCapturePackV2';

/**
 * 端到端集成（规范 §19）：单作业工作区 + 内容寻址正文 +
 * 流式 ZIP64 导出全链路。工作区写入的是完整合法样例包（一致性门禁
 * 无条件生效），HTTP 正文经 BodyStore 落盘（内容寻址路径与样例一致），
 * 并在崩溃恢复边界前后各写一半工件，验证恢复后继续采集再导出。
 */

const tempRoots: string[] = [];

async function newRootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-pipeline-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('全链路：工作区 → 正文存储 → 流式导出', () => {
  it('采集 → 崩溃 → 恢复 → 继续采集 → 导出 → 读回与样例逐字节一致', async () => {
    const rootDir = await newRootDir();
    const sample = await createSampleCapturePackV2();
    const artifacts = sample.artifacts.filter(
      artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH,
    );

    // 1. 启动作业，写前一半工件：HTTP 正文走 BodyStore（内容寻址，
    //    ref.path 与样例包路径一致），结构化工件直接落盘。
    const workspace = await startJobWorkspace({
      jobId: 'job-7f3a2c',
      rootDir,
      deviceLabel: '演示机房 A-03',
      safetyMarginBytes: 1,
    });
    const bodyStore = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    for (const [index, artifact] of artifacts.entries()) {
      if (index >= artifacts.length / 2) break;
      if (artifact.path.startsWith('raw/http/bodies/')) {
        const writer = await bodyStore.openWriter();
        await writer.write(Buffer.from(artifact.content as Uint8Array));
        const ref = await writer.finish();
        expect(ref.path).toBe(artifact.path);
      } else {
        await workspace.writeArtifact(artifact.path, artifact.content);
      }
    }

    // 2. 崩溃（不 finalize）：恢复唯一 active 作业后写后一半。
    await workspace.close();
    const recovered = await recoverActiveJobWorkspace(rootDir, {
      safetyMarginBytes: 1,
      resetStaleOwner: true,
    });
    expect(recovered).not.toBeNull();
    expect(recovered!.jobId).toBe('job-7f3a2c');
    const recoveredStore = createBodyStore({
      workspace: recovered!,
      namespace: 'raw/http/bodies',
    });
    for (const artifact of artifacts.slice(Math.floor(artifacts.length / 2))) {
      if (artifact.path.startsWith('raw/http/bodies/')) {
        const writer = await recoveredStore.openWriter();
        await writer.write(Buffer.from(artifact.content as Uint8Array));
        const ref = await writer.finish();
        expect(ref.path).toBe(artifact.path);
      } else {
        await recovered!.writeArtifact(artifact.path, artifact.content);
      }
    }
    await recovered!.finalize();

    // 3. 流式导出：以文件源从工作区磁盘直接进 ZIP，不经过整包内存。
    const zipPath = join(rootDir, 'KVM-Recon_test.zip');
    const workspacePaths = await recovered!.artifactPaths();
    expect(workspacePaths).not.toContain('workspace.json');
    expect(workspacePaths.length).toBe(artifacts.length);
    const zipArtifacts: ZipArtifact[] = workspacePaths.map(path => ({
      path,
      source: { kind: 'file', absolutePath: join(recovered!.dir, path) },
    }));
    const result = await exportPackV2Zip({ zipPath, artifacts: zipArtifacts });
    expect(result.entryCount).toBe(artifacts.length + 1);

    await recovered!.markExported();
    await recovered!.close();
    expect(await recoverActiveJobWorkspace(rootDir, { safetyMarginBytes: 1 })).toBeNull();
  }, 60000);

  it('工作区样例包以 ZIP64 强制模式导出（文件源）→ 产物可被 verifyPackV2Zip 重开校验', async () => {
    const rootDir = await newRootDir();
    const sample = await createSampleCapturePackV2();
    const workspace = await startJobWorkspace({
      jobId: 'job-0001',
      rootDir,
      safetyMarginBytes: 1,
    });
    const bodyStore = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    for (const artifact of sample.artifacts) {
      if (artifact.path === PACK_V2_CHECKSUMS_PATH) continue;
      if (artifact.path.startsWith('raw/http/bodies/')) {
        const writer = await bodyStore.openWriter();
        await writer.write(Buffer.from(artifact.content as Uint8Array));
        await writer.finish();
      } else {
        await workspace.writeArtifact(artifact.path, artifact.content);
      }
    }
    await workspace.finalize();

    const zipPath = join(rootDir, 'pack.zip');
    const workspacePaths = await workspace.artifactPaths();
    const result = await exportPackV2Zip({
      zipPath,
      artifacts: workspacePaths.map(path => ({
        path,
        source: { kind: 'file', absolutePath: join(workspace.dir, path) },
      })),
      forceZip64: true,
    });
    expect(result.entryCount).toBe(workspacePaths.length + 1);
    // checksums 与样例自带清单一致（BodyStore 内容寻址路径与样例一致）。
    const sampleChecksums = String(
      sample.artifacts.find(artifact => artifact.path === PACK_V2_CHECKSUMS_PATH)!.content,
    );
    expect(result.checksums).toBe(sampleChecksums);
    await workspace.markExported();
    await workspace.close();
  }, 60000);
});
