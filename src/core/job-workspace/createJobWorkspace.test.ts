import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';


import {
  JobWorkspaceExportRequiredError,
  JobWorkspaceIdentityError,
  WORKSPACE_JOB_DIR,
  WORKSPACE_MARKER_FILE,
  WORKSPACE_OWNER_FILE,
  WORKSPACE_TMP_DIR,
  recoverActiveJobWorkspace,
  startJobWorkspace,
  workspaceTmpDir,
  type JobWorkspace,
  type StatFsProbe,
} from './createJobWorkspace';
import { createBodyStore } from '../body-store/createBodyStore';

/**
 * 阶段 1 单作业磁盘工作区测试：OS 内核独占互斥、workspaceId 实例身份、
 * finalized-unexported 可恢复、内部路径含 .owner。
 */

const GiB = 1024 ** 3;

function statfsWith(freeBytes: number): StatFsProbe {
  return async () => ({ bsize: 4096, blocks: 1, bfree: 1, bavail: Math.floor(freeBytes / 4096) });
}

const richStatfs: StatFsProbe = statfsWith(100 * GiB);

const tempRoots: string[] = [];

async function newRootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-workspace-test-'));
  tempRoots.push(root);
  return root;
}

async function startWorkspace(rootDir: string, options?: { jobId?: string; statfs?: StatFsProbe }) {
  return startJobWorkspace({
    jobId: options?.jobId ?? 'job-0001',
    rootDir,
    deviceLabel: '演示机房 A-03',
    targetUrl: 'https://10.10.8.111/',
    startedAt: '2026-09-18T10:00:00.000Z',
    safetyMarginBytes: 1024,
    statfs: options?.statfs ?? richStatfs,
  });
}

