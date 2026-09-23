/**
 * 适配候选链派生引擎（规范 §12 / §19，阶段 4）。
 *
 * 从装配时事实束（readPackFacts 重建 + 装配层已解析的 value-flow）派生
 * ai/adapter-dossier.json 的候选链与 ai/index.json 的候选 ID 列表。
 * 协议无关、不依赖厂商 URL 与页面语义：候选按时间与因果关系定位——
 * - 登录链：loginChainOf（观察到的 Set-Cookie 签发 + 逐字节传播）；
 * - Viewer 链：detectViewerActivity（动作 → 打开 → 表面 → 双向通道）；
 * - 启动候选：动作后在动作 target 血缘内带正文的 POST 请求，加上值传播
 *   图背书的「响应正文 → WS 握手查询参数」来源请求；
 * - 脚本 / Worker / WASM 候选：Viewer 血缘集合内的脚本索引条目。
 * 每一步只引用稳定 ID 与包内真实路径；无法派生的角色整步省略
 * （缺失由 replay 的 notReplayableReasons 与 ai/index 空列表显式表达）。
 *
 * 纯函数、永不抛出：畸形事实按保守缺失处理。与 workflowStatusEngine /
 * viewerActivity / valueFlowEngine 共用同一事实定义，不出现第二套判定。
 */

import type {
  AdapterDossierStep,
  PackV2CryptoCallRow,
  PackV2ScriptEntry,
  PackV2ValueFlow,
} from '../capture-pack-v2/types';
import type { PackWsHandshakeFact } from '../capture-pack-v2/readPackFacts';
import { timeOf, viewerLineageOf, type WorkflowFacts } from './workflowStatusEngine';
import { detectViewerActivity, type ViewerActivitySignal } from './viewerActivity';
import { loginChainOf } from './workflowStatusEngine';
const TX_PATH = 'raw/http/transactions.jsonl';
const CRYPTO_PATH = 'raw/runtime/crypto.jsonl';
const VALUE_FLOW_PATH = 'ai/value-flow.json';
const ACTIONS_PATH = 'raw/browser/actions.jsonl';
const TARGETS_PATH = 'catalog/targets.json';
const SCRIPTS_PATH = 'raw/scripts/index.json';
const CHANNELS_PATH = 'catalog/channels.json';

/** Worker 类脚本 kind（workerIds 候选）。 */
const WORKER_SCRIPT_KINDS = new Set(['worker', 'shared-worker', 'service-worker']);
/** 无法用普通 HTTP GET 重取的动态脚本 kind（dynamicScriptIds 候选）；
 * network-script / source-map 可按 URL 重取，证据在事务与资源索引里。 */
const DYNAMIC_SCRIPT_KINDS = new Set(['inline', 'eval', 'function', 'blob', 'data']);

export interface DossierEngineInput {
  facts: WorkflowFacts;
  cryptoRows: ReadonlyArray<PackV2CryptoCallRow>;
  scripts: ReadonlyArray<PackV2ScriptEntry>;
  valueFlow: PackV2ValueFlow;
  wsHandshakes: ReadonlyArray<PackWsHandshakeFact>;
}

