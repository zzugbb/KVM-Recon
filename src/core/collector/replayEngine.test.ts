import { describe, expect, it } from 'vitest';

import type {
  PackV2HttpTransactionRow,
  PackV2ValueFlow,
} from '../capture-pack-v2/types';
import { deriveAdapterDossier } from './dossierEngine';
import { deriveReplayPlan } from './replayEngine';
import type { WorkflowFacts } from './workflowStatusEngine';

/**
 * Replay 计划派生（规范 §16）：登录 / 启动候选请求 + Viewer 通道 +
 * requiresDynamicValueIds（值传播图 replaySubstitution 来源端）；
 * replayable=false 时缺失证据逐条显式。反例：无会话传播、无双向通道、
 * 静态站点空图、凭证值传播链断裂、WS 帧索引缺失。
 */

const T0 = '2026-09-21T10:00:00.000Z';
function at(seconds: number): string {
  return new Date(new Date(T0).getTime() + seconds * 1000).toISOString();
}

function transaction(
  id: string,
  seconds: number,
  overrides: Partial<PackV2HttpTransactionRow> = {},
): PackV2HttpTransactionRow {
  return {
    id,
    targetId: 'target-page-0001',
    startedAt: at(seconds),
    method: 'GET',
    url: `https://kvm.test/${id}`,
    resourceType: 'Other',
    requestHeaders: {},
    status: 200,
    responseHeaders: {},
    ...overrides,
  };
}

function baseFacts(): WorkflowFacts {
  return {
    transactions: [
      transaction('http-000001', 0, { resourceType: 'Document' }),
      transaction('http-000002', 2, {
        method: 'POST',
        requestBody: { sha256: 'a'.repeat(64), bytes: 32, path: 'raw/http/bodies/aaa' },
        responseBody: { sha256: 'c'.repeat(64), bytes: 8, path: 'raw/http/bodies/ccc' },
        responseHeaders: { 'set-cookie': 'session=abc123; Path=/' },
      }),
      transaction('http-000003', 3, { requestHeaders: { cookie: 'session=abc123' } }),
      transaction('http-000004', 4, {
        method: 'POST',
        requestBody: { sha256: 'b'.repeat(64), bytes: 32, path: 'raw/http/bodies/bbb' },
        requestHeaders: { cookie: 'session=abc123' },
      }),
      transaction('http-000005', 5, { resourceType: 'Document' }),
    ],
    actions: [
      {
        id: 'action-0002',
        occurredAt: at(4),
        kind: 'click',
        targetId: 'target-page-0001',
        elementSummary: '#console-open',
      },
    ],
    targets: [
      { id: 'target-page-0001', type: 'page', attached: true, url: 'https://kvm.test/login', attachedAt: at(0) },
    ],
    channels: [
      {
        id: 'ws-0001',
        kind: 'websocket',
        url: 'wss://kvm.test/stream?t=viewer-token-value',
        targetId: 'target-page-0001',
        createdAt: at(9),
        closedAt: null,
        frameCounts: { up: 2, down: 3 },
        payloadPath: 'raw/websocket/ws-0001/frames.bin',
      },
    ],
    navigations: [{ occurredAt: at(5), targetId: 'target-page-0001', url: 'https://kvm.test/viewer' }],
    renderSurfaces: [
      { id: 'render-0001', occurredAt: at(6), targetId: 'target-page-0001', surface: 'canvas-context', detail: '2d' },
    ],
    hookFailures: [],
  };
}

