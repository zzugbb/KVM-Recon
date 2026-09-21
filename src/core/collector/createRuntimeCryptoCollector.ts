/**
 * WebCrypto / 自定义算法调用落盘（规范 §8.6）。
 * 输入输出经 BodyStore 写入 raw/runtime/bodies，行写入 raw/runtime/crypto.jsonl。
 */

import { createBodyStore } from '../body-store/createBodyStore';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';
import type { CollectorEvidence } from './collectorEvidence';
import {
  type PackV2BodyRef,
  type PackV2CryptoCallRow,
  type PackV2CryptoOperationKind,
} from '../capture-pack-v2/types';
import { isRecord, stringValue } from './cdpValues';

const CRYPTO_PATH = 'raw/runtime/crypto.jsonl';
const BODIES_NAMESPACE = 'raw/runtime/bodies';

const KINDS = new Set<PackV2CryptoOperationKind>([
  'encrypt',
  'decrypt',
  'digest',
  'sign',
  'verify',
  'derive-key',
  'derive-bits',
  'generate-key',
  'import-key',
  'export-key',
  'custom',
]);

export interface RuntimeCryptoCollector {
  /** 观察脚本 binding 的 crypto payload（attach 层已解析并按 kind 路由）。 */
  recordBindingPayload(payload: Record<string, unknown>, targetId: string, occurredAt: string): Promise<void>;
  /** 派生引擎只读快照：全部调用行浅拷贝（value-flow 派生用）。 */
  rows(): PackV2CryptoCallRow[];
}

function cryptoFailureDetail(id: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `crypto 调用行 ${id} 写入失败（raw/runtime/crypto.jsonl）：${message}`;
}

function decodeB64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

export function createRuntimeCryptoCollector(
  workspace: JobWorkspace,
  evidence: CollectorEvidence,
): RuntimeCryptoCollector {
  const bodies = createBodyStore({ workspace, namespace: BODIES_NAMESPACE });
  let seq = 0;
  const rows: PackV2CryptoCallRow[] = [];

  async function store(bytes: Buffer): Promise<PackV2BodyRef> {
    const writer = await bodies.openWriter();
    try {
      await writer.write(bytes);
      return await writer.finish();
    } catch (error) {
      // 捕获 crypto 正文落盘失败：磁盘不足或工作区不可写
      // 策略：abort 临时文件后抛出，避免留下 .part
      try {
        await writer.abort();
      } catch (abortError) {
        void abortError;
      }
      throw error;
    }
  }

  return {
    async recordBindingPayload(parsed, targetId, occurredAt) {
      const kindRaw = stringValue(parsed.op);
      const kind: PackV2CryptoOperationKind = KINDS.has(kindRaw as PackV2CryptoOperationKind)
        ? (kindRaw as PackV2CryptoOperationKind)
        : 'custom';
      const algorithm = stringValue(parsed.algorithm) || 'unknown';
      seq += 1;
      const row: PackV2CryptoCallRow = {
        id: `crypto-${String(seq).padStart(4, '0')}`,
        occurredAt,
        targetId,
        kind,
        algorithm,
        algorithmParams: isRecord(parsed.algorithmParams) ? parsed.algorithmParams : {},
        scriptUrl: stringValue(parsed.scriptUrl) || undefined,
      };
      const input = decodeB64(parsed.inputB64);
      const output = decodeB64(parsed.outputB64);
      if (input) row.inputRef = await store(input);
      if (output) row.outputRef = await store(output);
      if (!row.outputRef && isRecord(parsed.outputMeta)) {
        row.outputRef = await store(Buffer.from(JSON.stringify(parsed.outputMeta), 'utf8'));
      }
      if (typeof parsed.error === 'string' && parsed.error) row.error = parsed.error;
      if (!row.inputRef && !row.outputRef && !row.error) {
        row.error = 'crypto-call-without-payload';
      }
      rows.push(row);
      try {
        await workspace.appendJsonl(CRYPTO_PATH, row);
      } catch (error) {
        // journal 行写入失败持久作证，丢失不只留进程内 droppedEvent 计数
        evidence.recordGap('journalWriteFailures', row.id, cryptoFailureDetail(row.id, error));
        throw error;
      }
    },
    rows() {
      return rows.map(row => ({ ...row }));
    },
  };
}
