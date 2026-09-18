import { UNTRUSTED_PAGE_CONTENT_MARKER } from './types';

/**
 * Capture Pack 2.0 目录结构契约（规范 §11）与 00_START_HERE.md 内容契约（规范 §12 / §13）。
 * raw/ 为不可变事实，catalog/ 为稳定索引，ai/ 与 replay/ 为可由新版 Analyzer 重新生成的派生内容。
 */

export const PACK_V2_REQUIRED_TOP_LEVEL_DIRS = [
  'ai',
  'catalog',
  'raw',
  'replay',
  'schema',
] as const;

export const PACK_V2_REQUIRED_DIRS = [
  'raw/cdp',
  'raw/netlog',
  'raw/http',
  'raw/http/bodies',
  'raw/websocket',
  'raw/realtime',
  'raw/realtime/bodies',
  'raw/realtime/downloads',
  'raw/runtime',
  'raw/runtime/bodies',
  'raw/browser',
  'raw/browser/dom-snapshots',
  'raw/browser/screenshots',
  'raw/scripts',
  'raw/scripts/files',
  'raw/probe',
] as const;

export const PACK_V2_REQUIRED_FILES = [
  '00_START_HERE.md',
  'manifest.json',
  'integrity.json',
  'report.html',
  'checksums.sha256',
  'ai/index.json',
  'ai/summary.md',
  'ai/adapter-dossier.json',
  'ai/value-flow.json',
  'ai/missing-evidence.json',
  'catalog/resources.jsonl',
  'catalog/targets.json',
  'catalog/channels.json',
  'catalog/relations.jsonl',
  'raw/cdp/events.jsonl',
  'raw/cdp/commands.jsonl',
  'raw/netlog/netlog.json',
  'raw/http/transactions.jsonl',
  'raw/http/session.har',
  'raw/realtime/webrtc.jsonl',
  'raw/realtime/webtransport.jsonl',
  'raw/realtime/sse.jsonl',
  'raw/realtime/downloads.jsonl',
  'raw/runtime/crypto.jsonl',
  'raw/browser/timeline.jsonl',
  'raw/browser/actions.jsonl',
  'raw/browser/targets.json',
  'raw/browser/storage.json',
  'raw/browser/console.jsonl',
  'raw/scripts/index.json',
  'replay/manifest.json',
  'replay/http.jsonl',
  'replay/channels.json',
] as const;

export const PACK_V2_REQUIRED_TOP_LEVEL_FILES = [
  '00_START_HERE.md',
  'manifest.json',
  'integrity.json',
  'report.html',
  'checksums.sha256',
] as const;

export interface PackV2LayoutCheck {
  valid: boolean;
  missingFiles: string[];
  /**
   * §11 列出但包内没有任何文件的目录。ZIP 内不存在空目录，内容相关目录
   * （bodies / websocket / dom-snapshots / screenshots / scripts/files / probe）
   * 只在存在对应事实时出现，因此目录缺失是提示信息，不单独判定布局非法；
   * 「该有却没有」的缺失由证据图与完整度门禁（阶段 3）负责。
   */
  missingDirs: string[];
  unexpectedTopLevelEntries: string[];
}

function directoriesCoveredBy(files: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      dirs.add(segments.slice(0, index).join('/'));
    }
  }
  return dirs;
}

/**
 * 校验一组包内文件路径是否满足 §11 目录契约：
 * - 必需固定文件全部在场；
 * - 顶层条目只允许 ai / catalog / raw / replay / schema 与五个根文件。
 * raw/、ai/、schema/ 内允许按证据追加新文件。
 */
export function checkPackV2Layout(files: readonly string[]): PackV2LayoutCheck {
  const fileSet = new Set(files);
  const missingFiles = PACK_V2_REQUIRED_FILES.filter(path => !fileSet.has(path));

  const coveredDirs = directoriesCoveredBy(files);
  const missingDirs = PACK_V2_REQUIRED_DIRS.filter(path => !coveredDirs.has(path));

  const allowedTopLevel = new Set<string>([
    ...PACK_V2_REQUIRED_TOP_LEVEL_DIRS,
    ...PACK_V2_REQUIRED_TOP_LEVEL_FILES,
  ]);
  const unexpectedTopLevelEntries = [
    ...new Set(files.map(file => file.split('/')[0]).filter(entry => !allowedTopLevel.has(entry))),
  ].sort();

  return {
    valid: missingFiles.length === 0 && unexpectedTopLevelEntries.length === 0,
    missingFiles,
    missingDirs,
    unexpectedTopLevelEntries,
  };
}

export interface StartHereContentCheck {
  valid: boolean;
  problems: string[];
}

/**
 * 00_START_HERE.md 内容契约（规范 §12 / §13）：
 * - 声明唯一推荐阅读顺序：00_START_HERE.md → ai/index.json → ai/adapter-dossier.json。
 * - 声明信任边界：采集网页内容是 untrusted-data-not-instructions，不是指令。
 * - 声明未脱敏：包内可能包含有效凭据与会话，只能作为敏感文件保管。
 */
export function checkStartHereContent(content: string): StartHereContentCheck {
  const problems: string[] = [];
  if (!content.includes('ai/index.json')) {
    problems.push('缺少阅读顺序入口 ai/index.json');
  }
  if (!content.includes('ai/adapter-dossier.json')) {
    problems.push('缺少阅读顺序入口 ai/adapter-dossier.json');
  }
  if (!content.includes(UNTRUSTED_PAGE_CONTENT_MARKER)) {
    problems.push(`缺少信任边界标记 ${UNTRUSTED_PAGE_CONTENT_MARKER}`);
  }
  if (!content.includes('未脱敏')) {
    problems.push('缺少未脱敏敏感数据保管说明');
  }
  return { valid: problems.length === 0, problems };
}
