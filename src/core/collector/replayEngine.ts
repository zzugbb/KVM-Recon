/**
 * Replay 计划派生引擎（规范 §16 / §19，阶段 4）。
 *
 * 从装配时事实束派生 replay/manifest.json、replay/http.jsonl 行与
 * replay/channels.json：登录候选 + 启动候选请求（带正文模板路径）与
 * Viewer 实时通道（帧序列索引路径）。每个请求 / 通道的
 * requiresDynamicValueIds 引用值传播图里需要替换的动态值节点
 * （replaySubstitution 边的来源端：会话 Cookie、crypto 摘要输出、
 * 启动响应 token），回放客户端以新鲜值替换后重放。
 *
 * 无法生成可回放计划时 replayable=false 并逐条列出缺失证据
 * （notReplayableReasons，规范 §16「必须说明缺什么资料」）。
 *
 * 纯函数、永不抛出：畸形事实按保守缺失处理。与 loginChainOf /
 * detectViewerActivity / dossierEngine 共用同一事实定义，不出现第二套判定。
 */

import type {
  PackV2ReplayChannel,
  PackV2ReplayManifest,
  PackV2ReplayRequest,
  PackV2ReplayRequestRow,
  PackV2ValueFlow,
} from '../capture-pack-v2/types';
import type { PackWsHandshakeFact } from '../capture-pack-v2/readPackFacts';
import type { WorkflowFacts } from './workflowStatusEngine';
import { detectViewerActivity } from './viewerActivity';
import type { DossierEngineResult } from './dossierEngine';

export interface ReplayEngineInput {
  facts: WorkflowFacts;
  /** dossier 派生结果（登录 / 启动候选；单一事实源，不二次判定）。 */
  dossier: DossierEngineResult;
  valueFlow: PackV2ValueFlow;
  wsHandshakes: ReadonlyArray<PackWsHandshakeFact>;
}

export interface ReplayEngineResult {
  manifest: PackV2ReplayManifest;
  httpRows: PackV2ReplayRequestRow[];
  channelsFile: { channels: PackV2ReplayChannel[] };
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

/**
 * 请求需要替换的动态值节点（值传播图）：
 * - 请求 Cookie / CSRF 等头的来源值（propagated-to 边的 from 端）；
 * - 喂入请求正文的 crypto 输出（used-in 边）及其摘要输入来源
 *   （response-body → crypto-output derived-from 边，如登录 nonce）。
 */
function requestDynamicValueIds(
  valueFlow: PackV2ValueFlow,
  transactionId: string,
): string[] {
  const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));
  const ids: string[] = [];
  const cryptoOutputIds: string[] = [];
  for (const edge of valueFlow.edges) {
    const to = nodesById.get(edge.to);
    if (!to) continue;
    if (edge.relation === 'propagated-to' && to.kind === 'header' && to.evidenceId === transactionId) {
      ids.push(edge.from);
    }
    if (edge.relation === 'used-in' && to.kind === 'http-request-body' && to.evidenceId === transactionId) {
      const from = nodesById.get(edge.from);
      if (from?.kind === 'crypto-output') {
        ids.push(from.id);
        cryptoOutputIds.push(from.id);
      }
    }
  }
  const cryptoOutputs = new Set(cryptoOutputIds);
  for (const edge of valueFlow.edges) {
    if (edge.relation !== 'derived-from') continue;
    const to = nodesById.get(edge.to);
    if (!to || !cryptoOutputs.has(to.id)) continue;
    // 摘要输入来源只认响应正文节点：request-body → crypto-output 的
    // derived-from 是 used-in 的结构反向边，请求正文本身是回放模板，
    // 不是需要替换的动态值
    const from = nodesById.get(edge.from);
    if (from?.kind !== 'http-response') continue;
    ids.push(from.id);
  }
  return unique(ids);
}