export interface DossierEngineResult {
  candidateChain: AdapterDossierStep[];
  loginCandidateRequestIds: string[];
  kvmLaunchCandidateRequestIds: string[];
  viewerTargetIds: string[];
  dynamicScriptIds: string[];
  workerIds: string[];
  wasmIds: string[];
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

export function deriveAdapterDossier(input: DossierEngineInput): DossierEngineResult {
  const { facts, valueFlow } = input;
  const nodesById = new Map(valueFlow.nodes.map(node => [node.id, node]));

  const login = loginChainOf(facts);
  const signals = detectViewerActivity(facts);
  const primary: ViewerActivitySignal | null = signals.length > 0 ? signals[0] : null;

  const chain: AdapterDossierStep[] = [];
  const propagatedTxIds = new Set(login?.propagatedTransactionIds ?? []);

  // ---- 登录链（login-interaction / session-established）----
  if (login) {
    const loginTx = facts.transactions.find(tx => tx.id === login.loginTransactionId);
    // 登录请求正文的 crypto 输入证据：crypto 输出 → 请求正文 used-in 边
    const cryptoIds: string[] = [];
    const loginValueNodeIds: string[] = [];
    const loginBodyNode = valueFlow.nodes.find(
      node => node.kind === 'http-request-body' && node.evidenceId === login.loginTransactionId,
    );
    if (loginBodyNode) {
      for (const edge of valueFlow.edges) {
        if (edge.to !== loginBodyNode.id || edge.relation !== 'used-in') continue;
        const from = nodesById.get(edge.from);
        if (from?.kind !== 'crypto-output' || !from.evidenceId) continue;
        cryptoIds.push(from.evidenceId);
        loginValueNodeIds.push(from.id);
      }
    }
    chain.push({
      role: 'login-interaction',
      title: '登录交互：签发 Session Cookie 的 POST 请求',
      evidenceIds: unique([login.loginTransactionId, ...cryptoIds]),
      evidencePaths: unique([
        TX_PATH,
        ...(cryptoIds.length > 0 ? [CRYPTO_PATH] : []),
        ...(loginValueNodeIds.length > 0 ? [VALUE_FLOW_PATH] : []),
      ]),
      occurredAt: loginTx?.startedAt,
    });

    // Session 建立证据：签发节点的传播边（→ storage / → 携带事务的头节点）
    const sessionNodeIds: string[] = [];
    for (const edge of valueFlow.edges) {
      if (edge.relation !== 'propagated-to') continue;
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to) continue;
      if (from.kind === 'http-response' && from.evidenceId === login.loginTransactionId) {
        if (to.kind === 'cookie' || to.kind === 'header') sessionNodeIds.push(from.id);
      } else if (from.kind === 'cookie' && to.kind === 'header' && to.evidenceId && propagatedTxIds.has(to.evidenceId)) {
        sessionNodeIds.push(from.id);
      }
    }
    chain.push({
      role: 'session-established',
      title: 'Session 建立：签发的 Cookie 被后续请求逐字节携带',
      evidenceIds: unique([login.loginTransactionId, ...sessionNodeIds]),
      evidencePaths: unique([TX_PATH, ...(sessionNodeIds.length > 0 ? [VALUE_FLOW_PATH] : [])]),
      occurredAt: new Date(login.issuedAt).toISOString(),
    });
  }
  // 登录候选 = 全部「签发且被传播」的签发事务（再按签发事务形态过滤，
  // 防御 value-flow 之外的形态异常行）
  const loginCandidateRequestIds: string[] = [];
  if (login) {
    for (const tx of facts.transactions) {
      if (!login.propagatedIssuerTransactionIds.includes(tx.id)) continue;
      if (tx.method.toUpperCase() !== 'POST' || !tx.requestBody) continue;
      if (tx.status === null || tx.status < 200 || tx.status >= 400) continue;
      const setCookie = Object.entries(tx.responseHeaders).find(
        ([key]) => key.toLowerCase() === 'set-cookie',
      );
      if (setCookie) loginCandidateRequestIds.push(tx.id);
    }
  }

  // ---- Viewer 链（kvm-click → realtime-channel）----
  const launchCandidateIds = new Set<string>();
  const viewerTargetIds: string[] = [];
  const dynamicScriptIds: string[] = [];
  const workerIds: string[] = [];
  const wasmIds: string[] = [];

