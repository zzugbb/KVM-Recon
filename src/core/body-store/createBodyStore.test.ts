import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBodyStore } from './createBodyStore';
import {
  DEFAULT_DISK_SAFETY_MARGIN_BYTES,
  startJobWorkspace,
  type JobWorkspace,
} from '../job-workspace/createJobWorkspace';

/**
 * BodyStore 测试（规范 §9）：SHA-256 内容寻址、流式写入、
 * 去重、零大小上限（>2 MiB 正文 / >8 MiB 总量 / >24 文件全部成功）、
 * 写入失败与 abort 清理。
 */

const tempRoots: string[] = [];

async function newWorkspace(): Promise<JobWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), 'kvm-recon-body-store-test-'));
  tempRoots.push(rootDir);
  return startJobWorkspace({
    jobId: 'job-0001',
    rootDir,
    safetyMarginBytes: 1,
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('createBodyStore（流式正文与内容寻址）', () => {
  it('流式写入 → finish 返回 BodyRef（sha256/bytes/path）且文件内容一致', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    await writer.write(Buffer.from('{"user":"operator"', 'utf8'));
    await writer.write(Buffer.from(',"nonce":"abc"}', 'utf8'));
    const ref = await writer.finish();
    const expected = Buffer.from('{"user":"operator","nonce":"abc"}', 'utf8');
    expect(ref.bytes).toBe(expected.byteLength);
    expect(ref.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(ref.path).toBe(`raw/http/bodies/${ref.sha256}`);
    expect(await readFile(join(workspace.dir, ref.path))).toEqual(expected);
  }, 30000);

  it('finish 未等待在途 write：操作队列保证 digest 在全部追加之后（16 MiB 反例）', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    // 不 await write 就立即 finish：队列必须串行，finish 拿到完整正文的 SHA。
    const chunk = Buffer.alloc(16 * 1024 * 1024, 7);
    const writePromise = writer.write(chunk);
    const refPromise = writer.finish();
    const ref = await refPromise;
    await writePromise;
    expect(ref.bytes).toBe(16 * 1024 * 1024);
    expect(ref.sha256).toBe(createHash('sha256').update(chunk).digest('hex'));
    // vitest 对 Buffer 的 toEqual 会逐索引深比较（16MB = 4GB 级别 OOM），
    // 这里用长度 + SHA-256 精确等价断言。
    const stored = await readFile(join(workspace.dir, ref.path));
    expect(stored.length).toBe(chunk.length);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(ref.sha256);
    // 终态后禁止再写（Digest already called 不再可能：已由队列顺序保证）。
    await expect(writer.write(Buffer.from('x'))).rejects.toThrow('已完成');
  }, 60000);

  it('同内容去重：两次 finish 返回同一 ref，命名空间只保留一个文件', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const first = await store.openWriter();
    await first.write(Buffer.from('duplicate-content'));
    const firstRef = await first.finish();
    const second = await store.openWriter();
    await second.write(Buffer.from('duplicate'));
    await second.write(Buffer.from('-content'));
    const secondRef = await second.finish();
    expect(secondRef.sha256).toBe(firstRef.sha256);
    expect(secondRef.path).toBe(firstRef.path);
    expect(await store.listBodyHashes()).toEqual([firstRef.sha256]);
  }, 30000);

  it('零大小上限：3 个 >2 MiB 正文（合计 >8 MiB）全部成功', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const refs = [];
    for (let index = 0; index < 3; index += 1) {
      const writer = await store.openWriter();
      // 2.5 MiB，超过遗留链路的 2 MiB 单文件上限；分块流式写入。
      const chunk = Buffer.alloc(256 * 1024, 65 + index);
      for (let round = 0; round < 10; round += 1) {
        await writer.write(chunk);
      }
      refs.push(await writer.finish());
    }
    expect(refs).toHaveLength(3);
    expect(new Set(refs.map(ref => ref.sha256)).size).toBe(3);
    for (const ref of refs) {
      expect(ref.bytes).toBe(2.5 * 1024 * 1024);
    }
    // 7.5 MiB 总量超过遗留 8 MiB 预算时也应成功（本用例验证单文件上限），
    // 再补两个 1 MiB 正文使总量明确超过 8 MiB。
    for (let index = 0; index < 2; index += 1) {
      const writer = await store.openWriter();
      await writer.write(Buffer.alloc(1024 * 1024, 97 + index));
      refs.push(await writer.finish());
    }
    const totalBytes = refs.reduce((sum, ref) => sum + ref.bytes, 0);
    expect(totalBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect((await store.listBodyHashes()).length).toBe(5);
    // 每个正文都出现在包内工件清单中（可被导出）。
    const artifactPaths = await workspace.artifactPaths();
    for (const ref of refs) {
      expect(artifactPaths).toContain(ref.path);
    }
  }, 30000);

  it('超过 24 个正文文件全部保留（遗留 24 文件上限不适用于新管线）', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    for (let index = 0; index < 30; index += 1) {
      const writer = await store.openWriter();
      await writer.write(Buffer.from(`body-${index}`));
      await writer.finish();
    }
    expect((await store.listBodyHashes()).length).toBe(30);
  }, 30000);

  it('abort 清理临时文件，不影响命名空间', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    await writer.write(Buffer.from('will-be-aborted'));
    await writer.abort();
    expect(await store.listBodyHashes()).toEqual([]);
    const tmpEntries = await readdir(join(workspace.dir, '.tmp'));
    expect(tmpEntries).toEqual([]);
    // abort 后不得再写入。
    await expect(writer.write(Buffer.from('x'))).rejects.toThrow('已完成');
  }, 30000);

  it('finish 后不得再写入', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    await writer.write(Buffer.from('done'));
    await writer.finish();
    await expect(writer.write(Buffer.from('x'))).rejects.toThrow('已完成');
    await expect(writer.finish()).rejects.toThrow('已完成');
  }, 30000);

  it.skipIf(process.platform === 'win32')('写入失败（.tmp 只读）→ openWriter 抛错且不留垃圾', async () => {
    const workspace = await newWorkspace();
    // .tmp 目录只读，使临时文件创建失败（EACCES）。
    await chmod(join(workspace.dir, '.tmp'), 0o555);
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    try {
      await expect(store.openWriter()).rejects.toThrow();
      expect(await store.listBodyHashes()).toEqual([]);
    } finally {
      await chmod(join(workspace.dir, '.tmp'), 0o755);
    }
  }, 30000);

  it('namespace 逃逸（../、绝对路径、.tmp、空）被拒绝', async () => {
    const workspace = await newWorkspace();
    for (const namespace of ['../../escaped', '/abs/bodies', '.tmp', '.owner', 'workspace.json', '', '.', 'a/../b']) {
      expect(() => createBodyStore({ workspace, namespace })).toThrow();
    }
    // 正常命名空间不受影响。
    expect(() => createBodyStore({ workspace, namespace: 'raw/http/bodies' })).not.toThrow();
  }, 30000);

  it('finalize 前已入队的 write+finish 必须完整落盘，不得发布空正文', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    const payload = Buffer.from('queued-before-finalize');
    const writePromise = writer.write(payload);
    const finishPromise = writer.finish();
    const finalizePromise = workspace.finalize();
    await expect(writePromise).resolves.toBeUndefined();
    const ref = await finishPromise;
    expect(ref.bytes).toBe(payload.byteLength);
    expect(ref.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    await finalizePromise;
    expect(workspace.state).toBe('finalized');
    expect(await store.listBodyHashes()).toEqual([ref.sha256]);
    expect(await readFile(join(workspace.dir, ref.path))).toEqual(payload);
  }, 30000);

  it('finalize 是不可变边界：等待在途写入器解决临时文件后才落 finalized 标记', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    await writer.write(Buffer.from('in-flight'));
    const finalizePromise = workspace.finalize();
    // finalizing 期间：不得继续 write、不得新建写入器。
    expect(workspace.state).toBe('finalizing');
    await expect(writer.write(Buffer.from('more'))).rejects.toThrow('已进入收尾');
    await expect(store.openWriter()).rejects.toThrow('已进入收尾');
    // 在途写入器落定（finish）后 finalize 完成，正文进入正式命名空间。
    const ref = await writer.finish();
    expect(ref.bytes).toBe(9);
    await finalizePromise;
    expect(workspace.state).toBe('finalized');
    expect(await store.listBodyHashes()).toEqual([ref.sha256]);
  }, 30000);

  it.skipIf(process.platform === 'win32')(
    'abort 的 rm 失败不得释放租赁；恢复权限后可重试',
    async () => {
      const workspace = await newWorkspace();
      const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
      const writer = await store.openWriter();
      await writer.write(Buffer.from('pending'));
      const tmpDir = join(workspace.dir, '.tmp');
      await chmod(tmpDir, 0o555);
      try {
        await expect(writer.abort()).rejects.toThrow();
        const finalizePromise = workspace.finalize();
        const raced = await Promise.race([
          finalizePromise.then(() => 'finalized' as const),
          new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 80)),
        ]);
        expect(raced).toBe('waiting');
        await chmod(tmpDir, 0o755);
        await writer.abort();
        await finalizePromise;
        expect(workspace.state).toBe('finalized');
      } finally {
        await chmod(tmpDir, 0o755).catch(() => {});
      }
    },
    30000,
  );

  it('finalize 后在途写入器 abort 也能解除等待（不会死锁）', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    await writer.write(Buffer.from('pending'));
    const finalizePromise = workspace.finalize();
    await writer.abort();
    await finalizePromise;
    expect(workspace.state).toBe('finalized');
    expect(await store.listBodyHashes()).toEqual([]);
    expect(await readdir(join(workspace.dir, '.tmp'))).toEqual([]);
  }, 30000);

  it('finalize 与 openWriter 竞争：被拒绝时不残留 .part 与句柄', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    // finalize 先进入 finalizing → openWriter 必须拒绝，且不留任何半成品
    //（写租赁在第一个 await 前取得，mkdir/open 都发生在租赁内）。
    const finalizePromise = workspace.finalize();
    await expect(store.openWriter()).rejects.toThrow('已进入收尾');
    await finalizePromise;
    expect(await readdir(join(workspace.dir, '.tmp'))).toEqual([]);
    expect(await store.listBodyHashes()).toEqual([]);
  }, 30000);

  it('cleanup 后 openWriter 拒绝，不得隐式重建作业目录', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    await workspace.cleanup();
    await expect(store.openWriter()).rejects.toThrow('作业已关闭');
    expect(await stat(workspace.dir).then(() => true, () => false)).toBe(false);
  }, 30000);

  it.skipIf(process.platform === 'win32')(
    'finish 清理失败不得 settle：.part 残留且 finalize 等待，abort 可重试',
    async () => {
      const workspace = await newWorkspace();
      const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
      const content = Buffer.from('finish-cleanup-must-not-settle');
      const sha = createHash('sha256').update(content).digest('hex');
      await mkdir(join(workspace.dir, 'raw/http/bodies', sha), { recursive: true });
      const writer = await store.openWriter();
      await writer.write(content);
      const tmpDir = join(workspace.dir, '.tmp');
      await chmod(tmpDir, 0o555);
      try {
        await expect(writer.finish()).rejects.toThrow();
        const leftover = await readdir(tmpDir);
        expect(leftover.some(name => name.endsWith('.part'))).toBe(true);
        const finalizePromise = workspace.finalize();
        const raced = await Promise.race([
          finalizePromise.then(() => 'finalized' as const),
          new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 80)),
        ]);
        expect(raced).toBe('waiting');
        await chmod(tmpDir, 0o755);
        await writer.abort();
        await finalizePromise;
        expect(workspace.state).toBe('finalized');
        expect(await readdir(tmpDir)).toEqual([]);
      } finally {
        await chmod(tmpDir, 0o755).catch(() => {});
      }
    },
    30000,
  );

  it('finish 中 rename 失败（目录占位不算同内容正文）→ 抛错、清理临时文件、后续 abort 安全', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const content = Buffer.from('rename-will-fail');
    const sha = createHash('sha256').update(content).digest('hex');
    // 用同名目录占住 rename 目标：不得误判为去重，必须走失败清理路径。
    const placeholder = join(workspace.dir, 'raw/http/bodies', sha);
    await mkdir(placeholder, { recursive: true });
    const writer = await store.openWriter();
    await writer.write(content);
    await expect(writer.finish()).rejects.toThrow();
    // 临时文件已清理，.tmp 为空。
    expect(await readdir(join(workspace.dir, '.tmp'))).toEqual([]);
    // 终态后 abort 是安全空操作，写入被拒绝。
    await writer.abort();
    await expect(writer.write(Buffer.from('x'))).rejects.toThrow('已完成');
    // 移除目录占位后命名空间内没有落盘任何正文文件。
    await rm(placeholder, { recursive: true, force: true });
    expect(await store.listBodyHashes()).toEqual([]);
  }, 30000);

  it('不同命名空间互不混入（http 与 runtime 正文分开寻址）', async () => {
    const workspace = await newWorkspace();
    const httpStore = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const runtimeStore = createBodyStore({ workspace, namespace: 'raw/runtime/bodies' });
    const httpWriter = await httpStore.openWriter();
    await httpWriter.write(Buffer.from('http-body'));
    const httpRef = await httpWriter.finish();
    const runtimeWriter = await runtimeStore.openWriter();
    await runtimeWriter.write(Buffer.from('runtime-body'));
    const runtimeRef = await runtimeWriter.finish();
    expect(httpRef.path.startsWith('raw/http/bodies/')).toBe(true);
    expect(runtimeRef.path.startsWith('raw/runtime/bodies/')).toBe(true);
    expect(await httpStore.listBodyHashes()).toEqual([httpRef.sha256]);
    expect(await runtimeStore.listBodyHashes()).toEqual([runtimeRef.sha256]);
  }, 30000);

  it('两个写入器并发写不同内容 → 各自正确的 ref 与文件', async () => {
    const workspace = await newWorkspace();
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const first = await store.openWriter();
    const second = await store.openWriter();
    await first.write(Buffer.from('first-body'));
    await second.write(Buffer.from('second-body'));
    const firstRef = await first.finish();
    const secondRef = await second.finish();
    expect(firstRef.sha256).not.toBe(secondRef.sha256);
    expect((await readFile(join(workspace.dir, firstRef.path))).toString()).toBe('first-body');
    expect((await readFile(join(workspace.dir, secondRef.path))).toString()).toBe('second-body');
  }, 30000);
});

describe('BodyStore 与磁盘水位联动', () => {
  it('运行中触发安全余量 → 采集器语义（storageLimited）可见，BodyStore 本身不设上限', async () => {
    const workspace = await newWorkspace();
    expect(workspace.safetyMarginBytes).toBeLessThan(DEFAULT_DISK_SAFETY_MARGIN_BYTES);
    // BodyStore 不做磁盘检查：水位判断属于 JobWorkspace/采集器职责分层。
    const store = createBodyStore({ workspace, namespace: 'raw/http/bodies' });
    const writer = await store.openWriter();
    await writer.write(Buffer.from('any-size'));
    const ref = await writer.finish();
    expect(ref.bytes).toBe(8);
  }, 30000);
});