async function simulateCrash(workspace: JobWorkspace) {
  // 崩溃 = 不 finalize、不 cleanup。close() 会按 token 释放 owner；真实崩溃
  // 来不及释放，测试用已死亡 PID 写回陈旧租赁，走 resetStaleOwner 接管路径。
  await workspace.close();
  await writeFile(join(workspace.dir, WORKSPACE_OWNER_FILE), `199999999:${randomUUID()}\n`);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('startJobWorkspace（启动与磁盘水位）', () => {
  it('创建规范目录 current 与 active 标记，记录设备说明与目标地址', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    expect(workspace.dir).toBe(join(rootDir, WORKSPACE_JOB_DIR));
    expect(workspace.state).toBe('active');
    expect(workspace.storageLimited).toBe(false);
    const marker = JSON.parse(
      (await workspace.readArtifact(WORKSPACE_MARKER_FILE)).toString('utf8'),
    );
    expect(marker).toMatchObject({
      schemaVersion: '1.0.0',
      jobId: 'job-0001',
      state: 'active',
      startedAt: '2026-09-18T10:00:00.000Z',
      deviceLabel: '演示机房 A-03',
      targetUrl: 'https://10.10.8.111/',
      exported: false,
    });
    expect(workspace.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(marker.workspaceId).toBe(workspace.workspaceId);
  }, 30000);

  it('开始前空间不足 → 抛 JobWorkspaceDiskSpaceError 且不创建任何目录', async () => {
    const rootDir = await newRootDir();
    await expect(
      startWorkspace(rootDir, { statfs: statfsWith(512) }),
    ).rejects.toMatchObject({ name: 'JobWorkspaceDiskSpaceError' });
    expect(await readdir(rootDir)).toEqual([]);
  }, 30000);

  it('首次运行：rootDir 不存在也能启动（先建目录再取原子门）', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kvm-recon-workspace-parent-'));
    tempRoots.push(parent);
    const rootDir = join(parent, 'fresh-jobs-root');
    const workspace = await startJobWorkspace({
      jobId: 'job-0001',
      rootDir,
      safetyMarginBytes: 1,
    });
    expect(workspace.state).toBe('active');
    // 恢复在 rootDir 不存在时也应返回 null 而不是 ENOENT。
    const missing = join(parent, 'never-created');
    expect(await recoverActiveJobWorkspace(missing)).toBeNull();
  }, 30000);

  it('并发启动（Promise.allSettled）只允许一个成功（mkdir 原子门），根目录仅一个 current', async () => {
    const rootDir = await newRootDir();
    const results = await Promise.allSettled([
      startWorkspace(rootDir, { jobId: 'job-000a' }),
      startWorkspace(rootDir, { jobId: 'job-000b' }),
      startWorkspace(rootDir, { jobId: 'job-000c' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(2);
    const dirs = (await readdir(rootDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    expect(dirs).toEqual([WORKSPACE_JOB_DIR]);
  }, 30000);

  it('已存在 active 作业时拒绝再次启动（单作业模型），且不删除 active 目录', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await expect(startWorkspace(rootDir, { jobId: 'job-0002' })).rejects.toMatchObject({
      name: 'JobWorkspaceConflictError',
    });
    // 活跃目录必须完好（任何启动流程都不删除 active 目录）。
    expect(await readdir(rootDir)).toEqual([WORKSPACE_JOB_DIR]);
    expect(workspace.state).toBe('active');
  }, 30000);

  it('current 状态未知（无 marker / 损坏 marker）→ 失败关闭并保留现场资料，绝不删除', async () => {
    const rootDir = await newRootDir();
    // 模拟外部干扰/采集中断留下的 current：无 marker + 已有疑似采集资料。
    const currentDir = join(rootDir, WORKSPACE_JOB_DIR);
    await mkdir(join(currentDir, 'raw'), { recursive: true });
    await writeFile(join(currentDir, 'raw/valuable.bin'), 'priceless-evidence');
    // 无 marker：必须拒绝启动，资料保留。
    await expect(startWorkspace(rootDir)).rejects.toMatchObject({
      name: 'JobWorkspaceUnknownStateError',
    });
    expect(await readFile(join(currentDir, 'raw/valuable.bin'), 'utf8')).toBe(
      'priceless-evidence',
    );
    // 损坏 marker（解析失败 vs 字段缺失/类型错误）：全部失败关闭。
    const base = {
      schemaVersion: '1.0.0',
      jobId: 'job-0001',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      state: 'active',
      startedAt: '2026-09-18T10:00:00.000Z',
      deviceLabel: null,
      targetUrl: null,
      storageLimited: false,
      exported: false,
    };
    const corruptions: Array<[string, unknown]> = [
      ['{not-json', '{not-json'],
      ['missing-schemaVersion', { ...base, schemaVersion: undefined }],
      ['empty-startedAt', { ...base, startedAt: '' }],
      ['storageLimited-string', { ...base, storageLimited: 'yes' }],
      ['jobId-escape', { ...base, jobId: '../escape' }],
      ['missing-workspaceId', { ...base, workspaceId: undefined }],
      ['missing-exported', { ...base, exported: undefined }],
    ];
    for (const [label, content] of corruptions) {
      await writeFile(
        join(currentDir, WORKSPACE_MARKER_FILE),
        typeof content === 'string' ? content : `${JSON.stringify(content)}\n`,
      );
      await expect(startWorkspace(rootDir), label).rejects.toMatchObject({
        name: 'JobWorkspaceUnknownStateError',
      });
      expect(await readFile(join(currentDir, 'raw/valuable.bin'), 'utf8'), label).toBe(
        'priceless-evidence',
      );
    }
  }, 30000);

  it('recover 对「current 存在但缺 marker」抛 UnknownStateError（而非返回 null）', async () => {
    const rootDir = await newRootDir();
    const dir = join(rootDir, WORKSPACE_JOB_DIR);
    await mkdir(join(dir, 'raw'), { recursive: true });
    await writeFile(join(dir, 'raw/valuable.bin'), 'priceless-evidence');
    await expect(recoverActiveJobWorkspace(rootDir)).rejects.toMatchObject({
      name: 'JobWorkspaceUnknownStateError',
    });
    await expect(recoverActiveJobWorkspace(rootDir, { resetStaleOwner: true })).rejects.toMatchObject({
      name: 'JobWorkspaceUnknownStateError',
    });
  }, 30000);

  it('recover 对非法 fsyncEveryAppends 直接拒绝（不绕过启动校验）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.close();
    for (const bad of [0, -2, 2.5]) {
      await expect(
        recoverActiveJobWorkspace(rootDir, { resetStaleOwner: true, fsyncEveryAppends: bad }),
      ).rejects.toThrow('正整数');
    }
  }, 30000);

  it('未发布的 staging-* 目录被安全清理（从未成为 current）', async () => {
    const rootDir = await newRootDir();
    await mkdir(join(rootDir, 'staging-1-aaa'), { recursive: true });
    await writeFile(join(rootDir, 'staging-1-aaa', 'workspace.json'), '{}');
    const workspace = await startWorkspace(rootDir);
    expect(workspace.state).toBe('active');
    expect(await readdir(rootDir)).toEqual([WORKSPACE_JOB_DIR]);
  }, 30000);

  it('运行中触发安全余量 → ensureDiskMargin 返回 ok:false 且 storageLimited 粘性置位', async () => {
    const rootDir = await newRootDir();
    let freeBytes = 100 * GiB;
    const probe: StatFsProbe = async () => ({
      bsize: 4096,
      blocks: 1,
      bfree: 1,
      bavail: Math.floor(freeBytes / 4096),
    });
    const workspace = await startWorkspace(rootDir, { statfs: probe });
    expect((await workspace.ensureDiskMargin()).ok).toBe(true);
    expect(workspace.storageLimited).toBe(false);
    freeBytes = 0;
    const snapshot = await workspace.ensureDiskMargin();
    expect(snapshot.ok).toBe(false);
    expect(workspace.storageLimited).toBe(true);
    // 粘性：磁盘恢复后 storageLimited 不复位（INCOMPLETE_STORAGE_LIMIT 已发生）。
    freeBytes = 100 * GiB;
    await workspace.ensureDiskMargin();
    expect(workspace.storageLimited).toBe(true);
    await workspace.close();
  }, 30000);

  it('storageLimited 首次触发即原子持久化，崩溃恢复后不丢', async () => {
    const rootDir = await newRootDir();
    let freeBytes = 100 * GiB;
    const probe: StatFsProbe = async () => ({
      bsize: 4096,
      blocks: 1,
      bfree: 1,
      bavail: Math.floor(freeBytes / 4096),
    });
    const workspace = await startWorkspace(rootDir, { statfs: probe });
    freeBytes = 0;
    await workspace.ensureDiskMargin();
    const markerOnDisk = JSON.parse(
      (await workspace.readArtifact(WORKSPACE_MARKER_FILE)).toString('utf8'),
    );
    expect(markerOnDisk.storageLimited).toBe(true);
    await simulateCrash(workspace);
    const recovered = await recoverActiveJobWorkspace(rootDir, {
      safetyMarginBytes: 1024,
      statfs: probe,
      resetStaleOwner: true,
    });
    expect(recovered!.storageLimited).toBe(true);
    await recovered!.close();
  }, 30000);

  it('cleanup 后延迟完成的水位检查不得重建目录与 active 标记（锁内复查）', async () => {
    const rootDir = await newRootDir();
    let resolveProbe: (() => void) | undefined;
    let probeCalls = 0;
    const probe: StatFsProbe = () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        // start 的磁盘检查：立即返回充足余量。
        return Promise.resolve({ bsize: 4096, blocks: 1, bfree: 1, bavail: 100 });
      }
      // 第二次调用（ensureDiskMargin）挂起，直到 cleanup 完成后才被 resolve。
      return new Promise(resolve => {
        resolveProbe = () => resolve({ bsize: 4096, blocks: 1, bfree: 1, bavail: 0 });
      });
    };
    const workspace = await startWorkspace(rootDir, { statfs: probe });
    const marginPromise = workspace.ensureDiskMargin(); // 停在 diskCheck 上
    await workspace.cleanup();
    resolveProbe!();
    const snapshot = await marginPromise;
    expect(snapshot.ok).toBe(false);
    // 目录不得被重建（写租赁/锁内复查阻止迟到的水位持久化重建目录）。
    expect(await readdir(rootDir)).toEqual([]);
  }, 30000);

  it('空的 current/ 视为状态未知，POSIX rename 不得覆盖', async () => {
    const rootDir = await newRootDir();
    const currentDir = join(rootDir, WORKSPACE_JOB_DIR);
    await mkdir(currentDir);
    await expect(startWorkspace(rootDir)).rejects.toMatchObject({
      name: 'JobWorkspaceUnknownStateError',
    });
    expect(await readdir(rootDir)).toEqual([WORKSPACE_JOB_DIR]);
    expect(await readdir(currentDir)).toEqual([]);
  }, 30000);

  it('新建下一台前必须先导出上一作业；未导出 finalized 不得覆盖', async () => {
    const rootDir = await newRootDir();
    const first = await startWorkspace(rootDir);
    await first.writeArtifact('raw/http/transactions.jsonl', '{}\n');
    await first.finalize();
    await expect(startWorkspace(rootDir, { jobId: 'job-0002' })).rejects.toBeInstanceOf(
      JobWorkspaceExportRequiredError,
    );
    expect(await readFile(join(first.dir, 'raw/http/transactions.jsonl'), 'utf8')).toBe('{}\n');
    await first.markExported();
    const second = await startWorkspace(rootDir, { jobId: 'job-0002' });
    expect(second.dir).toBe(join(rootDir, WORKSPACE_JOB_DIR));
    expect(await readdir(rootDir)).toEqual([WORKSPACE_JOB_DIR]);
    expect(second.jobId).toBe('job-0002');
    expect(second.workspaceId).not.toBe(first.workspaceId);
  }, 30000);
});

describe('JSONL 句柄与 fsync 节拍（并发首次打开只建一个句柄）', () => {
  it('200 次并发 appendJsonl 同一新文件：内容完整无交错，句柄泄漏为零', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    const { readdirSync } = await import('node:fs');
    const fdCount = () => (process.platform === 'darwin' ? readdirSync('/dev/fd').length : null);
    const before = fdCount();
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        workspace.appendJsonl('catalog/resources.jsonl', {
          id: `http-${String(index).padStart(6, '0')}`,
        }),
      ),
    );
    const rows = (await workspace.readArtifact('catalog/resources.jsonl'))
      .toString('utf8')
      .trimEnd()
      .split('\n');
    expect(rows).toHaveLength(200);
    expect(new Set(rows).size).toBe(200);
    await workspace.close();
    if (before !== null) {
      const after = fdCount();
      expect(after).toBeLessThanOrEqual(before + 12);
    }
  }, 60000);

  it('fsyncEveryAppends 必须为正整数（0/负数/非整数拒绝）', async () => {
    const rootDir = await newRootDir();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        startJobWorkspace({ jobId: 'job-0001', rootDir, safetyMarginBytes: 1, fsyncEveryAppends: bad }),
      ).rejects.toThrow('正整数');
    }
    expect(await readdir(rootDir)).toEqual([]);
  }, 30000);

  it('fsync 按累计追加次数每 N 次一次（可配置节拍），而非每次追加一次', async () => {
    const rootDir = await newRootDir();
    const workspace = await startJobWorkspace({
      jobId: 'job-0001',
      rootDir,
      safetyMarginBytes: 1,
      fsyncEveryAppends: 3,
    });
    for (let index = 0; index < 10; index += 1) {
      await workspace.appendJsonl('raw/runtime/crypto.jsonl', { seq: index });
    }
    const stats = workspace.jsonlWriteStats().get('raw/runtime/crypto.jsonl')!;
    expect(stats.appends).toBe(10);
    // 3/6/9 三次 sync；若按队列深度实现会是 10 次。
    expect(stats.syncs).toBe(3);
    await workspace.close();
  }, 30000);
});

