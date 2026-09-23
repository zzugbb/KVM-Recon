/**
 * SHA-256 内容寻址的流式正文存储（规范 §9，阶段 1）。
 *
 * - 正文边接收边写入工作区 `.tmp/` 临时文件，同步计算 SHA-256；
 *   finish 时 fsync + 原子改名为 `<namespace>/<sha256>`，同内容去重
 *   （目标必须是已存在的普通文件，目录占位不算去重）。
 * - 无任何大小上限（规范 §9：删除 1 MiB / 2 MiB / 24 文件 / 8 MiB /
 *   64 帧等采集限制；上限随阶段 2 采集器替换一并从遗留链路删除）。
 * - 写入前提是工作区可写（active 且未关闭）：finalize / cleanup 后
 *   不得再新建写入器或继续写入。write()/finish() 在调用当下取得写权限，
 *   已入队的写入可在 finalizing 期间完成；任一 write 失败会粘性阻断
 *   finish，并清理临时文件，不得发布空正文。
 * - 写入失败（含磁盘不足 ENOSPC）由 write()/finish() 抛错；finish 的
 *   任一步失败都走可重试的 cleanupPart()：close 与 rm 都成功后才
 *   settle()；清理失败则保持租赁，writer 仍可 abort() 重试。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import {
  isReservedWorkspacePath,
  workspaceTmpDir,
  type JobWorkspace,
} from '../job-workspace/createJobWorkspace';
import type { PackV2BodyRef } from '../capture-pack-v2/types';

export interface BodyStoreInit {
  workspace: JobWorkspace;
  /** 包内命名空间，例如 raw/http/bodies、raw/runtime/bodies。 */
  namespace: string;
}

export interface BodyStoreWriter {
  /** 流式追加一块正文；失败（含 ENOSPC）抛错，调用方应 abort()。 */
  write(chunk: Uint8Array): Promise<void>;
  /** 完成：fsync + 原子改名 + 去重，返回 BodyRef。任一步失败清理临时文件后抛错。 */
  finish(): Promise<PackV2BodyRef>;
  /** 放弃：关闭句柄并删除临时文件；终态后调用是安全空操作。 */
  abort(): Promise<void>;
}

export interface BodyStore {
  readonly namespace: string;
  /** 打开一个流式写入器（临时文件位于工作区 .tmp/）。工作区不可写时抛错。 */
  openWriter(): Promise<BodyStoreWriter>;
  /** 列出命名空间内已落盘正文的内容寻址文件名（sha256）。 */
  listBodyHashes(): Promise<string[]>;
}

function validateNamespace(workspace: JobWorkspace, namespace: string): void {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new Error(`非法正文命名空间：${JSON.stringify(namespace)}`);
  }
  if (namespace.startsWith('/') || namespace.includes('\\') || /^[a-zA-Z]:/.test(namespace)) {
    throw new Error(`正文命名空间必须是包内相对路径：${namespace}`);
  }
  const segments = namespace.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`正文命名空间包含非法片段：${namespace}`);
  }
  if (isReservedWorkspacePath(namespace)) {
    throw new Error(`正文命名空间不得使用工作区内部路径：${namespace}`);
  }
  assertInside(workspace.dir, join(workspace.dir, namespace), namespace);
}

function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new Error(`正文命名空间逃逸出工作区边界：${label}`);
  }
}

