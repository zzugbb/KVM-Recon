/**
 * 值传播与证据图派生引擎（规范 §8.6 / §16）。
 *
 * 从观察事实派生 ai/value-flow.json 的节点与边、catalog/relations.jsonl 的
 * 结构关系行。协议无关、不依赖厂商 URL 与页面语义；边只记有字节级观察
 * 背书的传播：
 * - cookie 链：响应 Set-Cookie 的 name=value → storage cookie → 后续请求 /
 *   WS 握手 Cookie 头（逐字节相同；时间有序；storage 缺该 cookie 时退化为
 *   Set-Cookie → Cookie 头直连边）；
 * - crypto 链：调用输入字节（原始 / hex / base64 编码形态）⊆ 先前响应正文
 *   → derived-from；调用输出字节（同样三种编码形态）⊆ 后续请求正文 →
 *   used-in + derived-from；
 * - WS 握手查询参数值 ⊆ 先前响应正文 → propagated-to。
 * 无匹配就无边；不参与任何边的节点不出图（空图是诚实形态）。
 *
 * 正文逐份读取（注入 readBody，读一份放一份，不整包载入）；包含匹配要求
 * 源值 ≥ MIN_CONTAINED_BYTES 字节，短值在任何正文里都能子串命中，不构成
 * 值传播证据。纯函数：只读事实、无副作用；时间戳不可解析时按 0 处理。
 */

import type {
  PackV2BodyRef,
  PackV2ChannelRow,
  PackV2CryptoCallRow,
  PackV2HttpTransactionRow,
  PackV2RelationRow,
  PackV2TargetRow,
  PackV2ValueFlow,
  ValueFlowEdge,
  ValueFlowNode,
} from '../capture-pack-v2/types';
import { headerValue } from './cdpValues';
import { responseArrivalAt, setCookiePairs, timeOf } from './workflowStatusEngine';

const TX_PATH = 'raw/http/transactions.jsonl';
const STORAGE_PATH = 'raw/browser/storage.json';
const CRYPTO_PATH = 'raw/runtime/crypto.jsonl';
const VALUE_FLOW_PATH = 'ai/value-flow.json';

/** 包含匹配的最短源值字节数（cookie 对天然带 name=value 结构，不受此限）。 */
const MIN_CONTAINED_BYTES = 8;

export interface ValueFlowWsChannelFact {
  channelId: string;
  url: string | null;
  createdAt: string;
  requestHeaders: Record<string, string>;
  /** 包内元数据路径（raw/websocket/<dirId>/metadata.json）。 */
  metadataPath: string;
}

export interface ValueFlowCookieFact {
  name: string;
  value: string;
}

export interface ValueFlowFacts {
  transactions: ReadonlyArray<PackV2HttpTransactionRow>;
  cryptoRows: ReadonlyArray<PackV2CryptoCallRow>;
  wsChannels: ReadonlyArray<ValueFlowWsChannelFact>;
  /** raw/browser/storage.json 的 cookie 快照（name/value 逐字节）。 */
  storageCookies: ReadonlyArray<ValueFlowCookieFact>;
  storageCapturedAt: string;
}

/** 逐份读正文的注入源（读一份放一份；缺失返回 null，不抛出）。 */
export interface ValueFlowBodyReader {
  readBody(ref: PackV2BodyRef): Promise<Buffer | null>;
}

/** value-flow 边的观察时间（to 节点证据时间，value-flow 关系行 occurredAt）。 */
export interface ValueFlowRelationEdge {
  from: string;
  to: string;
  occurredAt: string;
}

export interface DerivedValueFlow {
  valueFlow: PackV2ValueFlow;
  /** 与 valueFlow.edges 平行（同序）的关系行素材。 */
  relations: ValueFlowRelationEdge[];
}

interface NodeDraft {
  key: string;
  kind: ValueFlowNode['kind'];
  name: string;
  evidencePath: string;
  evidenceId?: string;
  occurredAt: string;
}