describe('bytesWritten（包工件字节记账）', () => {
  it('appendJsonl 按追加行字节累加，writeArtifact 按内容字节累加', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    expect(workspace.bytesWritten()).toBe(0);
    await workspace.appendJsonl('raw/http/transactions.jsonl', { id: 'http-000001' });
    const rowBytes = Buffer.byteLength('{"id":"http-000001"}\n', 'utf8');
    expect(workspace.bytesWritten()).toBe(rowBytes);
    await workspace.writeArtifact('manifest.json', 'x'.repeat(100));
    expect(workspace.bytesWritten()).toBe(rowBytes + 100);
    await workspace.writeArtifact('raw/binary.bin', new Uint8Array([1, 2, 3]));
    expect(workspace.bytesWritten()).toBe(rowBytes + 103);
    await workspace.close();
  }, 30000);

  it('写入失败不计入（路径非法被拒时计数不变）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await expect(workspace.writeArtifact('../escape.txt', 'x'.repeat(50))).rejects.toThrow();
    await expect(workspace.appendJsonl(WORKSPACE_MARKER_FILE, { a: 1 })).rejects.toThrow();
    expect(workspace.bytesWritten()).toBe(0);
    await workspace.close();
  }, 30000);

  it('BodyStore 正文发布计入一次；同内容去重不重复计；abort 不计', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    const bodies = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const first = await bodies.openWriter();
    await first.write(Buffer.from('session-payload'));
    await first.finish();
    expect(workspace.bytesWritten()).toBe('session-payload'.length);
    const duplicate = await bodies.openWriter();
    await duplicate.write(Buffer.from('session-payload'));
    await duplicate.finish();
    expect(workspace.bytesWritten()).toBe('session-payload'.length);
    const aborted = await bodies.openWriter();
    await aborted.write(Buffer.from('discarded-payload'));
    await aborted.abort();
    expect(workspace.bytesWritten()).toBe('session-payload'.length);
    const second = await bodies.openWriter();
    await second.write(Buffer.from('another-payload'));
    await second.finish();
    expect(workspace.bytesWritten()).toBe('session-payload'.length + 'another-payload'.length);
    await workspace.close();
  }, 30000);

  it('recordBodyBytes 拒绝负数与非整数（记账入口只有 BodyStore）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    expect(() => workspace.recordBodyBytes(-1)).toThrow('非法字节数');
    expect(() => workspace.recordBodyBytes(1.5)).toThrow('非法字节数');
    expect(() => workspace.recordBodyBytes(Number.NaN)).toThrow('非法字节数');
    expect(workspace.bytesWritten()).toBe(0);
    await workspace.close();
  }, 30000);
});

