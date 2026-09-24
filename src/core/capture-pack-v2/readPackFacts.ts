/**
 * 装配时事实束读取器（规范 §15）。
 *
 * 从工作区持久工件重建派生引擎的只读事实：ai/ 与 replay/ 是派生可再生
 * 内容（§11），只凭包内工件即可重新生成——派生不依赖采集
 * 会话内存态（崩溃恢复导出的残包同样适用）。
 *
 * 主框架导航与观察钩子失败在采集期只存在于内存（attach 层不落盘独立工件）；
 * 从 raw/cdp/events.jsonl 按与在线采集相同的规则重放：
 * - 主框架导航 = Page.frameNavigated 且 frame 无 parentId；
 * - 钩子失败 = 观察脚本 Runtime.bindingCalled 的 observer-hook-failed payload。
 *
 * 无上界 journal（事务 / 动作 / 表面 / crypto / CDP 事件）逐行流式读取
 * （内存上界 = 最大单行 + 解析行累计），不整体载入文件；小元数据文件
 * （targets / scripts / WS metadata）保持整体读取。
 * 缺文件 / 行不可解析 → 该维度空数组并记入缺口（dossier / replay 是派生物
 * 不是证据，派生退化不阻断导出；缺口进 ai/summary.md 供 AI 与审计可见）；
 * 读取中途 I/O 失败同样全有或全无（半份事实会派生出错误结论）。
 * 页面上报内容是不可信数据（§12）：payload 解析全部失败关闭。
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import type { ObserverHookFailure } from '../collector/collectorEvidence';
import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2CryptoCallRow,
  PackV2HttpTransactionRow,
  PackV2RenderSurfaceRow,
  PackV2ScriptEntry,
  PackV2TargetRow,
} from './types';
import {
  type WorkflowFacts,
  type WorkflowNavigationFact,
} from '../collector/workflowStatusEngine';

/** WS 握手事实（raw/websocket/<dirId>/metadata.json；replay 派生用）。 */
export interface PackWsHandshakeFact {
  channelId: string;
  url: string;
  createdAt: string;
  requestHeaders: Record<string, string>;
  /** 包内元数据路径。 */
  metadataPath: string;
  /** 帧序列索引的包内路径（目录内 frames.index.jsonl 缺失时为 null）。 */
  framesIndexPath: string | null;
}

export interface PackFactsReadResult {
  facts: WorkflowFacts;
  cryptoRows: PackV2CryptoCallRow[];
  scripts: PackV2ScriptEntry[];
  wsHandshakes: PackWsHandshakeFact[];
  /** 派生缺口（缺文件 / 不可解析行 / 无法归属的事实）。 */
  gaps: string[];
}

interface PackFactsReadOptions {
  /** catalog/channels.json 已由装配层读取时直传，避免二次读盘。 */
  channels?: ReadonlyArray<PackV2ChannelRow>;
}

/**
 * 事实束读取只依赖工件读面（readArtifact / artifactPaths / openArtifactStream）
 * ——JobWorkspace 结构满足该接口；读取已导出包的调用方也可实现它，
 * 不依赖采集会话。
 */
export interface PackArtifactReader {
  readArtifact(path: string): Promise<Buffer>;
  artifactPaths(): Promise<string[]>;
  openArtifactStream(path: string): Promise<Readable>;
}

/** 坏行上限：缺口串按文件聚合，避免数千行坏行撑爆 ai/summary.md；
 * 超出部分不静默丢弃，末尾聚合一条溢出哨兵记账（失败显式记账红线）。 */
const MAX_GAPS = 40;

