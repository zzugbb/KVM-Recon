/**
 * Replay 计划派生引擎（规范 §16）。
 *
 * 从装配时事实束派生 replay/manifest.json、replay/http.jsonl 行与
 * replay/channels.json：登录候选 + 启动候选请求（带正文模板路径）与
 * Viewer 实时通道（帧序列索引路径）。每个请求 / 通道的
 * requiresDynamicValueIds 引用值传播图里需要替换的动态值节点
 * （replaySubstitution 边的来源端：会话 Cookie、crypto 摘要输出、
 * 启动响应 token），回放客户端以新鲜值替换后重放。
 *
 * 动态值闭环：回放请求 / 通道若携带会话凭证（Cookie 头里登录签发的
 * name=value 对、与签发值逐字节相等的头值、握手 Cookie），则必须能沿
 * valueFlow propagated-to 边回溯到替换来源；链断裂（事实侧有凭证、传播
 * 图无来源）时 replayable=false 并逐条说明——重放将携带过期凭证，不能
 * 静默放行。纯静态站点（无凭证）保留空清单 + replayable=true。
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
import { headerOf, loginIssuances } from './workflowStatusEngine';
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

/** 返回必须由值传播图背书的凭据名；签发 Cookie 按 name=value 逐字节确认。
 * Bearer/Token/JWT 也不能以采集时的旧值直接宣称可回放。 */
function credentialNames(
  headers: Readonly<Record<string, string>>,
  issuedPairs: ReadonlySet<string>,
): string[] {
  const names: string[] = [];
  const cookieHeader = headerOf(headers, 'cookie');
  if (cookieHeader) {
    for (const token of cookieHeader.split(';')) {
      const pair = token.trim();
      if (issuedPairs.has(pair)) names.push(pair.slice(0, pair.indexOf('=')));
    }
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!value || name.toLowerCase() === 'cookie') continue;
    if (issuedPairs.has(value) || (
      /^(?:authorization|proxy-authorization)$/i.test(name) && /^(?:Bearer|Token|JWT)\s+\S+/i.test(value)
    )) names.push(name);
  }
  return unique(names);
}

/** 传播图是否给该证据（事务 / 通道）的请求头提供了替换来源：
 * propagated-to 边落到该证据的 header 节点即闭环（边来源端由
 * requestDynamicValueIds / channelDynamicValueIds 收进 requires 清单）。 */
function hasTracedHeaderSource(
  valueFlow: PackV2ValueFlow,
  evidenceId: string,
  credentialName: string,
): boolean {
  const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));
  return valueFlow.edges.some(edge => {
    if (edge.relation !== 'propagated-to') return false;
    const to = nodesById.get(edge.to);
    return to?.kind === 'header' && to.evidenceId === evidenceId &&
      to.name.toLowerCase().startsWith(`${credentialName.toLowerCase()}（`);
  });
}

function untracedChannelParams(valueFlow: PackV2ValueFlow, channelId: string, url: string): string[] {
  let names: string[];
  try {
    names = unique([...new URL(url).searchParams.keys()]);
  } catch {
    return ['URL 不可解析'];
  }
  if (names.length === 0) return [];
  const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));
  return names.filter(name => !valueFlow.edges.some(edge => {
    if (edge.relation !== 'propagated-to') return false;
    const to = nodesById.get(edge.to);
    return to?.kind === 'url-param' && to.evidenceId === channelId &&
      to.name.toLowerCase().startsWith(`${name.toLowerCase()}（`);
  }));
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

  // ---- 动态值闭环：携带会话凭证的请求 / 通道必须可替换（链断裂显式记账） ----
  const issuedPairs = new Set(loginIssuances(facts).map(entry => entry.pair));
  const credentialBreaks: string[] = [];
  for (const request of requests) {
    const tx = transactionsById.get(request.requestId);
    if (!tx) continue;
    const credentials = credentialNames(tx.requestHeaders, issuedPairs);
    if (credentials.some(name => !hasTracedHeaderSource(valueFlow, tx.id, name))) {
      credentialBreaks.push(
        `回放请求 ${tx.id}（${tx.method} ${tx.url}）携带会话凭证但值传播链断裂：无法替换为新鲜会话值，重放将携带过期凭证`,
      );
    }
  }
  for (const channel of replayChannels) {
    const handshake = wsHandshakes.find(candidate => candidate.channelId === channel.channelId);
    if (channel.kind === 'websocket' && (!handshake || !channel.framesIndexPath)) {
      credentialBreaks.push(`回放通道 ${channel.channelId} 缺少 WS 握手或帧索引，无法重放实时画面`);
    }
    if (!handshake) continue;
    const credentials = credentialNames(handshake.requestHeaders, issuedPairs);
    if (credentials.some(name => !hasTracedHeaderSource(valueFlow, channel.channelId, name))) {
      credentialBreaks.push(
        `回放通道 ${channel.channelId} 握手携带会话凭证但值传播链断裂：无法替换为新鲜会话值，重放将携带过期凭证`,
      );
    }
    const untracedParams = untracedChannelParams(valueFlow, channel.channelId, handshake.url);
    if (untracedParams.length > 0) {
      credentialBreaks.push(
        `回放通道 ${channel.channelId} 的 WS 查询参数缺少值传播来源（${untracedParams.join('、')}）：无法证明可替换为新鲜值`,
      );
    }
  }

  // ---- replayable 判定：缺失证据逐条显式（规范 §16）----
  const reasons: string[] = [];
  if (dossier.loginCandidateRequestIds.length === 0) {
    const hasIssuance = issuedPairs.size > 0;
    reasons.push(
      hasIssuance
        ? '未观察到会话传播：签发的 Set-Cookie 未被任何后续请求逐字节携带（登录链四组事实未合取）'
        : '未观察到登录交互：没有 Set-Cookie 签发（带正文的 POST + 2xx/3xx 响应），也没有凭据头形态请求（Authorization 类）',
    );
  }
  if (dossier.kvmLaunchCandidateRequestIds.length === 0) {
    reasons.push('未定位到启动请求：动作后在血缘时间窗内没有带正文的 POST / xhr-fetch GET 请求，也没有值传播背书的通道来源请求');
  }
  if (replayChannels.length === 0) {
    reasons.push('未观察到 Viewer 实时通道：动作 → 打开 → 渲染表面 → 双向通道四组事实未合取（规范 §7.3）');
  }
  reasons.push(...credentialBreaks);
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
