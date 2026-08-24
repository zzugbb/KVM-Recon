import { basename } from 'node:path';

import type { CapturePackArtifact } from '../capture-pack/types';

interface BrowserTimelineJson {
  jobId: string;
  events: Array<{
    type: string;
    path?: unknown;
    sourcePath?: unknown;
    [key: string]: unknown;
  }>;
}

const PACK_SCREENSHOT_PREFIX = 'page/screenshots/';

export function toPackScreenshotPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith(PACK_SCREENSHOT_PREFIX)) {
    return normalized;
  }
  const marker = `/${PACK_SCREENSHOT_PREFIX}`;
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + 1);
  }
  const fileName = basename(normalized).replace(/[^a-zA-Z0-9._-]/g, '-') || 'page.png';
  return `${PACK_SCREENSHOT_PREFIX}${fileName}`;
}

function screenshotDiskPath(event: { path?: unknown; sourcePath?: unknown }): string | null {
  if (typeof event.sourcePath === 'string' && event.sourcePath) {
    return event.sourcePath;
  }
  if (typeof event.path !== 'string' || !event.path) {
    return null;
  }
  if (event.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(event.path)) {
    return event.path;
  }
  return null;
}

export async function collectScreenshotArtifacts(input: {
  page: BrowserTimelineJson;
  readFile(path: string): Promise<Uint8Array | null>;
}): Promise<CapturePackArtifact[]> {
  const artifacts: CapturePackArtifact[] = [];

  for (const event of input.page.events) {
    if (event.type !== 'screenshot') continue;
    const diskPath = screenshotDiskPath(event);
    const packPath =
      typeof event.path === 'string' && event.path
        ? toPackScreenshotPath(event.path)
        : diskPath
          ? toPackScreenshotPath(diskPath)
          : '';
    if (!diskPath || !packPath) continue;

    try {
      const content = await input.readFile(diskPath);
      if (!content) continue;
      artifacts.push({
        path: packPath,
        content,
      });
    } catch (error) {
      // 捕获截图文件读取失败：采集过程中文件可能被清理或权限不足
      // 策略：跳过该张截图，保留其余资料，避免整包导出失败
      void error;
    }
  }

  return artifacts;
}
