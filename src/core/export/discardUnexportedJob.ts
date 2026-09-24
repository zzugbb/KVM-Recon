/**
 * 未导出作业的丢弃门禁（零观察事实放宽）。
 *
 * 红线：未导出的现场资料必须保留。只有事务 / 通道 / 动作行全空，
 * 且其他已知证据面也为空，才允许不导出直接丢弃——判定消息
 * 随丢弃动作显式记账；无记账的静默丢弃等于编造。
 *
 * 门禁条件：工作区已收尾（finalized）且无已知现场证据。未收尾
 * （active）一律拒绝——收尾序列可能仍在写观察事实；行数不可读按不可
 * 证明零观察处理（宁可保留，不可错删）。已导出的作业不经本门禁
 * （capture:discard 原有路径直接清理）。
 */

import {
  countObservationRows,
  isZeroObservation,
  OBSERVATION_ROWS_UNKNOWN,
  type ObservationRowCounts,
} from '../collector/observationRowCount';
import type { JobWorkspace } from '../job-workspace/createJobWorkspace';

const ADDITIONAL_JOURNALS = [
  'catalog/resources.jsonl',
  'catalog/relations.jsonl',
  'raw/cdp/events.jsonl',
  'raw/cdp/commands.jsonl',
  'raw/browser/timeline.jsonl',
  'raw/browser/render-surfaces.jsonl',
  'raw/browser/console.jsonl',
  'raw/controller/diagnostics.jsonl',
  'raw/runtime/crypto.jsonl',
  'raw/realtime/webrtc.jsonl',
  'raw/realtime/webtransport.jsonl',
  'raw/realtime/sse.jsonl',
  'raw/realtime/downloads.jsonl',
] as const;

async function hasAdditionalEvidence(workspace: JobWorkspace): Promise<string | null> {
  const paths = new Set(await workspace.artifactPaths());
  for (const path of ADDITIONAL_JOURNALS) {
    if (!paths.has(path)) continue;
    const stream = await workspace.openArtifactStream(path);
    try {
      for await (const chunk of stream) {
        if (String(chunk).trim()) return path;
      }
    } finally {
      stream.destroy();
    }
  }
  const binaryEvidence = [...paths].find(path =>
    path.startsWith('raw/http/bodies/') ||
    path.startsWith('raw/browser/screenshots/') ||
    path.startsWith('raw/browser/dom-snapshots/') ||
    path.startsWith('raw/scripts/files/') ||
    path.startsWith('raw/websocket/') ||
    path.startsWith('raw/realtime/bodies/') ||
    path.startsWith('raw/realtime/downloads/') ||
    path.startsWith('raw/runtime/bodies/') ||
    path === 'raw/netlog/netlog.json' ||
    path === 'raw/http/session.har' ||
    path === 'raw/browser/storage.json' ||
    path === 'raw/browser/targets.json' ||
    path === 'raw/browser/frame-tree.json' ||
    path === 'raw/scripts/index.json',
  );
  if (binaryEvidence) return binaryEvidence;
  if (paths.has('raw/probe/index.json')) {
    const probe = JSON.parse((await workspace.readArtifact('raw/probe/index.json')).toString('utf8')) as {
      probeRan?: unknown;
      facts?: unknown;
    };
    if (probe.probeRan !== false || !Array.isArray(probe.facts) || probe.facts.length > 0) {
      return 'raw/probe/index.json';
    }
  }
  return null;
}

export interface UnexportedDiscardCheck {
  /** true = 允许不导出直接丢弃（cleanup 需带 allowUnexportedDiscard）。 */
  ok: boolean;
  /** 判定依据（行数，-1 = 不可读）。 */
  counts: ObservationRowCounts;
  /** 判定说明：给用户看，也进丢弃时的诊断记账。 */
  note: string;
}

function formatCounts(counts: ObservationRowCounts): string {
  const fmt = (count: number) => (count === OBSERVATION_ROWS_UNKNOWN ? '未知' : String(count));
  return `HTTP ${fmt(counts.transactions)} / 通道 ${fmt(counts.channels)} / 动作 ${fmt(counts.actions)}`;
}

const UNKNOWN_COUNTS: ObservationRowCounts = {
  transactions: OBSERVATION_ROWS_UNKNOWN,
  channels: OBSERVATION_ROWS_UNKNOWN,
  actions: OBSERVATION_ROWS_UNKNOWN,
};

export async function checkUnexportedDiscard(workspace: JobWorkspace): Promise<UnexportedDiscardCheck> {
  if (workspace.state !== 'finalized') {
    return {
      ok: false,
      counts: UNKNOWN_COUNTS,
      note: '作业尚未收尾（active），未收尾的现场资料必须保留：先停止并收尾',
    };
  }
  const counts = await countObservationRows(workspace);
  if (isZeroObservation(counts)) {
    let additionalEvidence: string | null;
    try {
      additionalEvidence = await hasAdditionalEvidence(workspace);
    } catch {
      return {
        ok: false,
        counts,
        note: '其他证据无法读取，不能证明作业为空；现场资料保留',
      };
    }
    if (additionalEvidence) {
      return {
        ok: false,
        counts,
        note: `虽无 HTTP/通道/动作行，但存在 ${additionalEvidence} 证据；先导出再丢弃`,
      };
    }
    return {
      ok: true,
      counts,
      note: `零观察事实且无其他已知证据（${formatCounts(counts)} 行）：允许不导出直接丢弃`,
    };
  }
  const anyUnknown =
    counts.transactions === OBSERVATION_ROWS_UNKNOWN ||
    counts.channels === OBSERVATION_ROWS_UNKNOWN ||
    counts.actions === OBSERVATION_ROWS_UNKNOWN;
  return {
    ok: false,
    counts,
    note: anyUnknown
      ? `观察事实行数不可读（${formatCounts(counts)}），不能证明零观察，不放宽丢弃；现场资料保留`
      : `作业有观察事实（${formatCounts(counts)} 行），未导出的现场资料必须保留：先导出再丢弃`,
  };
}
