/**
 * 动态脚本 / Worker / WASM 源码索引（规范 §8.3 / §14 条 4）。
 * Debugger.scriptParsed 后取源码，正文写入 raw/scripts/files。
 * 源码取不到时仍登记索引并显式记账：仅当另一文档已成功
 * 留存完全相同的 CDP hash 正文时共享 BodyRef；否则任意 kind 都记
 * missingWorkerSources 缺口。scriptParsed.length=0 是真实空脚本，仍留存
 * 0 字节 BodyRef。
 */

import { createBodyStore } from '../body-store/createBodyStore';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import {
  PACK_V2_SCHEMA_VERSION,
  type DynamicScriptKind,
  type PackV2ScriptEntry,
  type PackV2ScriptsIndex,
} from '../capture-pack-v2/types';
import type { CollectorEvidence } from './collectorEvidence';

const INDEX_PATH = 'raw/scripts/index.json';
const FILES_NAMESPACE = 'raw/scripts/files';

export interface ScriptParsedInput {
  scriptId: string;
  url: string;
  targetId: string;
  createdBy?: string;
  sourceMapURL?: string;
  source: string;
  sourceBytes?: Buffer;
  isWasm?: boolean;
  kindHint?: DynamicScriptKind;
  /** scriptParsed.length：脚本自有源码长度（0 = 内容本就为空）。 */
  lengthBytes?: number;
  /** scriptParsed.hash：Chromium 对脚本内容给出的稳定 hash。 */
  contentHash?: string;
  /** getScriptSource 失败（脚本已被 Chromium 回收 / 会话未 enable）。 */
  fetchFailed?: boolean;
}

export interface ScriptCollector {
  addParsed(input: ScriptParsedInput): Promise<void>;
  flush(): Promise<void>;
}

function classify(input: ScriptParsedInput): DynamicScriptKind {
  if (input.kindHint) return input.kindHint;
  const url = input.url || '';
  if (input.isWasm || /\.wasm(?:[?#]|$)/i.test(url)) return 'wasm';
  if (/\.map(?:[?#]|$)/i.test(url) || input.sourceMapURL && url.endsWith('.map')) return 'source-map';
  if (/^blob:/i.test(url)) return 'blob';
  if (/^data:/i.test(url)) return 'data';
  if (/:\/\/|^https?:|^file:/i.test(url)) return 'network-script';
  if (/eval/i.test(url)) return 'eval';
  return 'inline';
}

export function createScriptCollector(workspace: JobWorkspace, evidence: CollectorEvidence): ScriptCollector {
  const files = createBodyStore({ workspace, namespace: FILES_NAMESPACE });
  const scripts: PackV2ScriptEntry[] = [];
  const seen = new Set<string>();
  const capturedByHash = new Map<
    string,
    { bodyRef: NonNullable<PackV2ScriptEntry['bodyRef']>; sourceLength?: number }
  >();
  const unresolved: Array<{
    entry: PackV2ScriptEntry;
    kind: DynamicScriptKind;
    url: string | null;
  }> = [];
  let missingReconciled = false;

  function recordMissingSource(id: string, kind: DynamicScriptKind, url: string | null, detail: string): void {
    // 规范 §14 条 4：任意 kind 的源码留存失败都显式作证，
    // 绝不假装已采到。分类名保留历史字段名以兼容 2.0 契约。
    evidence.recordGap('missingWorkerSources', id, `${kind} 源码缺失：${detail}（url=${url ?? 'inline'}）`);
  }

  return {
    async addParsed(input) {
      const id = `${input.targetId}::${input.scriptId}`;
      if (seen.has(id)) return;
      seen.add(id);
      const kind = classify(input);
      const entry: PackV2ScriptEntry = {
        id,
        kind,
        url: input.url || null,
        targetId: input.targetId,
        createdBy: input.createdBy,
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
        ...(input.lengthBytes !== undefined ? { sourceLength: input.lengthBytes } : {}),
        sourceMapPath: input.sourceMapURL || undefined,
      };
      const bytes = input.sourceBytes ?? Buffer.from(input.source, 'utf8');
      const hasContent = bytes.byteLength > 0;
      const trueEmpty = input.lengthBytes === 0;

      // 失败/异常空返回不能写成 0 字节 bodyRef：那会让下游误以为源码已采到。
      // 先登记缺正文条目；flush 时仅当相同 CDP hash 的正文已从另一文档成功
      // 留存时共享其 BodyRef，否则任何 kind 都形成完整度缺口。
      if (!hasContent && !trueEmpty) {
        scripts.push(entry);
        unresolved.push({ entry, kind, url: entry.url });
        return;
      }

      const writer = await files.openWriter();
      let bodyRef;
      try {
        await writer.write(bytes);
        bodyRef = await writer.finish();
      } catch (error) {
        // 捕获脚本源码落盘失败：磁盘不足或工作区不可写
        // 策略：abort 后仍登记无 body 的条目，并记证据缺口
        try {
          await writer.abort();
        } catch (abortError) {
          void abortError;
        }
        recordMissingSource(id, kind, input.url || null, `落盘失败：${error instanceof Error ? error.message : String(error)}`);
        scripts.push(entry);
        return;
      }
      entry.bodyRef = bodyRef;
      scripts.push(entry);
      if (input.contentHash) {
        capturedByHash.set(input.contentHash, {
          bodyRef,
          ...(input.lengthBytes !== undefined ? { sourceLength: input.lengthBytes } : {}),
        });
      }
    },
    async flush() {
      if (!missingReconciled) {
        missingReconciled = true;
        for (const missing of unresolved) {
          const duplicate = missing.entry.contentHash
            ? capturedByHash.get(missing.entry.contentHash)
            : undefined;
          const lengthMatches =
            duplicate !== undefined &&
            (missing.entry.sourceLength === undefined ||
              duplicate.sourceLength === undefined ||
              missing.entry.sourceLength === duplicate.sourceLength);
          if (duplicate && lengthMatches) {
            missing.entry.bodyRef = duplicate.bodyRef;
            continue;
          }
          recordMissingSource(
            missing.entry.id,
            missing.kind,
            missing.url,
            'getScriptSource 未返回可留存源码，且无相同 hash 的已采正文',
          );
        }
      }
      const index: PackV2ScriptsIndex = {
        schemaVersion: PACK_V2_SCHEMA_VERSION,
        scripts,
      };
      await workspace.writeArtifact(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
    },
  };
}