export async function readPackFacts(
  workspace: PackArtifactReader,
  options: PackFactsReadOptions = {},
): Promise<PackFactsReadResult> {
  const gaps: string[] = [];
  let suppressedGaps = 0;
  const addGap = (detail: string): void => {
    if (gaps.length < MAX_GAPS) gaps.push(detail);
    else suppressedGaps += 1;
  };

  async function readBufferOrNull(path: string): Promise<Buffer | null> {
    try {
      return await workspace.readArtifact(path);
    } catch {
      return null;
    }
  }

  // 包内工件清单只走查一次：存在性判定 + WS 元数据发现共用。
  // 无上界 journal（事务 / 动作 / 表面 / crypto / CDP 事件）逐行流式
  // 读取，不整体载入（内存上界 = 最大单行 + 解析行累计）。
  const workspacePaths = new Set(await workspace.artifactPaths());

  async function* linesOf(path: string): AsyncGenerator<string> {
    const stream = await workspace.openArtifactStream(path);
    stream.setEncoding('utf8');
    yield* createInterface({ input: stream, crlfDelay: Infinity });
  }

  async function readJsonl<T>(path: string, isValid: (row: unknown) => row is T): Promise<T[]> {
    if (!workspacePaths.has(path)) {
      addGap(`派生事实缺失：${path} 不在包内，该维度按空处理`);
      return [];
    }
    const rows: T[] = [];
    let broken = 0;
    try {
      for await (const line of linesOf(path)) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          broken += 1;
          continue;
        }
        if (isValid(parsed)) {
          rows.push(parsed);
        } else {
          broken += 1;
        }
      }
    } catch {
      // 读取中途失败（I/O 错误）：全有或全无——半份事实会派生出错误的
      // 结论，按空维度处理并显式记账
      addGap(`派生事实缺口：${path} 读取失败，该维度按空处理`);
      return [];
    }
    if (broken > 0) addGap(`派生事实缺口：${path} 有 ${broken} 行不可解析或结构非法，已跳过`);
    return rows;
  }

  const transactions = await readJsonl<PackV2HttpTransactionRow>(
    'raw/http/transactions.jsonl',
    (row): row is PackV2HttpTransactionRow =>
      typeof row === 'object' && row !== null &&
      typeof (row as PackV2HttpTransactionRow).id === 'string' &&
      typeof (row as PackV2HttpTransactionRow).url === 'string' &&
      typeof (row as PackV2HttpTransactionRow).method === 'string',
  );
  const actions = await readJsonl<PackV2BrowserActionRow>(
    'raw/browser/actions.jsonl',
    (row): row is PackV2BrowserActionRow =>
      typeof row === 'object' && row !== null &&
      typeof (row as PackV2BrowserActionRow).id === 'string' &&
      typeof (row as PackV2BrowserActionRow).targetId === 'string',
  );
  const renderSurfaces = await readJsonl<PackV2RenderSurfaceRow>(
    'raw/browser/render-surfaces.jsonl',
    (row): row is PackV2RenderSurfaceRow =>
      typeof row === 'object' && row !== null &&
      typeof (row as PackV2RenderSurfaceRow).id === 'string' &&
      typeof (row as PackV2RenderSurfaceRow).targetId === 'string',
  );
  const cryptoRows = await readJsonl<PackV2CryptoCallRow>(
    'raw/runtime/crypto.jsonl',
    (row): row is PackV2CryptoCallRow =>
      typeof row === 'object' && row !== null &&
      typeof (row as PackV2CryptoCallRow).id === 'string' &&
      typeof (row as PackV2CryptoCallRow).occurredAt === 'string',
  );

  async function readTargets(): Promise<PackV2TargetRow[]> {
    const buffer = await readBufferOrNull('catalog/targets.json');
    if (buffer === null) {
      addGap('派生事实缺失：catalog/targets.json 不在包内，target 血缘按空处理');
      return [];
    }
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as { targets?: unknown };
      if (!parsed || !Array.isArray(parsed.targets)) {
        addGap('派生事实缺口：catalog/targets.json 缺少 targets 数组，按空处理');
        return [];
      }
      return parsed.targets.filter(
        (row): row is PackV2TargetRow =>
          typeof row === 'object' && row !== null && typeof (row as PackV2TargetRow).id === 'string',
      );
    } catch {
      addGap('派生事实缺口：catalog/targets.json 不可解析，target 血缘按空处理');
      return [];
    }
  }
  const targets = await readTargets();

  async function readScripts(): Promise<PackV2ScriptEntry[]> {
    const buffer = await readBufferOrNull('raw/scripts/index.json');
    if (buffer === null) {
      addGap('派生事实缺失：raw/scripts/index.json 不在包内，脚本候选按空处理');
      return [];
    }
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as { scripts?: unknown };
      if (!parsed || !Array.isArray(parsed.scripts)) {
        addGap('派生事实缺口：raw/scripts/index.json 缺少 scripts 数组，按空处理');
        return [];
      }
      return parsed.scripts.filter(
        (row): row is PackV2ScriptEntry =>
          typeof row === 'object' && row !== null && typeof (row as PackV2ScriptEntry).id === 'string',
      );
    } catch {
      addGap('派生事实缺口：raw/scripts/index.json 不可解析，脚本候选按空处理');
      return [];
    }
  }
  const scripts = await readScripts();

  // ---- 主框架导航 + 观察钩子失败：重放 raw/cdp/events.jsonl（逐行流式）----
  const navigations: WorkflowNavigationFact[] = [];
  const hookFailures: ObserverHookFailure[] = [];
  if (!workspacePaths.has('raw/cdp/events.jsonl')) {
    addGap('派生事实缺失：raw/cdp/events.jsonl 不在包内，主框架导航与钩子失败按空处理');
  } else {
    let broken = 0;
    let readFailed = false;
    try {
      for await (const line of linesOf('raw/cdp/events.jsonl')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          broken += 1;
          continue;
        }
        const row = parsed as {
          timestamp?: unknown;
          method?: unknown;
          targetId?: unknown;
          params?: unknown;
        };
        if (typeof row.method !== 'string' || typeof row.timestamp !== 'string') {
          broken += 1;
          continue;
        }
        const params = row.params !== null && typeof row.params === 'object'
          ? (row.params as Record<string, unknown>)
          : {};
        // 与在线采集同一规则：frameNavigated 且 frame 无 parentId = 主框架导航
        if (row.method === 'Page.frameNavigated') {
          const frame = params.frame !== null && typeof params.frame === 'object'
            ? (params.frame as Record<string, unknown>)
            : null;
          if (!frame || frame.parentId !== undefined) continue;
          if (typeof row.targetId !== 'string' || !row.targetId) {
            broken += 1;
            continue;
          }
          const url = typeof frame.url === 'string' ? frame.url : null;
          navigations.push({ occurredAt: row.timestamp, targetId: row.targetId, url });
          continue;
        }
        // 观察脚本钩子安装失败（页面内容不可信：只认结构完整的 payload）
        if (row.method === 'Runtime.bindingCalled' && typeof params.payload === 'string') {
          try {
            const payload = JSON.parse(params.payload) as Record<string, unknown>;
            if (
              payload !== null && typeof payload === 'object' && payload.kind === 'observer-hook-failed' &&
              typeof payload.hook === 'string'
            ) {
              hookFailures.push({
                hook: payload.hook,
                stage: typeof payload.stage === 'string' ? payload.stage : 'unknown',
                detail: typeof payload.detail === 'string' ? payload.detail : 'no detail',
              });
            }
          } catch {
            // 非观察脚本的 binding 调用（页面自身用法）不是钩子失败证据
          }
        }
      }
    } catch {
      readFailed = true;
    }
    if (readFailed) {
      // 全有或全无：半份事件重放会漏掉导航 / 钩子失败事实
      navigations.length = 0;
      hookFailures.length = 0;
      addGap('派生事实缺口：raw/cdp/events.jsonl 读取失败，主框架导航与钩子失败按空处理');
    } else if (broken > 0) {
      addGap(`派生事实缺口：raw/cdp/events.jsonl 有 ${broken} 行不可解析或结构非法，已跳过`);
    }
  }

  // ---- WS 握手事实：扫描 raw/websocket/*/metadata.json ----
  const wsHandshakes: PackWsHandshakeFact[] = [];
  const metadataPaths = [...workspacePaths]
    .filter(path => /^raw\/websocket\/[^/]+\/metadata\.json$/.test(path))
    .sort();
  for (const metadataPath of metadataPaths) {
    const buffer = await readBufferOrNull(metadataPath);
    if (buffer === null) continue;
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as {
        channelId?: unknown;
        url?: unknown;
        createdAt?: unknown;
        requestHeaders?: unknown;
      };
      if (typeof parsed.channelId !== 'string' || typeof parsed.createdAt !== 'string') {
        addGap(`派生事实缺口：${metadataPath} 结构非法，该通道握手事实跳过`);
        continue;
      }
      const framesIndexPath = metadataPath.replace(/metadata\.json$/, 'frames.index.jsonl');
      wsHandshakes.push({
        channelId: parsed.channelId,
        url: typeof parsed.url === 'string' ? parsed.url : '',
        createdAt: parsed.createdAt,
        requestHeaders:
          parsed.requestHeaders !== null && typeof parsed.requestHeaders === 'object'
            ? (parsed.requestHeaders as Record<string, string>)
            : {},
        metadataPath,
        framesIndexPath: workspacePaths.has(framesIndexPath) ? framesIndexPath : null,
      });
    } catch {
      addGap(`派生事实缺口：${metadataPath} 不可解析，该通道握手事实跳过`);
    }
  }
  const facts: WorkflowFacts = {
    transactions,
    actions,
    targets,
    channels: options.channels ?? [],
    navigations,
    renderSurfaces,
    hookFailures,
  };
  if (suppressedGaps > 0) {
    gaps.push(`派生事实缺口：另有 ${suppressedGaps} 条超出 ${MAX_GAPS} 条上限，已聚合`);
  }
  return { facts, cryptoRows, scripts, wsHandshakes, gaps };
}