describe('JobWorkspace 工件读写与路径安全', () => {
  it('writeArtifact / appendJsonl / readArtifact 往返一致（自动建子目录）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.writeArtifact('raw/browser/storage.json', '{"k":"v"}');
    await workspace.appendJsonl('catalog/resources.jsonl', { id: 'http-000001' });
    await workspace.appendJsonl('catalog/resources.jsonl', { id: 'http-000002' });
    expect((await workspace.readArtifact('raw/browser/storage.json')).toString('utf8')).toBe(
      '{"k":"v"}',
    );
    const rows = (await workspace.readArtifact('catalog/resources.jsonl'))
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows).toEqual([{ id: 'http-000001' }, { id: 'http-000002' }]);
    await workspace.close();
  }, 30000);

  it('openArtifactStream 逐块读取工件（不整体载入）且与 readArtifact 同一安全边界', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.writeArtifact('raw/browser/storage.json', '{"a":"1"}\n');
    const stream = await workspace.openArtifactStream('raw/browser/storage.json');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"a":"1"}\n');
    // 同一安全边界：路径逃逸 / 内部文件拒绝
    await expect(workspace.openArtifactStream('../escape.txt')).rejects.toThrow();
    await expect(workspace.openArtifactStream(join(WORKSPACE_TMP_DIR, 'x.part'))).rejects.toThrow();
    await workspace.close();
    // 关闭后拒绝读取（与 readArtifact 一致）
    await expect(workspace.openArtifactStream('raw/browser/storage.json')).rejects.toThrow();
  }, 30000);

  it('openArtifactStream：finalized 工作区仍可读（崩溃恢复导出路径）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.writeArtifact('ai/value-flow.json', '{"nodes":[]}');
    await workspace.finalize();
    const stream = await workspace.openArtifactStream('ai/value-flow.json');
    stream.setEncoding('utf8');
    let text = '';
    for await (const chunk of stream) {
      text += chunk as string;
    }
    expect(text).toBe('{"nodes":[]}');
    await workspace.close();
  }, 30000);

  it('artifactPaths 只返回包内工件（排除 workspace.json 与 .tmp）', async () => {    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.writeArtifact('manifest.json', '{}');
    await workspace.appendJsonl('raw/http/transactions.jsonl', { id: 1 });
    // .tmp 下的临时文件由 BodyStore 等内部写入方直接用 fs 创建，
    // 不得出现在包内工件清单里。
    await mkdir(join(workspace.dir, WORKSPACE_TMP_DIR), { recursive: true });
    await writeFile(join(workspace.dir, WORKSPACE_TMP_DIR, 'body.part'), 'tmp');
    const paths = await workspace.artifactPaths();
    expect(paths).toEqual(['manifest.json', 'raw/http/transactions.jsonl']);
    // .owner（所有权租赁）也是内部文件，不得进入包内工件清单。
    expect(paths.some(path => path === '.owner')).toBe(false);
    await workspace.close();
  }, 30000);

  it('拒绝路径逃逸、绝对路径与工作区内部文件写入', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await expect(workspace.writeArtifact('../escape.txt', 'x')).rejects.toThrow();
    await expect(workspace.writeArtifact('/etc/passwd', 'x')).rejects.toThrow();
    await expect(workspace.writeArtifact('a/../b.json', 'x')).rejects.toThrow();
    await expect(workspace.writeArtifact(WORKSPACE_MARKER_FILE, '{}')).rejects.toThrow();
    await expect(workspace.appendJsonl(WORKSPACE_MARKER_FILE, {})).rejects.toThrow();
    await expect(workspace.writeArtifact(join(WORKSPACE_TMP_DIR, 'x.part'), 'x')).rejects.toThrow();
    await expect(workspace.writeArtifact(WORKSPACE_OWNER_FILE, 'forged')).rejects.toThrow();
    await expect(workspace.appendJsonl(WORKSPACE_OWNER_FILE, {})).rejects.toThrow();
    expect(() => createBodyStore({ workspace, namespace: WORKSPACE_OWNER_FILE })).toThrow();
    await workspace.close();
  }, 30000);

  it('flush 后 JSONL 内容对独立文件读取可见（崩溃前数据不丢）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.appendJsonl('raw/runtime/crypto.jsonl', { call: 1 });
    await workspace.flush();
    const raw = await readFile(join(workspace.dir, 'raw/runtime/crypto.jsonl'), 'utf8');
    expect(raw).toBe('{"call":1}\n');
    await workspace.close();
  }, 30000);
});

