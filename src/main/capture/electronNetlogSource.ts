/**
 * Electron netLog 源（NetlogSource 实现，规范 §8.1）。
 *
 * netLog 是应用级的：源文件写进工作区内部 `.tmp/`（不进包），stop 时由
 * netlogTransform 包装为 raw/netlog/netlog.json。captureMode 用
 * include-sensitive——不脱敏策略下日志必须带完整参数（含 Cookie 头）。
 */

import { netLog } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { NetlogSource } from '../../core/collector/createCaptureSession';

export const ELECTRON_NETLOG_CAPTURE_MODE = 'include-sensitive';

export function electronNetlogSourceFile(workspaceDir: string): string {
  return join(workspaceDir, '.tmp', 'netlog.json');
}

export function createElectronNetlogSource(): NetlogSource {
  let netlogPath: string | null = null;
  return {
    async start(workspaceDir) {
      if (netLog.currentlyLogging) {
        throw new Error('Electron netLog 已在记录（上一作业未收尾），拒绝开始新记录');
      }
      netlogPath = electronNetlogSourceFile(workspaceDir);
      await mkdir(join(workspaceDir, '.tmp'), { recursive: true });
      await netLog.startLogging(netlogPath, { captureMode: 'includeSensitive' });
    },
    async stop() {
      if (!netlogPath || !netLog.currentlyLogging) return null;
      const sourcePath = netlogPath;
      await netLog.stopLogging();
      netlogPath = null;
      return { sourcePath, captureMode: ELECTRON_NETLOG_CAPTURE_MODE };
    },
  };
}
