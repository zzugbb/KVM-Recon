/**
 * checksums.sha256 清单（规范 §9 / §11）：按路径排序，每行
 * `<sha256>  <path>`，以换行结尾；清单自身不出现在清单里。
 * 与样例生成器（createSampleCapturePackV2）的格式保持一致，
 * 由导出集成测试做逐字节一致断言。
 */

import { createHash } from 'node:crypto';

export interface ChecksumsEntry {
  path: string;
  sha256: string;
}

export function sha256OfContent(content: string | Uint8Array): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash('sha256').update(buffer).digest('hex');
}

export function buildChecksumsManifest(entries: ReadonlyArray<ChecksumsEntry>): string {
  const lines = [...entries]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(entry => `${entry.sha256}  ${entry.path}`);
  return `${lines.join('\n')}\n`;
}

export function parseChecksumsManifest(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`checksums 清单行格式非法：${line}`);
    result.set(match[2], match[1]);
  }
  return result;
}