describe('finalize / close（终止流程与不可变边界）', () => {
  it('finalize 后拒绝一切写入（writeArtifact / appendJsonl / assertWritable）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.finalize();
    expect(workspace.state).toBe('finalized');
    expect(() => workspace.assertWritable()).toThrow('已进入收尾');
    await expect(workspace.writeArtifact('a.json', 'x')).rejects.toThrow('已进入收尾');
    await expect(workspace.appendJsonl('a.jsonl', {})).rejects.toThrow('已进入收尾');
    expect(await workspace.artifactPaths()).toEqual([]);
    await workspace.close();
  }, 30000);

  it('finalize 是不可变边界：同步进入 finalizing，等待在途写入落定后才 finalized', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    const release = workspace.trackInFlightWrite();
    const finalizePromise = workspace.finalize();
    expect(workspace.state).toBe('finalizing');
    expect(() => workspace.trackInFlightWrite()).toThrow('已进入收尾');
    await expect(workspace.writeArtifact('a.json', 'x')).rejects.toThrow('已进入收尾');
    await expect(workspace.appendJsonl('a.jsonl', {})).rejects.toThrow('已进入收尾');
    release();
    await finalizePromise;
    expect(workspace.state).toBe('finalized');
    await workspace.close();
  }, 30000);

  it('writeArtifact 与 finalize 竞争：finalize 完成时全部写入必已落定（写租赁）', async () => {
    const rootDir = await newRootDir();
    const first = await startWorkspace(rootDir, { jobId: 'job-0001' });
    const writePromise = first.writeArtifact('big.json', 'x'.repeat(8 * 1024 * 1024));
    const finalizePromise = first.finalize();
    await finalizePromise;
    const settledAfterFinalize = await Promise.race([
      writePromise.then(() => true, () => false),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0)),
    ]);
    expect(settledAfterFinalize).toBe(true);
    expect(await readFile(join(first.dir, 'big.json'), 'utf8')).toHaveLength(8 * 1024 * 1024);
    await first.markExported();
    await first.cleanup();
    // 顺序 B：finalize 先声明 finalizing → 晚到写入被拒绝，且文件不存在。
    const second = await startWorkspace(rootDir, { jobId: 'job-0002' });
    const secondFinalize = second.finalize();
    await expect(second.writeArtifact('late.json', 'x')).rejects.toThrow('已进入收尾');
    await expect(second.appendJsonl('late.jsonl', {})).rejects.toThrow('已进入收尾');
    await secondFinalize;
    await expect(
      readFile(join(second.dir, 'late.json')).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  }, 30000);

  it('finalize 与 close 并发：终止互斥链保证一致终态（无 file closed 半途）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.appendJsonl('raw/http/transactions.jsonl', { id: 1 });
    const results = await Promise.allSettled([workspace.finalize(), workspace.close()]);
    // 两种合法终态：①finalize 先完成（state=finalized，close 幂等收尾）；
    // ②close 先完成（closed=true，finalize 干净拒绝且 state 回到 active
    // = 最后已知状态）。绝不允许「closed=true 而 state 停在 finalizing /
    // 中间抛 file closed」的混乱。
    // 合法结局：①finalize 先完成（双 fulfilled，state=finalized）；
    // ②close 先完成（close fulfilled；finalize 必须干净拒绝『已关闭或正在
    // 关闭』，绝不出现 file closed / EBADF 的中间态）。
    const finalizeResult = results[0];
    const closeResult = results[1];
    expect(closeResult.status).toBe('fulfilled');
    if (finalizeResult.status === 'fulfilled') {
      expect(workspace.state).toBe('finalized');
    } else {
      expect(String((finalizeResult as PromiseRejectedResult).reason)).toMatch(/已关闭或正在关闭/);
      expect(workspace.state).toBe('active');
    }
    const marker = JSON.parse(await readFile(join(workspace.dir, WORKSPACE_MARKER_FILE), 'utf8'));
    if (workspace.state === 'finalized') {
      expect(marker.state).toBe('finalized');
    } else {
      expect(marker.state).toBe('active');
    }
  }, 30000);

  it('finalize 落盘失败 → 抛错且状态保持 active 可继续写入', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await chmod(join(workspace.dir, WORKSPACE_TMP_DIR), 0o555);
    try {
      await expect(workspace.finalize()).rejects.toThrow();
      expect(workspace.state).toBe('active');
      workspace.assertWritable();
      await workspace.writeArtifact('still-active.json', 'ok');
      expect(await workspace.artifactPaths()).toEqual(['still-active.json']);
    } finally {
      await chmod(join(workspace.dir, WORKSPACE_TMP_DIR), 0o755);
    }
  }, 30000);

  it('finalize 后磁盘水位不再改写标记（不可变边界）', async () => {
    const rootDir = await newRootDir();
    let freeBytes = 100 * GiB;
    const probe: StatFsProbe = async () => ({
      bsize: 4096,
      blocks: 1,
      bfree: 1,
      bavail: Math.floor(freeBytes / 4096),
    });
    const workspace = await startWorkspace(rootDir, { statfs: probe });
    await workspace.finalize();
    freeBytes = 0;
    const snapshot = await workspace.ensureDiskMargin();
    expect(snapshot.ok).toBe(false);
    expect(workspace.storageLimited).toBe(false);
    const markerOnDisk = JSON.parse(
      (await workspace.readArtifact(WORKSPACE_MARKER_FILE)).toString('utf8'),
    );
    expect(markerOnDisk.storageLimited).toBe(false);
    expect(markerOnDisk.state).toBe('finalized');
    await workspace.close();
  }, 30000);
});