interface EdgeDraft {
  fromKey: string;
  toKey: string;
  relation: ValueFlowEdge['relation'];
  evidencePath: string;
  replaySubstitution?: boolean;
  occurredAt: string;
}

interface CookiePair {
  pair: string;
  name: string;
  value: string;
}

/** Cookie 请求头里的 name=value 对（分号分隔）。 */
function cookieHeaderPairs(value: string): CookiePair[] {
  const pairs: CookiePair[] = [];
  for (const token of value.split(';')) {
    const pair = token.trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const valuePart = pair.slice(eq + 1);
    if (!valuePart) continue;
    pairs.push({ pair, name, value: valuePart });
  }
  return pairs;
}

/**
 * 字节值的可观察编码形态：原始字节 / 小写 hex / base64（页面常把摘要编码
 * 后放进正文；编码是观察输出的确定性表示，仍是字节级背书）。
 * 源值不足 MIN_CONTAINED_BYTES 字节时不产生任何 needle。
 */
function containedVariants(bytes: Buffer): Buffer[] {
  if (bytes.byteLength < MIN_CONTAINED_BYTES) return [];
  return [
    bytes,
    Buffer.from(bytes.toString('hex'), 'utf8'),
    Buffer.from(bytes.toString('base64'), 'utf8'),
  ];
}

function containsAny(haystack: Buffer, needles: ReadonlyArray<Buffer>): boolean {
  return needles.some(needle => needle.byteLength > 0 && haystack.indexOf(needle) >= 0);
}

interface CryptoNeedle {
  nodeKey: string;
  at: number;
  variants: Buffer[];
}