export function createBodyStore(init: BodyStoreInit): BodyStore {
  const { workspace, namespace } = init;
  validateNamespace(workspace, namespace);
  const namespaceDir = join(workspace.dir, namespace);
  const tmpDir = workspaceTmpDir(workspace);

  return {
    namespace,
    async openWriter() {
      // finalize / cleanup 之后不得新建写入器，也不得隐式重建目录。
      // 写租赁在第一个 await 前取得：与 finalize 竞争时要么先登记成功
      // （finalize 会等待本写入器落定），要么在登记处被拒绝，不留任何
      // 半成品（.part / 句柄），因为 mkdir/open 都发生在租赁之内。
      const releaseInFlight = workspace.trackInFlightWrite();
      let handle;
      let partPath: string | null = null;
      try {
        await mkdir(tmpDir, { recursive: true });
        await mkdir(namespaceDir, { recursive: true });
        const partName = `body-${randomUUID()}.part`;
        partPath = join(tmpDir, partName);
        handle = await open(partPath, 'a');
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (partPath) await rm(partPath, { force: true }).catch(() => {});
        releaseInFlight();
        throw error;
      }
      const hash = createHash('sha256');
      let bytes = 0;
      let done = false;
      let failed: Error | null = null;

      const assertActive = () => {
        if (done) throw new Error('BodyStoreWriter 已完成或已放弃');
      };

      const settle = () => {
        releaseInFlight();
        done = true;
      };

      const rememberFailure = (error: unknown): Error => {
        const next = error instanceof Error ? error : new Error(String(error));
        if (!failed) failed = next;
        return next;
      };

      let handleOpen = true;
      const cleanupPart = async () => {
        // close/rm 失败不得吞掉后仍释放租赁：否则 finalize 以为资源已清
        // 理，实际仍占用 FD 或留下 .part。abort 失败后可重试（句柄只关一次）。
        if (handleOpen) {
          await handle!.close();
          handleOpen = false;
        }
        if (partPath) await rm(partPath, { force: true });
      };

      // 操作队列：write/finish/abort 按调用顺序串行。前序失败粘性传播到
      // finish（then(fn,fn) 仍会执行后续项，所以 finish 必须检查 failed
      // 并清理临时文件，绝不能把空正文 SHA 发布出去）。
      let opChain: Promise<void> = Promise.resolve();
      const enqueueOp = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = opChain.then(fn, fn);
        opChain = run.then(
          () => undefined,
          error => {
            rememberFailure(error);
          },
        );
        return run;
      };

      return {
        async write(chunk) {
          assertActive();
          if (failed) throw failed;
          // 调用当下取得写权限：已被 finalizing 拒绝的新 write 不入队，
          // 也不把失败粘到已经成功入队的正文上（仍允许 finish 已许可的数据）。
          workspace.assertWritable();
          return enqueueOp(async () => {
            if (done) throw new Error('BodyStoreWriter 已完成或已放弃');
            if (failed) throw failed;
            try {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              await handle!.appendFile(buffer);
              hash.update(buffer);
              bytes += buffer.byteLength;
            } catch (error) {
              throw rememberFailure(error);
            }
          });
        },
        async finish() {
          assertActive();
          return enqueueOp(async () => {
            if (done) throw new Error('BodyStoreWriter 已完成或已放弃');
            const failWithoutSettling = async (error: unknown): Promise<never> => {
              // 清理失败不得 settle：finalize 会误以为资源已释放，.part / FD
              // 残留且 writer 无法再 abort。清理成功后才能释放租赁。
              try {
                await cleanupPart();
              } catch (cleanupError) {
                rememberFailure(cleanupError);
                throw error instanceof Error ? error : new Error(String(error));
              }
              settle();
              throw error instanceof Error ? error : new Error(String(error));
            };
            if (failed) {
              await failWithoutSettling(failed);
            }
            const sha256 = hash.digest('hex');
            try {
              await handle!.sync();
              await handle!.close();
              handleOpen = false;
            } catch (error) {
              await failWithoutSettling(error);
            }
            const finalPath = join(namespaceDir, sha256);
            try {
              let existsAsFile = false;
              try {
                const finalStats = await stat(finalPath);
                // 目录占位不算同内容正文：rename 会失败并进入清理路径。
                existsAsFile = finalStats.isFile();
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
              if (existsAsFile) {
                // 同内容去重：保留既有文件，丢弃本次临时文件。
                await cleanupPart();
              } else {
                try {
                  await rename(partPath!, finalPath);
                  partPath = null;
                  // 只在新文件真正发布时报数：去重命中（含并发竞态按去重
                  // 处理的分支）不重复计入字节记账。
                  workspace.recordBodyBytes(bytes);
                } catch (error) {
                  const code = (error as NodeJS.ErrnoException).code;
                  // 并发同内容 finish 的竞态：POSIX rename 覆盖即可；
                  // Windows 对已存在目标会报 EEXIST/EPERM——目标已是同内容
                  // 普通文件时按去重成功处理（内容寻址保证同 sha 即同内容）。
                  if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
                  const raced = await stat(finalPath).then(
                    stats => stats.isFile(),
                    () => false,
                  );
                  if (!raced) throw error;
                  await cleanupPart();
                }
              }
            } catch (error) {
              await failWithoutSettling(error);
            }
            settle();
            return { sha256, bytes, path: `${namespace}/${sha256}` };
          });
        },
        async abort() {
          // 终态后的 abort 是安全空操作（契约）。
          return enqueueOp(async () => {
            if (done) return;
            // 先关闭句柄、删除临时文件，再释放在途登记：finalize 等待的是
            // 「资源已清理完毕」的时刻，而不是「即将清理」的时刻。
            await cleanupPart();
            settle();
          });
        },
      };
    },
    async listBodyHashes() {
      try {
        return (await readdir(namespaceDir)).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
