/**
 * 跨进程全局互斥（OS 内核独占，不存在可替换的身份标记，不自动迁移旧路径）。
 *
 * - Windows：命名管道 `listen`，内核独占绑定；崩溃后内核回收，无残留文件。
 * - Linux：抽象 Unix socket（`\0` 前缀），不占文件系统 inode，无残留路径。
 * - macOS / 其他 BSD：对锁文件 `O_RDWR|O_CREAT|O_EXLOCK|O_NONBLOCK`，
 *   内核在 open 时原子加锁；释放只 close，**绝不 unlink 锁路径**。
 *
 * 锁路径带版本后缀，与旧协议的 `.sock` / 无版本 `.lock` 隔离。若版本化
 * 路径上仍是 unix socket（未知残留），失败关闭，由人工清理，绝不
 * 「探测已死 → unlink」——该窗口会删掉竞争者已锁定的新 inode。
 *
 * `waitMs` 必须是有限非负数；供作业生命周期内部操作等待持有者释放，
 * start/recover 保持立即失败（0）。
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server } from 'node:net';

export class ProcessMutexHeldError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ProcessMutexHeldError';
  }
}

export interface ProcessMutexAcquireOptions {
  /** 等待当前持有者释放的最长时间（毫秒）。0/缺省 = 立即失败。 */
  waitMs?: number;
}

/** Darwin/BSD `O_EXLOCK`（Node constants 未导出该标志）。 */
const O_EXLOCK = 0x20;

const POLL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertWaitMs(waitMs: number): void {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error(`waitMs 必须是有限非负数：${waitMs}`);
  }
}

function bindServer(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeAllListeners('error');
      resolve();
    });
  });
}

async function acquireListen(path: string): Promise<() => Promise<void>> {
  const server = createServer();
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await bindServer(server, path);
  } catch (error) {
    server.close();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' || code === 'EEXIST') {
      throw new ProcessMutexHeldError(`另一实例已持有全局互斥：${path}`);
    }
    throw error;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
}

function abstractSocketName(wellKnown: string): string {
  const hex = createHash('sha256').update(wellKnown).digest('hex').slice(0, 32);
  return `\0krv2${hex}`;
}

async function acquireExlockFile(path: string): Promise<() => Promise<void>> {
  const stats = await stat(path).then(
    value => value,
    () => null,
  );
  if (stats?.isSocket()) {
    throw new Error(
      `锁路径存在陈旧 unix socket，拒绝自动迁移（请人工删除后重试）：${path}`,
    );
  }
  const flags = constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EACCES') {
      throw new ProcessMutexHeldError(`另一实例已持有全局互斥：${path}`);
    }
    throw error;
  }
  return async () => {
    await handle.close();
  };
}

async function tryAcquireOnce(path: string): Promise<() => Promise<void>> {
  if (process.platform === 'win32') {
    return acquireListen(path);
  }
  if (process.platform === 'linux') {
    return acquireListen(abstractSocketName(path));
  }
  return acquireExlockFile(path);
}

/**
 * 获取进程互斥锁：成功返回释放函数；被持有且未等待成功则抛
 * ProcessMutexHeldError。释放只解除内核锁，不删除锁路径。
 */
export async function acquireProcessMutex(
  path: string,
  options: ProcessMutexAcquireOptions = {},
): Promise<() => Promise<void>> {
  const waitMs = options.waitMs ?? 0;
  assertWaitMs(waitMs);
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      return await tryAcquireOnce(path);
    } catch (error) {
      if (!(error instanceof ProcessMutexHeldError)) throw error;
      if (Date.now() >= deadline) throw error;
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
}