export async function deriveValueFlow(
  facts: ValueFlowFacts,
  reader: ValueFlowBodyReader,
): Promise<DerivedValueFlow> {
  const readBody = (ref: PackV2BodyRef): Promise<Buffer | null> => reader.readBody(ref);
  const nodes = new Map<string, NodeDraft>();
  const edges: EdgeDraft[] = [];
  const addNode = (draft: NodeDraft): string => {
    if (!nodes.has(draft.key)) nodes.set(draft.key, draft);
    return draft.key;
  };

  // ---- cookie 签发（响应 Set-Cookie 的 name=value 对）----
  interface IssuedCookie extends CookiePair {
    txId: string;
    at: number;
    nodeKey: string;
  }
  const issued: IssuedCookie[] = [];
  for (const transaction of facts.transactions) {
    const setCookie = headerValue(transaction.responseHeaders, 'set-cookie');
    if (!setCookie) continue;
    for (const pair of setCookiePairs(setCookie)) {
      const eq = pair.indexOf('=');
      const value = pair.slice(eq + 1);
      if (!value) continue;
      // 响应的存在时刻 = 到达时刻：Set-Cookie 在响应头到达时
      // 才对页面可见，节点不得记成请求开始时已存在
      const arrivedAt = responseArrivalAt(transaction);
      const nodeKey = addNode({
        key: `set-cookie:${transaction.id}:${pair}`,
        kind: 'http-response',
        name: `${pair.slice(0, eq)}（响应 Set-Cookie）`,
        evidencePath: TX_PATH,
        evidenceId: transaction.id,
        occurredAt: new Date(arrivedAt).toISOString(),
      });
      issued.push({
        pair,
        name: pair.slice(0, eq),
        value,
        txId: transaction.id,
        at: arrivedAt,
        nodeKey,
      });
    }
  }

  // ---- storage cookie 节点 + Set-Cookie → storage 传播 ----
  const storageKeys = new Map<string, string>();
  for (const cookie of facts.storageCookies) {
    if (!cookie.name || !cookie.value) continue;
    const nodeKey = addNode({
      key: `cookie:${cookie.name}=${cookie.value}`,
      kind: 'cookie',
      name: cookie.name,
      evidencePath: STORAGE_PATH,
      occurredAt: facts.storageCapturedAt,
    });
    storageKeys.set(`${cookie.name}=${cookie.value}`, nodeKey);
  }
  for (const entry of issued) {
    const storageKey = storageKeys.get(entry.pair);
    if (!storageKey) continue;
    edges.push({
      fromKey: entry.nodeKey,
      toKey: storageKey,
      relation: 'propagated-to',
      evidencePath: STORAGE_PATH,
      occurredAt: facts.storageCapturedAt,
    });
  }

  // ---- 后续请求 / WS 握手 Cookie 头的传播目的端 ----
  const addCookieHeaderNode = (
    key: string,
    kindName: string,
    pair: CookiePair,
    evidencePath: string,
    evidenceId: string | undefined,
    occurredAt: string,
  ): string =>
    addNode({
      key,
      kind: 'header',
      name: `${pair.name}（${kindName}）`,
      evidencePath,
      ...(evidenceId ? { evidenceId } : {}),
      occurredAt,
    });
  const addPropagationEdge = (
    fromKey: string,
    toKey: string,
    evidencePath: string,
    occurredAt: string,
  ): void => {
    edges.push({
      fromKey,
      toKey,
      relation: 'propagated-to',
      evidencePath,
      replaySubstitution: true,
      occurredAt,
    });
  };

  for (const transaction of facts.transactions) {
    const cookieHeader = headerValue(transaction.requestHeaders, 'cookie');
    if (!cookieHeader) continue;
    const at = timeOf(transaction.startedAt);
    for (const pair of cookieHeaderPairs(cookieHeader)) {
      // 时间有序：携带晚于签发（同毫秒内的不同事务按事件因果序放行）
      const source = issued.find(
        entry => entry.pair === pair.pair && (at > entry.at || (at === entry.at && entry.txId !== transaction.id)),
      );
      if (!source) continue;
      const nodeKey = addCookieHeaderNode(
        `tx-header:${transaction.id}:${pair.pair}`,
        '请求 Cookie 头',
        pair,
        TX_PATH,
        transaction.id,
        transaction.startedAt,
      );
      // storage 在场走 set-cookie → storage → 头两跳；缺失退化为直连
      const storageKey = storageKeys.get(pair.pair);
      addPropagationEdge(
        storageKey ?? source.nodeKey,
        nodeKey,
        TX_PATH,
        transaction.startedAt,
      );
    }
  }

  for (const channel of facts.wsChannels) {
    const cookieHeader = headerValue(channel.requestHeaders, 'cookie');
    if (!cookieHeader) continue;
    const at = timeOf(channel.createdAt);
    for (const pair of cookieHeaderPairs(cookieHeader)) {
      const source = issued.find(entry => entry.pair === pair.pair && at >= entry.at);
      if (!source) continue;
      const nodeKey = addCookieHeaderNode(
        `ws-header:${channel.channelId}:${pair.pair}`,
        'WS 握手 Cookie 头',
        pair,
        channel.metadataPath,
        channel.channelId,
        channel.createdAt,
      );
      const storageKey = storageKeys.get(pair.pair);
      addPropagationEdge(
        storageKey ?? source.nodeKey,
        nodeKey,
        channel.metadataPath,
        channel.createdAt,
      );
    }
  }

  // ---- crypto 调用：输入 / 输出 needle（逐份读，读完即放）----
  const inputNeedles: CryptoNeedle[] = [];
  const outputNeedles: CryptoNeedle[] = [];
  for (const row of facts.cryptoRows) {
    const at = timeOf(row.occurredAt);
    const outputKey = row.outputRef
      ? addNode({
          key: `crypto-output:${row.id}`,
          kind: 'crypto-output',
          name: `${row.algorithm} 输出（${row.id}）`,
          evidencePath: CRYPTO_PATH,
          evidenceId: row.id,
          occurredAt: row.occurredAt,
        })
      : null;
    if (row.inputRef) {
      const input = await readBody(row.inputRef);
      if (input) inputNeedles.push({ nodeKey: outputKey ?? '', at, variants: containedVariants(input) });
    }
    if (row.outputRef) {
      const output = await readBody(row.outputRef);
      if (output && outputKey) outputNeedles.push({ nodeKey: outputKey, at, variants: containedVariants(output) });
    }
  }

  // ---- WS 握手查询参数节点 ----
  interface WsParam {
    channel: ValueFlowWsChannelFact;
    name: string;
    value: Buffer;
  }
  const wsParams: WsParam[] = [];
  for (const channel of facts.wsChannels) {
    if (!channel.url) continue;
    let url: URL;
    try {
      url = new URL(channel.url);
    } catch {
      continue;
    }
    for (const [name, value] of url.searchParams) {
      const valueBuffer = Buffer.from(value, 'utf8');
      if (!value || valueBuffer.byteLength < MIN_CONTAINED_BYTES) continue;
      addNode({
        key: `url-param:${channel.channelId}:${name}=${value}`,
        kind: 'url-param',
        name: `${name}（WS 握手查询参数）`,
        evidencePath: channel.metadataPath,
        evidenceId: channel.channelId,
        occurredAt: channel.createdAt,
      });
      wsParams.push({ channel, name, value: valueBuffer });
    }
  }

  // ---- 响应正文：逐份读，测试全部输入 needle 与 WS 查询参数值 ----
  for (const transaction of facts.transactions) {
    if (!transaction.responseBody) continue;
    const arrivedAt = responseArrivalAt(transaction);
    // 响应正文的存在时刻 = 到达时刻：节点与边不得记成请求
    // 开始时就已存在
    const arrivedAtIso = new Date(arrivedAt).toISOString();
    const body = await readBody(transaction.responseBody);
    if (!body) continue;
    for (const needle of inputNeedles) {
      if (!needle.nodeKey || needle.at < arrivedAt) continue;
      if (!containsAny(body, needle.variants)) continue;
      const responseKey = addNode({
        key: `response-body:${transaction.id}`,
        kind: 'http-response',
        name: `响应正文（${transaction.url}）`,
        evidencePath: TX_PATH,
        evidenceId: transaction.id,
        occurredAt: arrivedAtIso,
      });
      edges.push({
        fromKey: responseKey,
        toKey: needle.nodeKey,
        relation: 'derived-from',
        evidencePath: CRYPTO_PATH,
        replaySubstitution: true,
        occurredAt: arrivedAtIso,
      });
    }
    for (const param of wsParams) {
      if (timeOf(param.channel.createdAt) < arrivedAt) continue;
      if (body.indexOf(param.value) < 0) continue;
      const responseKey = addNode({
        key: `response-body:${transaction.id}`,
        kind: 'http-response',
        name: `响应正文（${transaction.url}）`,
        evidencePath: TX_PATH,
        evidenceId: transaction.id,
        occurredAt: arrivedAtIso,
      });
      addPropagationEdge(
        responseKey,
        `url-param:${param.channel.channelId}:${param.name}=${param.value.toString('utf8')}`,
        param.channel.metadataPath,
        param.channel.createdAt,
      );
    }
  }

  // ---- 请求正文：逐份读，测试全部 crypto 输出 needle ----
  for (const transaction of facts.transactions) {
    if (!transaction.requestBody) continue;
    const at = timeOf(transaction.startedAt);
    const body = await readBody(transaction.requestBody);
    if (!body) continue;
    for (const needle of outputNeedles) {
      if (at < needle.at) continue;
      if (!containsAny(body, needle.variants)) continue;
      const requestKey = addNode({
        key: `request-body:${transaction.id}`,
        kind: 'http-request-body',
        name: `请求正文（${transaction.method} ${transaction.url}）`,
        evidencePath: TX_PATH,
        evidenceId: transaction.id,
        occurredAt: transaction.startedAt,
      });
      edges.push({
        fromKey: needle.nodeKey,
        toKey: requestKey,
        relation: 'used-in',
        evidencePath: TX_PATH,
        replaySubstitution: true,
        occurredAt: transaction.startedAt,
      });
      edges.push({
        fromKey: requestKey,
        toKey: needle.nodeKey,
        relation: 'derived-from',
        evidencePath: TX_PATH,
        replaySubstitution: true,
        occurredAt: transaction.startedAt,
      });
    }
  }

  // ---- 只保留参与边的节点，按插入顺序分配稳定 ID ----
  const usedKeys = new Set<string>();
  for (const edge of edges) {
    usedKeys.add(edge.fromKey);
    usedKeys.add(edge.toKey);
  }
  const keyToId = new Map<string, string>();
  const outNodes: ValueFlowNode[] = [];
  let seq = 0;
  for (const [key, draft] of nodes) {
    if (!usedKeys.has(key)) continue;
    seq += 1;
    const id = `value-${String(seq).padStart(4, '0')}`;
    keyToId.set(key, id);
    outNodes.push({
      id,
      kind: draft.kind,
      name: draft.name,
      evidencePath: draft.evidencePath,
      ...(draft.evidenceId ? { evidenceId: draft.evidenceId } : {}),
    });
  }
  const idOf = (key: string): string => {
    const id = keyToId.get(key);
    if (!id) throw new Error(`value-flow 边引用了未建的节点：${key}`);
    return id;
  };
  const outEdges: ValueFlowEdge[] = edges.map(edge => ({
    from: idOf(edge.fromKey),
    to: idOf(edge.toKey),
    relation: edge.relation,
    evidencePath: edge.evidencePath,
    ...(edge.replaySubstitution !== undefined ? { replaySubstitution: edge.replaySubstitution } : {}),
  }));

  return {
    valueFlow: { schemaVersion: '2.0.0' as const, nodes: outNodes, edges: outEdges },
    relations: edges.map(edge => ({
      from: idOf(edge.fromKey),
      to: idOf(edge.toKey),
      occurredAt: edge.occurredAt,
    })),
  };
}