  for (const signal of signals) {
    const action = facts.actions.find(candidate => candidate.id === signal.actionId);
    if (!action || !action.targetId) continue;
    const lineage = viewerLineageOf(action.targetId, facts.targets);
    const actionAt = timeOf(signal.actionAt);
    const channelAt = timeOf(signal.channelCreatedAt);

    // aiIndex：Viewer target + 血缘内 Worker target
    viewerTargetIds.push(signal.viewerTargetId);
    for (const target of facts.targets) {
      if (target.type !== 'worker' && target.type !== 'shared-worker' && target.type !== 'service-worker') continue;
      if (lineage.has(target.id)) viewerTargetIds.push(target.id);
    }

    // aiIndex：血缘内脚本按 kind 分类
    for (const script of input.scripts) {
      if (!script.targetId || !lineage.has(script.targetId)) continue;
      if (WORKER_SCRIPT_KINDS.has(script.kind)) workerIds.push(script.id);
      else if (script.kind === 'wasm') wasmIds.push(script.id);
      else if (DYNAMIC_SCRIPT_KINDS.has(script.kind)) dynamicScriptIds.push(script.id);
    }

    // 启动候选：值传播背书（响应正文 → 本通道握手查询参数）+ 时间窗口内
    // 血缘集合中带正文的 POST 请求（按信号隔离，链步只用本信号的候选）。
    // 值传播背书来源同样受时间窗约束：早于动作发起的请求不是点击触发的
    // 启动请求，晚于通道建立的响应进不了握手。
    const signalLaunchIds = new Set<string>();
    for (const edge of valueFlow.edges) {
      if (edge.relation !== 'propagated-to') continue;
      const to = nodesById.get(edge.to);
      if (!to || to.kind !== 'url-param' || to.evidenceId !== signal.channelId) continue;
      const from = nodesById.get(edge.from);
      if (from?.kind !== 'http-response' || !from.evidenceId) continue;
      const source = facts.transactions.find(tx => tx.id === from.evidenceId);
      if (!source) continue;
      const startedAt = timeOf(source.startedAt);
      if (startedAt < actionAt || startedAt >= channelAt) continue;
      signalLaunchIds.add(from.evidenceId);
    }
    for (const tx of facts.transactions) {
      if (tx.method.toUpperCase() !== 'POST' || !tx.requestBody) continue;
      if (!tx.targetId || !lineage.has(tx.targetId)) continue;
      const at = timeOf(tx.startedAt);
      if (at < actionAt || at >= channelAt) continue;
      signalLaunchIds.add(tx.id);
    }
    for (const id of signalLaunchIds) launchCandidateIds.add(id);

    if (signal !== primary) continue;

    // ---- 候选链（首个完整信号）----
    chain.push({
      role: 'kvm-click',
      title: `用户动作（${signal.actionKind}）触发 Viewer 打开`,
      evidenceIds: [signal.actionId],
      evidencePaths: [ACTIONS_PATH],
      occurredAt: signal.actionAt,
    });

    const launchStepIds = [...signalLaunchIds]
      .map(id => facts.transactions.find(tx => tx.id === id))
      .filter((tx): tx is NonNullable<typeof tx> => tx !== undefined)
      .sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt));
    if (launchStepIds.length > 0) {
      chain.push({
        role: 'launch-request',
        title: '启动请求：动作后在血缘集合内带正文的 POST（含值传播背书来源）',
        evidenceIds: launchStepIds.map(tx => tx.id),
        evidencePaths: [TX_PATH],
        occurredAt: launchStepIds[0].startedAt,
      });
    }

    // Viewer 打开证据：文档事务 + 血缘内 Worker target
    const openedAt = timeOf(signal.openedAt);
    const documentTx = facts.transactions
      .filter(
        tx =>
          tx.resourceType.toLowerCase() === 'document' &&
          tx.targetId !== undefined &&
          lineage.has(tx.targetId) &&
          timeOf(tx.startedAt) >= openedAt,
      )
      .sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt))[0];
    const workerTargetIds = facts.targets
      .filter(
        target =>
          (target.type === 'worker' || target.type === 'shared-worker' || target.type === 'service-worker') &&
          lineage.has(target.id),
      )
      .map(target => target.id);
    chain.push({
      role: 'viewer-opened',
      title: signal.openedVia === 'popup' ? 'Viewer 打开：动作后弹出的 popup target' : 'Viewer 打开：动作后的主框架导航',
      evidenceIds: unique([signal.viewerTargetId, ...(documentTx ? [documentTx.id] : []), ...workerTargetIds]),
      evidencePaths: unique([TARGETS_PATH, ...(documentTx ? [TX_PATH] : [])]),
      occurredAt: signal.openedAt,
    });

    const lineageScriptIds = input.scripts
      .filter(script => script.targetId !== null && lineage.has(script.targetId))
      .map(script => script.id);
    if (lineageScriptIds.length > 0) {
      chain.push({
        role: 'script-worker-wasm',
        title: 'Viewer 血缘集合内的动态脚本 / Worker / WASM 源码索引',
        evidenceIds: lineageScriptIds,
        evidencePaths: [SCRIPTS_PATH],
      });
    }

    const channelValueNodeIds = valueFlow.nodes
      .filter(node => node.evidenceId === signal.channelId)
      .map(node => node.id);
    const handshake = input.wsHandshakes.find(candidate => candidate.channelId === signal.channelId);
    chain.push({
      role: 'realtime-channel',
      title: `实时通道建立（${signal.channelKind}）`,
      evidenceIds: unique([signal.channelId, ...channelValueNodeIds]),
      evidencePaths: unique([
        CHANNELS_PATH,
        ...(handshake ? [handshake.metadataPath] : []),
        ...(handshake?.framesIndexPath ? [handshake.framesIndexPath] : []),
      ]),
      occurredAt: signal.channelCreatedAt,
    });
  }

  return {
    candidateChain: chain,
    loginCandidateRequestIds: unique(loginCandidateRequestIds),
    kvmLaunchCandidateRequestIds: unique([...launchCandidateIds]),
    viewerTargetIds: unique(viewerTargetIds),
    dynamicScriptIds: unique(dynamicScriptIds),
    workerIds: unique(workerIds),
    wasmIds: unique(wasmIds),
  };
}
