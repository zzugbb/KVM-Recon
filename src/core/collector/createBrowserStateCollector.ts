/**
 * 浏览器状态快照：Cookie / Storage / console / 导航时间线 / 截图 /
 * DOM 快照 / 用户操作时间线（规范 §8.4 / §7.2）。
 * IndexedDB / CacheStorage 枚举结果由挂载层经 writeStorage 传入；
 * CacheStorage 响应正文经 storeCacheBody 落 raw/browser/bodies。
 */

import { createBodyStore } from '../body-store/createBodyStore';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { CollectorEvidence } from './collectorEvidence';
import {
  PACK_V2_SCHEMA_VERSION,
  type PackV2BodyRef,
  type PackV2BrowserActionRow,
  type PackV2BrowserConsoleRow,
  type PackV2BrowserFrameTreeFile,
  type PackV2BrowserStorageFile,
  type PackV2BrowserTimelineRow,
} from '../capture-pack-v2/types';

const STORAGE_PATH = 'raw/browser/storage.json';
const FRAME_TREE_PATH = 'raw/browser/frame-tree.json';
const CONSOLE_PATH = 'raw/browser/console.jsonl';
const TIMELINE_PATH = 'raw/browser/timeline.jsonl';
const ACTIONS_PATH = 'raw/browser/actions.jsonl';
const SCREENSHOTS_DIR = 'raw/browser/screenshots';
const DOM_SNAPSHOTS_DIR = 'raw/browser/dom-snapshots';
const CACHE_BODIES_NAMESPACE = 'raw/browser/bodies';

export interface ArtifactMeta {
  targetId?: string;
  occurredAt?: string;
}

export interface BrowserStateCollector {
  addConsole(row: PackV2BrowserConsoleRow): Promise<void>;
  addTimeline(row: PackV2BrowserTimelineRow): Promise<void>;
  /** 用户操作（点击/表单提交）；稳定 ID 由采集器分配（action-0001…）。 */
  addAction(row: Omit<PackV2BrowserActionRow, 'id'>): Promise<void>;
  /** 保存截图 PNG；返回包内路径并写 timeline 行。 */
  addScreenshot(label: string, bytes: Uint8Array, meta?: ArtifactMeta): Promise<string>;
  /** 保存 DOM 快照 HTML；返回包内路径并写 timeline 行。 */
  addDomSnapshot(label: string, html: string, meta?: ArtifactMeta): Promise<string>;
  /** CacheStorage 响应正文落盘（raw/browser/bodies），返回正文引用。 */
  storeCacheBody(bytes: Uint8Array): Promise<PackV2BodyRef>;
  writeStorage(file: Omit<PackV2BrowserStorageFile, 'schemaVersion'>): Promise<void>;
  /** 收尾 Frame Tree 快照（Page.getFrameTree 原样落盘，规范 §8.4）。 */
  writeFrameTree(file: Omit<PackV2BrowserFrameTreeFile, 'schemaVersion'>): Promise<void>;
}

function safeLabel(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return safe || 'page';
}

export function createBrowserStateCollector(
  workspace: JobWorkspace,
  evidence: CollectorEvidence,
): BrowserStateCollector {
  const cacheBodies = createBodyStore({ workspace, namespace: CACHE_BODIES_NAMESPACE });
  let actionSeq = 0;
  let screenshotSeq = 0;
  let domSnapshotSeq = 0;
  let consoleSeq = 0;
  let timelineSeq = 0;

  /** journal 行写入失败持久作证（journalWriteFailures），丢失不只留进程内计数。 */
  async function appendJournalRow(
    path: string,
    gapId: string,
    describe: string,
    row: object,
  ): Promise<void> {
    try {
      await workspace.appendJsonl(path, row);
    } catch (error) {
      evidence.recordGap(
        'journalWriteFailures',
        gapId,
        `${describe}写入失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  return {
    async addConsole(row) {
      consoleSeq += 1;
      await appendJournalRow(CONSOLE_PATH, `console-${String(consoleSeq).padStart(4, '0')}`, 'console 行', row);
    },
    async addTimeline(row) {
      timelineSeq += 1;
      await appendJournalRow(TIMELINE_PATH, `timeline-${String(timelineSeq).padStart(4, '0')}`, 'timeline 行', row);
    },
    async addAction(row) {
      actionSeq += 1;
      const record: PackV2BrowserActionRow = { id: `action-${String(actionSeq).padStart(4, '0')}`, ...row };
      await appendJournalRow(ACTIONS_PATH, record.id, '用户操作行', record);
    },
    async addScreenshot(label, bytes, meta) {
      screenshotSeq += 1;
      const path = `${SCREENSHOTS_DIR}/${String(screenshotSeq).padStart(4, '0')}-${safeLabel(label)}.png`;
      await workspace.writeArtifact(path, bytes);
      timelineSeq += 1;
      await appendJournalRow(TIMELINE_PATH, `timeline-${String(timelineSeq).padStart(4, '0')}`, 'timeline 行', {
        occurredAt: meta?.occurredAt ?? new Date().toISOString(),
        kind: 'screenshot-saved',
        targetId: meta?.targetId ?? 'browser',
        url: undefined,
        detail: path,
      });
      return path;
    },
    async addDomSnapshot(label, html, meta) {
      domSnapshotSeq += 1;
      const path = `${DOM_SNAPSHOTS_DIR}/${String(domSnapshotSeq).padStart(4, '0')}-${safeLabel(label)}.html`;
      await workspace.writeArtifact(path, html);
      timelineSeq += 1;
      await appendJournalRow(TIMELINE_PATH, `timeline-${String(timelineSeq).padStart(4, '0')}`, 'timeline 行', {
        occurredAt: meta?.occurredAt ?? new Date().toISOString(),
        kind: 'dom-snapshot-saved',
        targetId: meta?.targetId ?? 'browser',
        url: undefined,
        detail: path,
      });
      return path;
    },
    async storeCacheBody(bytes) {
      const writer = await cacheBodies.openWriter();
      try {
        await writer.write(bytes);
        return await writer.finish();
      } catch (error) {
        // 捕获 Cache 正文落盘失败：abort 临时文件后抛出，由调用方记缺口
        try {
          await writer.abort();
        } catch (abortError) {
          void abortError;
        }
        throw error;
      }
    },
    async writeStorage(file) {
      const record: PackV2BrowserStorageFile = {
        schemaVersion: PACK_V2_SCHEMA_VERSION,
        ...file,
      };
      await workspace.writeArtifact(STORAGE_PATH, `${JSON.stringify(record, null, 2)}\n`);
    },
    async writeFrameTree(file) {
      const record: PackV2BrowserFrameTreeFile = {
        schemaVersion: PACK_V2_SCHEMA_VERSION,
        ...file,
      };
      await workspace.writeArtifact(FRAME_TREE_PATH, `${JSON.stringify(record, null, 2)}\n`);
    },
  };
}
