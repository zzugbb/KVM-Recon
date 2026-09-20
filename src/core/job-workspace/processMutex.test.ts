import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireProcessMutex, ProcessMutexHeldError } from './processMutex';

/**
 * 全局进程互斥（OS 内核独占）单元测试。
 * Windows 命名管道 / Linux 抽象 socket / macOS O_EXLOCK：同一路径任意
 * 时刻只有唯一持有者。同进程 8/12 路并发即可证明；无独立子进程脚本。
 */

const tempRoots: string[] = [];

async function newLockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kvm-recon-mutex-test-'));
  tempRoots.push(root);
  return join(root, 'mutex.lock');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('acquireProcessMutex（OS 级互斥）', () => {
  it('同路径双 acquire：唯一赢家，后者 ProcessMutexHeldError', async () => {
    const path = await newLockPath();
    const release = await acquireProcessMutex(path);
    await expect(acquireProcessMutex(path)).rejects.toMatchObject({
      name: 'ProcessMutexHeldError',
    });
    await release();
  }, 30000);

  it('释放后可再获取（同一路径 reuse）', async () => {
    const path = await newLockPath();
    const first = await acquireProcessMutex(path);
    await first();
    const second = await acquireProcessMutex(path);
    await second();
  }, 30000);

  it('生命周期 waitMs：持有者释放后等待方取得锁', async () => {
    const path = await newLockPath();
    const first = await acquireProcessMutex(path);
    const waiter = acquireProcessMutex(path, { waitMs: 2000 });
    await new Promise(resolve => setTimeout(resolve, 40));
    await first();
    const second = await waiter;
    await second();
  }, 30000);

  it('waitMs 到期仍被持有 → ProcessMutexHeldError', async () => {
    const path = await newLockPath();
    const first = await acquireProcessMutex(path);
    await expect(acquireProcessMutex(path, { waitMs: 40 })).rejects.toBeInstanceOf(
      ProcessMutexHeldError,
    );
    await first();
  }, 30000);

  it('非法 waitMs（NaN / Infinity / 负数）立即拒绝，不进入重试循环', async () => {
    const path = await newLockPath();
    for (const waitMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      await expect(acquireProcessMutex(path, { waitMs })).rejects.toThrow('有限非负数');
    }
    const release = await acquireProcessMutex(path);
    await release();
  }, 30000);

  it.skipIf(process.platform !== 'darwin')(
    '陈旧 unix socket 失败关闭：不 unlink，32 路并发多轮都零赢家',
    async () => {
      const path = await newLockPath();
      // Node 正常 close() 会 unlink socket；用 SIGKILL 留下崩溃残留。
      const child = spawn(
        process.execPath,
        [
          '-e',
          `require('net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('ready'))`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout?.once('data', () => resolve());
      });
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
      expect((await stat(path)).isSocket()).toBe(true);
      for (let round = 0; round < 5; round += 1) {
        const results = await Promise.allSettled(
          Array.from({ length: 32 }, () => acquireProcessMutex(path)),
        );
        const winners = results.filter(result => result.status === 'fulfilled');
        expect(winners, `round ${round}`).toHaveLength(0);
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(String(result.reason)).toMatch(/unix socket|拒绝自动迁移/);
          }
        }
        expect((await stat(path)).isSocket(), `round ${round} socket 仍在`).toBe(true);
      }
    },
    30000,
  );

  it('陈旧锁文件 + 12 路并发接管：两轮都恰好一个持有者（无 TOCTOU 双持有）', async () => {
    const path = await newLockPath();
    await writeFile(path, '');
    for (let round = 0; round < 2; round += 1) {
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => acquireProcessMutex(path)),
      );
      const winners = results.filter(result => result.status === 'fulfilled');
      const losers = results.filter(result => result.status === 'rejected');
      expect(winners, `round ${round}`).toHaveLength(1);
      expect(losers, `round ${round}`).toHaveLength(11);
      for (const result of losers) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(ProcessMutexHeldError);
        }
      }
      await (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value();
    }
  }, 30000);

  it('多个并发 acquire：恰好一个成功（Promise.all 压力）', async () => {
    const path = await newLockPath();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireProcessMutex(path)),
    );
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(7);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ProcessMutexHeldError);
      } else {
        await result.value();
      }
    }
  }, 30000);
});