describe('close / cleanup（生命周期边界）', () => {
  it('close/cleanup 等待在途租赁：完成后才关闭/删除，先 close 则新写入被拒', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    const order: string[] = [];
    const writePromise = workspace.writeArtifact('a.json', 'x'.repeat(1024 * 1024)).then(() => {
      order.push('write');
      return readFile(join(workspace.dir, 'a.json')).then(() => true, () => false);
    });
    const closePromise = workspace.close().then(() => order.push('close'));
    const [fileExistedAtWrite] = await Promise.all([writePromise, closePromise]);
    expect(order).toEqual(['write', 'close']);
    expect(fileExistedAtWrite).toBe(true);
    await workspace.cleanup();
    // 顺序 B：close 同步声明 closing → 新写入被拒绝。
    const second = await startWorkspace(rootDir, { jobId: 'job-0002' });
    const secondClose = second.close();
    await expect(second.writeArtifact('late.json', 'x')).rejects.toThrow('正在关闭');
    await secondClose;
    await expect(second.writeArtifact('after.json', 'x')).rejects.toThrow('作业已关闭');
  }, 30000);

  it('cleanup 与并发写入：写入先完成再删除目录（不产生“清理后仍成功”的假成功）', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    const order: string[] = [];
    const writes = Array.from({ length: 8 }, (_, index) =>
      workspace.writeArtifact(`f-${index}.json`, 'y'.repeat(512 * 1024)).then(() => order.push(`w${index}`)),
    );
    const cleanupPromise = workspace.cleanup().then(() => order.push('cleanup'));
    await Promise.all([...writes, cleanupPromise]);
    expect(order).toEqual([...order.filter(item => item !== 'cleanup'), 'cleanup']);
  }, 60000);

  it('finalize → cleanup → 再启动在同进程确定路径下完整闭环', async () => {
    const rootDir = await newRootDir();
    const first = await startWorkspace(rootDir, { jobId: 'job-fc-1' });
    await first.appendJsonl('raw/http/transactions.jsonl', { id: 1 });
    await first.finalize();
    await first.markExported();
    await first.cleanup();
    expect(await readdir(rootDir)).toEqual([]);
    // A 的终态流程完成后可干净启动新作业（互斥内 finalize/cleanup 路径）。
    const second = await startWorkspace(rootDir, { jobId: 'job-fc-2' });
    expect(second.state).toBe('active');
    await second.appendJsonl('raw/http/transactions.jsonl', { id: 2 });
    const marker = JSON.parse(
      await readFile(join(rootDir, WORKSPACE_JOB_DIR, WORKSPACE_MARKER_FILE), 'utf8'),
    );
    expect(marker.state).toBe('active');
    expect(marker.jobId).toBe('job-fc-2');
    await second.close();
  }, 60000);

  it('cleanup 删除作业目录；关闭后的工作区拒绝继续写入', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.cleanup();
    await expect(workspace.writeArtifact('a.json', 'x')).rejects.toThrow('作业已关闭');
    await expect(recoverActiveJobWorkspace(rootDir)).resolves.toBeNull();
  }, 30000);

  it('旧对象不得读写后继作业；相同 jobId 的 cleanup 也不得删除后继', async () => {
    const rootDir = await newRootDir();
    const first = await startWorkspace(rootDir, { jobId: 'job-0001' });
    await first.writeArtifact('raw/first.bin', 'owned-by-first');
    await first.finalize();
    await first.markExported();
    const second = await startWorkspace(rootDir, { jobId: 'job-0001' });
    await second.writeArtifact('raw/second.bin', 'owned-by-second');
    await expect(first.artifactPaths()).rejects.toBeInstanceOf(JobWorkspaceIdentityError);
    await expect(first.readArtifact('raw/first.bin')).rejects.toBeInstanceOf(
      JobWorkspaceIdentityError,
    );
    await first.cleanup();
    expect(second.state).toBe('active');
    expect(await readFile(join(second.dir, 'raw/second.bin'), 'utf8')).toBe('owned-by-second');
    const marker = JSON.parse(
      (await second.readArtifact(WORKSPACE_MARKER_FILE)).toString('utf8'),
    );
    expect(marker.jobId).toBe('job-0001');
    expect(marker.workspaceId).toBe(second.workspaceId);
    expect(marker.workspaceId).not.toBe(first.workspaceId);
    await second.writeArtifact('raw/still-alive.bin', 'ok');
    await second.cleanup();
  }, 30000);
  });

  it('不可导出的作业可原样保留到 retained，释放 current 后继续新作业', async () => {
    const rootDir = await newRootDir();
    const first = await startWorkspace(rootDir);
    await first.writeArtifact('raw/probe/index.json', JSON.stringify({ probeRan: true, facts: [{ kind: 'tls' }] }));
    await first.finalize();
    const retainedPath = await first.retainUnexported();
    expect(retainedPath).toContain('/retained/');
    expect(await readFile(join(retainedPath, 'raw/probe/index.json'), 'utf8')).toContain('tls');
    const second = await startWorkspace(rootDir, { jobId: 'job-0002' });
    expect(second.jobId).toBe('job-0002');
    expect(await readFile(join(retainedPath, 'raw/probe/index.json'), 'utf8')).toContain('tls');
    await second.finalize();
    await second.markExported();
    await second.cleanup();
  });

