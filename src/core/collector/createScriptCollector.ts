/**
 * 动态脚本 / Worker / WASM 源码索引（规范 §8.3）。
 * Debugger.scriptParsed 后取源码，正文写入 raw/scripts/files。
 * 源码取不到时仍登记索引（无 bodyRef）并记 missingWorkerSources 缺口，
 * 绝不假装已采到。
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

  function recordMissingSource(id: string, kind: DynamicScriptKind, url: string | null, detail: string): void {
    if (kind === 'worker' || kind === 'shared-worker' || kind === 'service-worker' || kind === 'wasm') {
      evidence.recordGap('missingWorkerSources', id, `${kind} 源码缺失：${detail}（url=${url ?? 'inline'}）`);
    }
  }

  return {
    async addParsed(input) {
      const id = `${input.targetId}::${input.scriptId}`;
      if (seen.has(id)) return;
      seen.add(id);
      const kind = classify(input);
      const writer = await files.openWriter();
      let bodyRef;
      try {
        await writer.write(input.sourceBytes ?? Buffer.from(input.source, 'utf8'));
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
        scripts.push({
          id,
          kind,
          url: input.url || null,
          targetId: input.targetId,
          createdBy: input.createdBy,
        });
        return;
      }
      const hasContent = (input.sourceBytes?.byteLength ?? Buffer.byteLength(input.source)) > 0;
      if (!hasContent) {
        recordMissingSource(id, kind, input.url || null, 'Debugger 未返回源码');
      }
      scripts.push({
        id,
        kind,
        url: input.url || null,
        targetId: input.targetId,
        createdBy: input.createdBy,
        bodyRef,
        sourceMapPath: input.sourceMapURL || undefined,
      });
    },
    async flush() {
      const index: PackV2ScriptsIndex = {
        schemaVersion: PACK_V2_SCHEMA_VERSION,
        scripts,
      };
      await workspace.writeArtifact(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
    },
  };
}
