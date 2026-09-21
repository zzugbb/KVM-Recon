/**
 * HTTP 事务采集：全 hop、全正文经 BodyStore，无大小上限、不脱敏（规范 §8.2 / §9 / §13）。
 * commit 时同步写 catalog/resources.jsonl 稳定索引；缺正文记入证据缺口。
 */

import { createBodyStore } from '../body-store/createBodyStore';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { PackV2BodyRef, PackV2HttpTransactionRow, PackV2ResourceKind, PackV2ResourceRow } from '../capture-pack-v2/types';
import type { CollectorEvidence } from './collectorEvidence';

const TRANSACTIONS_PATH = 'raw/http/transactions.jsonl';
const RESOURCES_PATH = 'catalog/resources.jsonl';
const BODIES_NAMESPACE = 'raw/http/bodies';

/** 明确无正文语义的状态码（规范 §14 条 3）。 */
const NO_BODY_STATUS = new Set([204, 205, 304]);

const RESOURCE_KINDS: Record<string, PackV2ResourceKind> = {
  document: 'document',
  xhr: 'xhr',
  fetch: 'fetch',
  script: 'script',
  worker: 'worker',
  wasm: 'wasm',
  stylesheet: 'stylesheet',
  image: 'image',
  font: 'font',
  media: 'media',
  'source-map': 'source-map',
};

function resourceKind(resourceType: string, url: string): PackV2ResourceKind {
  const normalized = resourceType.toLowerCase();
  if (RESOURCE_KINDS[normalized]) return RESOURCE_KINDS[normalized];
  if (/\.wasm(?:[?#]|$)/i.test(url)) return 'wasm';
  if (/\.map(?:[?#]|$)/i.test(url)) return 'source-map';
  return 'other';
}

function contentTypeOf(headers: Record<string, string>): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type');
  return found ? found[1] : null;
}

export interface HttpHopInput {
  id: string;
  targetId: string;
  startedAt: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  frameId?: string;
  windowId?: string;
  initiator?: PackV2HttpTransactionRow['initiator'];
  referer?: string;
  redirectFromId?: string;
}

export interface HttpCollector {
  openHop(input: HttpHopInput): void;
  has(id: string): boolean;
  patchHop(id: string, patch: Partial<PackV2HttpTransactionRow>): void;
  /**
   * 合并 extraInfo 头（请求 Cookie / 响应 Set-Cookie 等，Chromium 对
   * fetch/XHR 把这些头放在 requestWillBeSentExtraInfo / responseReceivedExtraInfo）。
   * 只改未提交 hop；已提交返回 false（journal 只追加，不改写已落盘行），
   * 由调用方按 droppedEvent 记账。
   */
  mergeHopHeaders(
    id: string,
    patch: { requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string> },
  ): boolean;
  storeBody(bytes: Uint8Array): Promise<PackV2BodyRef>;
  /**
   * 提交 hop。outcome='failed' 表示请求以 loadingFailed 终止（无正文是
   * 明确语义）；outcome='finished' 时若缺响应正文且非无正文状态码则记
   * missingBodies 缺口。
   */
  commit(id: string, outcome?: 'finished' | 'failed'): Promise<void>;
  /** 收尾时提交尚未 commit 的 hop（失败/未完成请求）。 */
  flush(): Promise<void>;
  /** 派生引擎只读快照：全部 hop 行浅拷贝（含未 commit 的，stop 序列在 flush 后调用）。 */
  transactionRows(): PackV2HttpTransactionRow[];
}

export function createHttpCollector(workspace: JobWorkspace, evidence: CollectorEvidence): HttpCollector {
  const bodies = createBodyStore({ workspace, namespace: BODIES_NAMESPACE });
  const hops = new Map<string, PackV2HttpTransactionRow>();
  const committed = new Set<string>();

  function requireHop(id: string): PackV2HttpTransactionRow {
    const hop = hops.get(id);
    if (!hop) throw new Error(`未知 HTTP hop：${id}`);
    return hop;
  }

  return {
    openHop(input) {
      hops.set(input.id, {
        id: input.id,
        targetId: input.targetId,
        frameId: input.frameId,
        windowId: input.windowId,
        startedAt: input.startedAt,
        method: input.method,
        url: input.url,
        resourceType: input.resourceType,
        requestHeaders: input.requestHeaders,
        status: null,
        responseHeaders: {},
        initiator: input.initiator,
        referer: input.referer,
        redirectFromId: input.redirectFromId,
      });
    },
    has(id) {
      return hops.has(id);
    },
    patchHop(id, patch) {
      Object.assign(requireHop(id), patch);
    },
    mergeHopHeaders(id, patch) {
      const hop = requireHop(id);
      if (committed.has(id)) return false;
      if (patch.requestHeaders) hop.requestHeaders = { ...hop.requestHeaders, ...patch.requestHeaders };
      if (patch.responseHeaders) hop.responseHeaders = { ...hop.responseHeaders, ...patch.responseHeaders };
      return true;
    },
    async storeBody(bytes) {
      const writer = await bodies.openWriter();
      try {
        await writer.write(bytes);
        return await writer.finish();
      } catch (error) {
        // 捕获正文落盘失败：磁盘不足或工作区已不可写
        // 策略：abort 临时文件后把错误交给采集器，避免留下 .part
        try {
          await writer.abort();
        } catch (abortError) {
          // 捕获 abort 清理失败：.close/.rm 可能被权限或占用阻断
          // 策略：仍抛出原始写入错误，租赁由 BodyStore 保持可重试
          void abortError;
        }
        throw error;
      }
    },
    async commit(id, outcome = 'finished') {
      if (committed.has(id)) return;
      const hop = requireHop(id);
      // committed 先置位：append 失败也不允许 flush 重试——appendFile 半写后
      // 重试可能追加重复行。行丢失必须持久作证（journalWriteFailures），
      // 由调用方（事件链 / safeStep）按 droppedEvent 计数后继续。
      committed.add(id);
      try {
        await workspace.appendJsonl(TRANSACTIONS_PATH, hop);
      } catch (error) {
        evidence.recordGap(
          'journalWriteFailures',
          hop.id,
          `事务行写入失败（${TRANSACTIONS_PATH}）：${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      const resource: PackV2ResourceRow = {
        id: hop.id,
        kind: resourceKind(hop.resourceType, hop.url),
        url: hop.url,
        method: hop.method,
        status: hop.status,
        contentType: contentTypeOf(hop.responseHeaders),
        targetId: hop.targetId,
        occurredAt: hop.startedAt,
        ...(hop.requestBody ? { requestBody: hop.requestBody } : {}),
        ...(hop.responseBody ? { responseBody: hop.responseBody } : {}),
      };
      try {
        await workspace.appendJsonl(RESOURCES_PATH, resource);
      } catch (error) {
        evidence.recordGap(
          'journalWriteFailures',
          hop.id,
          `资源索引行写入失败（${RESOURCES_PATH}）：${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      const hasExplicitNoBodySemantics =
        outcome === 'failed' ||
        hop.status === null ||
        NO_BODY_STATUS.has(hop.status) ||
        hop.redirectToId !== undefined;
      if (!hasExplicitNoBodySemantics && !hop.responseBody) {
        evidence.recordGap('missingBodies', hop.id, `响应正文缺失（status=${hop.status}）`);
      }
    },
    async flush() {
      for (const id of hops.keys()) {
        if (!committed.has(id)) await this.commit(id);
      }
    },
    transactionRows() {
      return [...hops.values()].map(hop => ({ ...hop }));
    },
  };
}