function baseValueFlow(): PackV2ValueFlow {
  return {
    schemaVersion: '2.0.0',
    nodes: [
      { id: 'value-0001', kind: 'http-response', name: 'session（响应 Set-Cookie）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000002' },
      { id: 'value-0002', kind: 'cookie', name: 'session', evidencePath: 'raw/browser/storage.json' },
      { id: 'value-0003', kind: 'header', name: 'session（请求 Cookie 头）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000004' },
      { id: 'value-0004', kind: 'http-response', name: '响应正文（launch）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000004' },
      { id: 'value-0005', kind: 'url-param', name: 't（WS 握手查询参数）', evidencePath: 'raw/websocket/ws-0001/metadata.json', evidenceId: 'ws-0001' },
      { id: 'value-0006', kind: 'crypto-output', name: 'SHA-256 输出', evidencePath: 'raw/runtime/crypto.jsonl', evidenceId: 'crypto-0001' },
      { id: 'value-0007', kind: 'http-request-body', name: '请求正文（login）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000002' },
      { id: 'value-0008', kind: 'http-response', name: '登录挑战 nonce', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000001' },
      // WS 握手 Cookie 头：真实引擎会对携带签发对的握手生成 header 节点
      // （valueFlowEngine「WS 握手 Cookie 头的传播目的端」），闭环检查沿此边回溯
      { id: 'value-0009', kind: 'header', name: 'session（WS 握手 Cookie 头）', evidencePath: 'raw/websocket/ws-0001/metadata.json', evidenceId: 'ws-0001' },
    ],
    edges: [
      { from: 'value-0001', to: 'value-0002', relation: 'propagated-to', evidencePath: 'raw/browser/storage.json' },
      { from: 'value-0002', to: 'value-0003', relation: 'propagated-to', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
      { from: 'value-0004', to: 'value-0005', relation: 'propagated-to', evidencePath: 'raw/websocket/ws-0001/metadata.json', replaySubstitution: true },
      { from: 'value-0002', to: 'value-0009', relation: 'propagated-to', evidencePath: 'raw/websocket/ws-0001/metadata.json', replaySubstitution: true },
      { from: 'value-0006', to: 'value-0007', relation: 'used-in', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
      // used-in 的结构反向边（valueFlowEngine 请求正文循环会成对写出）：
      // 请求正文是回放模板，不是需要替换的动态值，不得进 requiresDynamicValueIds
      { from: 'value-0007', to: 'value-0006', relation: 'derived-from', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
      { from: 'value-0008', to: 'value-0006', relation: 'derived-from', evidencePath: 'raw/runtime/crypto.jsonl', replaySubstitution: true },
    ],
  };
}

/** 凭证链断裂的传播图：去掉 cookie 签发 / storage / 请求与握手 Cookie 头
 * 节点及全部关联边，保留启动响应 → WS 查询参数与 crypto 边。 */
function brokenChainValueFlow(): PackV2ValueFlow {
  const full = baseValueFlow();
  const cut = new Set(['value-0001', 'value-0002', 'value-0003', 'value-0009']);
  return {
    schemaVersion: full.schemaVersion,
    nodes: full.nodes.filter(node => !cut.has(node.id)),
    edges: full.edges.filter(edge => !cut.has(edge.from) && !cut.has(edge.to)),
  };
}

function plan(
  facts: WorkflowFacts,
  valueFlow: PackV2ValueFlow,
  handshakeRequestHeaders: Record<string, string> = { cookie: 'session=abc123' },
  handshakeUrl = 'wss://kvm.test/stream?t=viewer-token-value',
) {
  const wsHandshakes = [
    {
      channelId: 'ws-0001',
      url: handshakeUrl,
      createdAt: at(9),
      requestHeaders: handshakeRequestHeaders,
      metadataPath: 'raw/websocket/ws-0001/metadata.json',
      framesIndexPath: 'raw/websocket/ws-0001/frames.index.jsonl',
    },
  ];
  const dossier = deriveAdapterDossier({
    facts,
    cryptoRows: [],
    scripts: [],
    valueFlow,
    wsHandshakes,
  });
  return {
    dossier,
    replay: deriveReplayPlan({
      facts,
      dossier,
      valueFlow,
      wsHandshakes,
    }),
  };
}

describe('deriveReplayPlan（Replay 计划派生）', () => {
  it('正向：完整场景 replayable=true，请求与通道的动态值可替换', () => {
    const { replay } = plan(baseFacts(), baseValueFlow());
    expect(replay.manifest.replayable).toBe(true);
    expect(replay.manifest.clockPolicy).toBe('deterministic-accelerated');
    expect(replay.manifest.notReplayableReasons).toBeUndefined();

    expect(replay.manifest.requests.map(request => request.requestId)).toEqual(['http-000002', 'http-000004']);
    const login = replay.manifest.requests[0];
    // 登录请求动态值：喂入正文的 crypto 输出 + 摘要输入来源（nonce）
    expect(login.requiresDynamicValueIds).toEqual(['value-0006', 'value-0008']);
    const launch = replay.manifest.requests[1];
    // 启动请求动态值：请求 Cookie 头的来源 cookie 节点
    expect(launch.requiresDynamicValueIds).toEqual(['value-0002']);

    // http.jsonl 行：正文路径与事务 BodyRef 一致（一致性门禁比对源）
    expect(replay.httpRows).toEqual([
      {
        requestId: 'http-000002',
        url: 'https://kvm.test/http-000002',
        method: 'POST',
        requestBodyPath: 'raw/http/bodies/aaa',
        responseBodyPath: 'raw/http/bodies/ccc',
        occurredAt: at(2),
      },
      {
        requestId: 'http-000004',
        url: 'https://kvm.test/http-000004',
        method: 'POST',
        requestBodyPath: 'raw/http/bodies/bbb',
        responseBodyPath: null,
        occurredAt: at(4),
      },
    ]);

    expect(replay.manifest.channels).toEqual([
      {
        channelId: 'ws-0001',
        kind: 'websocket',
        framesIndexPath: 'raw/websocket/ws-0001/frames.index.jsonl',
        // 通道动态值：启动响应（url-param 来源）+ 握手 Cookie 头的来源 cookie 节点
        requiresDynamicValueIds: ['value-0004', 'value-0002'],
      },
    ]);
    expect(replay.channelsFile.channels).toEqual(replay.manifest.channels);
  });

  it('反例：签发 cookie 未被携带 → replayable=false + 会话传播缺失说明', () => {
    const facts = baseFacts();
    for (const tx of facts.transactions) tx.requestHeaders = {};
    const { replay } = plan(facts, baseValueFlow());
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.clockPolicy).toBe('realtime');
    expect(replay.manifest.notReplayableReasons).toEqual([
      '未观察到会话传播：签发的 Set-Cookie 未被任何后续请求逐字节携带（登录链四组事实未合取）',
    ]);
    // 登录请求不进 replay 计划
    expect(replay.manifest.requests.map(request => request.requestId)).toEqual(['http-000004']);
  });

  it('反例：没有任何 Set-Cookie 签发 → 登录交互缺失说明', () => {
    const facts = baseFacts();
    for (const tx of facts.transactions) tx.responseHeaders = {};
    const { replay } = plan(facts, baseValueFlow());
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.notReplayableReasons?.[0]).toContain('未观察到登录交互');
  });

  it('反例：通道单向（帧计数为 0）→ 启动与实时通道缺失说明逐条列出', () => {
    const facts = baseFacts();
    facts.channels[0].frameCounts = { up: 0, down: 3 };
    const { replay } = plan(facts, baseValueFlow());
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.clockPolicy).toBe('realtime');
    expect(replay.manifest.notReplayableReasons).toEqual([
      '未定位到启动请求：动作后在血缘时间窗内没有带正文的 POST / xhr-fetch GET 请求，也没有值传播背书的通道来源请求',
      '未观察到 Viewer 实时通道：动作 → 打开 → 渲染表面 → 双向通道四组事实未合取（规范 §7.3）',
    ]);
    expect(replay.manifest.channels).toEqual([]);
    // 登录链不受影响：登录请求仍在计划里
    expect(replay.manifest.requests.map(request => request.requestId)).toEqual(['http-000002']);
  });

  it('反例：静态站点（无凭证头）值传播图为空 → 动态值清单为空，不编造替换需求', () => {
    // 启动请求与 WS 握手均无动态凭据/查询参数，录制值可以原样发送。
    const facts = baseFacts();
    facts.transactions[3].requestHeaders = {};
    facts.channels[0].url = 'wss://kvm.test/stream';
    const { replay } = plan(facts, { schemaVersion: '2.0.0', nodes: [], edges: [] }, {}, 'wss://kvm.test/stream');
    expect(replay.manifest.replayable).toBe(true);
    expect(replay.manifest.requests.map(request => request.requestId)).toEqual(['http-000002', 'http-000004']);
    for (const request of replay.manifest.requests) {
      expect(request.requiresDynamicValueIds).toEqual([]);
    }
    expect(replay.manifest.channels[0].requiresDynamicValueIds).toEqual([]);
  });

  it('反例：WS token 查询参数无传播来源，不能宣称通道可回放', () => {
    const flow = baseValueFlow();
    flow.edges = flow.edges.filter(edge => edge.to !== 'value-0005');
    const { replay } = plan(baseFacts(), flow);
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.notReplayableReasons?.some(reason => reason.includes('WS 查询参数缺少值传播来源（t）'))).toBe(true);
  });

  it('反例：候选齐全 + 请求与握手携带 Cookie + 值传播链断裂 → replayable=false + 逐条断裂说明', () => {
    const { replay } = plan(baseFacts(), brokenChainValueFlow());
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.clockPolicy).toBe('realtime');
    expect(replay.manifest.notReplayableReasons).toEqual([
      '回放请求 http-000004（POST https://kvm.test/http-000004）携带会话凭证但值传播链断裂：无法替换为新鲜会话值，重放将携带过期凭证',
      '回放通道 ws-0001 握手携带会话凭证但值传播链断裂：无法替换为新鲜会话值，重放将携带过期凭证',
    ]);
    // 断裂不驱逐候选：请求与通道仍在回放清单里（缺失以说明表达，不是删行）
    expect(replay.manifest.requests.map(request => request.requestId)).toEqual(['http-000002', 'http-000004']);
    // 未断裂的通道 url-param 来源仍进 requires（启动响应 → 查询参数边保留）
    expect(replay.manifest.channels[0].requiresDynamicValueIds).toEqual(['value-0004']);
    // 启动请求的 Cookie 头无来源可替换 → 动态值清单为空
    expect(replay.manifest.requests[1].requiresDynamicValueIds).toEqual([]);
  });

  it('反例：只有无关 CSRF 头有传播边，不能替代会话 Cookie 的来源', () => {
    const flow = baseValueFlow();
    flow.edges = flow.edges.filter(edge => edge.to !== 'value-0003');
    flow.nodes.push({ id: 'value-0010', kind: 'header', name: 'csrf（请求头）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000004' });
    flow.edges.push({ from: 'value-0002', to: 'value-0010', relation: 'propagated-to', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true });
    const { replay } = plan(baseFacts(), flow);
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.notReplayableReasons?.some(reason => reason.includes('回放请求 http-000004'))).toBe(true);
  });

  it('纯 Token 登录（Authorization 头、无 Set-Cookie）→ 保留候选但不把旧 Bearer token 误判为可回放', () => {
    const facts = baseFacts();
    facts.transactions[1].responseHeaders = {};
    facts.transactions[1].requestHeaders = { authorization: 'Bearer token-abc123' };
    facts.transactions[2].requestHeaders = { authorization: 'Bearer token-abc123' };
    facts.transactions[3].requestHeaders = { authorization: 'Bearer token-abc123' };
    // 无签发来源时仍保留候选，但不能把录制时的 Bearer 值原样重放。
    const { replay } = plan(facts, { schemaVersion: '2.0.0', nodes: [], edges: [] }, {});
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.notReplayableReasons?.some(reason => reason.includes('会话凭证但值传播链断裂'))).toBe(true);
    // 凭据头形态请求全部进登录候选（含无正文的 GET）
    expect(replay.manifest.requests.map(request => request.requestId)).toEqual([
      'http-000002',
      'http-000003',
      'http-000004',
    ]);
  });

  it('WS 帧索引缺失 → framesIndexPath=null（不编造路径）', () => {
    const facts = baseFacts();
    const dossier = deriveAdapterDossier({
      facts,
      cryptoRows: [],
      scripts: [],
      valueFlow: baseValueFlow(),
      wsHandshakes: [],
    });
    const replay = deriveReplayPlan({
      facts,
      dossier,
      valueFlow: baseValueFlow(),
      wsHandshakes: [],
    });
    expect(replay.manifest.channels[0].framesIndexPath).toBeNull();
    expect(replay.manifest.replayable).toBe(false);
    expect(replay.manifest.notReplayableReasons?.some(reason => reason.includes('缺少 WS 握手或帧索引'))).toBe(true);
  });
});