export interface RelationFacts {
  transactions: ReadonlyArray<PackV2HttpTransactionRow>;
  targets: ReadonlyArray<PackV2TargetRow>;
  channels: ReadonlyArray<PackV2ChannelRow>;
}

/** catalog/relations.jsonl 结构关系行：initiated / created / opened / value-flow。 */
export function deriveRelations(
  facts: RelationFacts,
  valueFlowEdges: ReadonlyArray<ValueFlowRelationEdge>,
): PackV2RelationRow[] {
  const rows: PackV2RelationRow[] = [];
  for (const transaction of facts.transactions) {
    rows.push({
      from: transaction.targetId,
      to: transaction.id,
      relation: 'initiated',
      occurredAt: transaction.startedAt,
      evidencePath: TX_PATH,
    });
  }
  for (const target of facts.targets) {
    const parent = target.openerTargetId ?? target.parentTargetId;
    if (!parent || !target.attachedAt) continue;
    rows.push({
      from: parent,
      to: target.id,
      relation: 'created',
      occurredAt: target.attachedAt,
      evidencePath: 'catalog/targets.json',
    });
  }
  for (const channel of facts.channels) {
    if (!channel.targetId) continue;
    rows.push({
      from: channel.targetId,
      to: channel.id,
      relation: 'opened',
      occurredAt: channel.createdAt,
      evidencePath: 'catalog/channels.json',
    });
  }
  for (const edge of valueFlowEdges) {
    rows.push({
      from: edge.from,
      to: edge.to,
      relation: 'value-flow',
      occurredAt: edge.occurredAt,
      evidencePath: VALUE_FLOW_PATH,
    });
  }
  return rows;
}