/** 通道回放需要替换的动态值节点：握手 Cookie 头与查询参数的来源值。 */
function channelDynamicValueIds(
  valueFlow: PackV2ValueFlow,
  channelId: string,
): string[] {
  const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));
  const ids: string[] = [];
  for (const edge of valueFlow.edges) {
    if (edge.relation !== 'propagated-to') continue;
    const to = nodesById.get(edge.to);
    if (!to || to.evidenceId !== channelId) continue;
    if (to.kind === 'header' || to.kind === 'url-param') ids.push(edge.from);
  }
  return unique(ids);
}

export function deriveReplayPlan(input: ReplayEngineInput): ReplayEngineResult {
  const { facts, dossier, valueFlow, wsHandshakes } = input;
  const transactionsById = new Map(facts.transactions.map(tx => [tx.id, tx]));

  // ---- 请求集：登录候选 + 启动候选，按发起时间排序 ----
  const requestIds = unique([...dossier.loginCandidateRequestIds, ...dossier.kvmLaunchCandidateRequestIds]);
  const requestTransactions = requestIds
    .map(id => transactionsById.get(id))
    .filter((tx): tx is NonNullable<typeof tx> => tx !== undefined)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const requests: PackV2ReplayRequest[] = requestTransactions.map(tx => ({
    requestId: tx.id,
    url: tx.url,
    method: tx.method,
    requiresDynamicValueIds: requestDynamicValueIds(valueFlow, tx.id),
  }));
  const httpRows: PackV2ReplayRequestRow[] = requestTransactions.map(tx => ({
    requestId: tx.id,
    url: tx.url,
    method: tx.method,
    requestBodyPath: tx.requestBody?.path ?? null,
    responseBodyPath: tx.responseBody?.path ?? null,
    occurredAt: tx.startedAt,
  }));

  // ---- 通道集：Viewer 活动信号的双向通道 ----
  const signals = detectViewerActivity(facts);
  const channelsById = new Map(facts.channels.map(channel => [channel.id, channel]));
  const replayChannels: PackV2ReplayChannel[] = [];
  for (const channelId of unique(signals.map(signal => signal.channelId))) {
    const channel = channelsById.get(channelId);
    if (!channel) continue;
    const handshake = wsHandshakes.find(candidate => candidate.channelId === channelId);
    replayChannels.push({
      channelId,
      kind: channel.kind,
      framesIndexPath: channel.kind === 'websocket' ? handshake?.framesIndexPath ?? null : null,
      requiresDynamicValueIds: channelDynamicValueIds(valueFlow, channelId),
    });
  }

  // ---- replayable 判定：缺失证据逐条显式（规范 §16）----
  const reasons: string[] = [];
  if (dossier.loginCandidateRequestIds.length === 0) {
    const hasIssuance = facts.transactions.some(
      tx =>
        tx.method.toUpperCase() === 'POST' &&
        tx.requestBody !== undefined &&
        tx.status !== null &&
        tx.status >= 200 &&
        tx.status < 400 &&
        Object.entries(tx.responseHeaders).some(([key]) => key.toLowerCase() === 'set-cookie'),
    );
    reasons.push(
      hasIssuance
        ? '未观察到会话传播：签发的 Set-Cookie 未被任何后续请求逐字节携带（登录链四组事实未合取）'
        : '未观察到登录交互：没有任何带正文的 POST 请求在 2xx/3xx 响应中签发 Set-Cookie',
    );
  }
  if (dossier.kvmLaunchCandidateRequestIds.length === 0) {
    reasons.push('未定位到启动请求：动作后在血缘集合内没有带正文的 POST 请求，也没有值传播背书的通道来源请求');
  }
  if (replayChannels.length === 0) {
    reasons.push('未观察到 Viewer 实时通道：动作 → 打开 → 渲染表面 → 双向通道四组事实未合取（规范 §7.3）');
  }
  const replayable = reasons.length === 0;

  const manifest: PackV2ReplayManifest = {
    schemaVersion: '2.0.0',
    replayable,
    ...(replayable ? {} : { notReplayableReasons: reasons }),
    clockPolicy: replayable ? 'deterministic-accelerated' : 'realtime',
    requests,
    channels: replayChannels,
  };
  return { manifest, httpRows, channelsFile: { channels: replayChannels } };
}