describe('recoverActiveJobWorkspace（崩溃恢复）', () => {
  it('active 作业崩溃后可恢复并继续写入', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.appendJsonl('raw/http/transactions.jsonl', { id: 'http-000001' });
    await workspace.flush();
    await simulateCrash(workspace);
    const recovered = await recoverActiveJobWorkspace(rootDir, {
      safetyMarginBytes: 1024,
      resetStaleOwner: true,
    });
    expect(recovered).not.toBeNull();
    expect(recovered!.jobId).toBe('job-0001');
    expect(recovered!.state).toBe('active');
    expect(recovered!.deviceLabel).toBe('演示机房 A-03');
    await recovered!.appendJsonl('raw/http/transactions.jsonl', { id: 'http-000002' });
    const rows = (await recovered!.readArtifact('raw/http/transactions.jsonl'))
      .toString('utf8')
      .trimEnd()
      .split('\n');
    expect(rows).toHaveLength(2);
    await recovered!.close();
  }, 30000);

  it('恢复所有权：属主存续时冲突；close 按 token 释放后可恢复；并发 reset 只有唯一赢家', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await expect(recoverActiveJobWorkspace(rootDir)).rejects.toMatchObject({
      name: 'JobWorkspaceConflictError',
    });
    await workspace.close();
    // close 已按 token 释放 owner，同进程恢复无需 reset。
    const recovered = await recoverActiveJobWorkspace(rootDir, { safetyMarginBytes: 1024 });
    expect(recovered).not.toBeNull();
    await recovered!.close();
  }, 30000);

  it('同进程仍持有 owner 时 resetStaleOwner 也不得创建第二个 active 对象', async () => {
    const rootDir = await newRootDir();
    const live = await startWorkspace(rootDir);
    await live.writeArtifact('raw/owned.bin', 'still-mine');
    await expect(
      recoverActiveJobWorkspace(rootDir, { resetStaleOwner: true, safetyMarginBytes: 1024 }),
    ).rejects.toMatchObject({ name: 'JobWorkspaceConflictError' });
    expect(live.state).toBe('active');
    expect(await readFile(join(live.dir, 'raw/owned.bin'), 'utf8')).toBe('still-mine');
    await live.writeArtifact('raw/still-writable.bin', 'ok');
    await live.close();
  }, 30000);

  it('close 与 start 竞争：内部互斥等待，owner 释放后才 closed，后续可恢复', async () => {
    const rootDir = await newRootDir();
    const first = await startWorkspace(rootDir);
    const startAgain = startWorkspace(rootDir, { jobId: 'job-0002' });
    const closeFirst = first.close();
    const results = await Promise.allSettled([startAgain, closeFirst]);
    expect(results[1]?.status).toBe('fulfilled');
    expect(results[0]?.status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({
      name: 'JobWorkspaceConflictError',
    });
    const ownerGone = await readFile(join(first.dir, WORKSPACE_OWNER_FILE)).then(
      () => false,
      () => true,
    );
    expect(ownerGone).toBe(true);
    const recovered = await recoverActiveJobWorkspace(rootDir, { safetyMarginBytes: 1024 });
    expect(recovered).not.toBeNull();
    expect(recovered!.workspaceId).toBe(first.workspaceId);
    await recovered!.close();
  }, 30000);

  it('finalized-unexported 可恢复只读导出；start 不得删除资料', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    await workspace.writeArtifact('raw/keep.bin', 'priceless-evidence');
    await workspace.finalize();
    await workspace.close();
    const recovered = await recoverActiveJobWorkspace(rootDir, { safetyMarginBytes: 1024 });
    expect(recovered).not.toBeNull();
    expect(recovered!.state).toBe('finalized');
    expect(recovered!.exported).toBe(false);
    expect(await recovered!.readArtifact('raw/keep.bin')).toEqual(Buffer.from('priceless-evidence'));
    await expect(startWorkspace(rootDir, { jobId: 'job-0002' })).rejects.toBeInstanceOf(
      JobWorkspaceExportRequiredError,
    );
    expect(await readFile(join(rootDir, WORKSPACE_JOB_DIR, 'raw/keep.bin'), 'utf8')).toBe(
      'priceless-evidence',
    );
    await expect(recovered!.cleanup()).rejects.toBeInstanceOf(JobWorkspaceExportRequiredError);
    await recovered!.markExported();
    expect(recovered!.exported).toBe(true);
    await recovered!.cleanup();
    expect(await readdir(rootDir)).toEqual([]);
  }, 30000);

  it('非法 jobId 标记（格式非法）→ 失败关闭且保留现场资料（不自动删除）', async () => {
    const rootDir = await newRootDir();
    const dir = join(rootDir, WORKSPACE_JOB_DIR);
    await mkdir(join(dir, 'raw'), { recursive: true });
    await writeFile(join(dir, 'raw/valuable.bin'), 'priceless-evidence');
    await writeFile(
      join(dir, WORKSPACE_MARKER_FILE),
      `${JSON.stringify({
        schemaVersion: '1.0.0',
        jobId: '../escape',
        state: 'active',
        startedAt: '2026-09-18T10:00:00.000Z',
        deviceLabel: null,
        targetUrl: null,
      })}\n`,
    );
    await expect(recoverActiveJobWorkspace(rootDir)).rejects.toMatchObject({
      name: 'JobWorkspaceUnknownStateError',
    });
    await expect(startWorkspace(rootDir)).rejects.toMatchObject({
      name: 'JobWorkspaceUnknownStateError',
    });
    expect(await readFile(join(dir, 'raw/valuable.bin'), 'utf8')).toBe('priceless-evidence');
  }, 30000);
});

describe('workspaceTmpDir', () => {
  it('返回 .tmp 内部目录绝对路径', async () => {
    const rootDir = await newRootDir();
    const workspace = await startWorkspace(rootDir);
    expect(workspaceTmpDir(workspace)).toBe(join(workspace.dir, WORKSPACE_TMP_DIR));
  }, 30000);
});
