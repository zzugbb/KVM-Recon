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
 * 值传播图为空、WS 帧索引缺失。
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
    ],
    edges: [
      { from: 'value-0001', to: 'value-0002', relation: 'propagated-to', evidencePath: 'raw/browser/storage.json' },
      { from: 'value-0002', to: 'value-0003', relation: 'propagated-to', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
      { from: 'value-0004', to: 'value-0005', relation: 'propagated-to', evidencePath: 'raw/websocket/ws-0001/metadata.json', replaySubstitution: true },
      { from: 'value-0006', to: 'value-0007', relation: 'used-in', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
      // used-in 的结构反向边（valueFlowEngine 请求正文循环会成对写出）：
      // 请求正文是回放模板，不是需要替换的动态值，不得进 requiresDynamicValueIds
      { from: 'value-0007', to: 'value-0006', relation: 'derived-from', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
      { from: 'value-0008', to: 'value-0006', relation: 'derived-from', evidencePath: 'raw/runtime/crypto.jsonl', replaySubstitution: true },
    ],
  };
}

function plan(facts: WorkflowFacts, valueFlow: PackV2ValueFlow) {
  const dossier = deriveAdapterDossier({
    facts,
    cryptoRows: [],
    scripts: [],
    valueFlow,
    wsHandshakes: [
      {
        channelId: 'ws-0001',
        url: 'wss://kvm.test/stream?t=viewer-token-value',
        createdAt: at(9),
        requestHeaders: { cookie: 'session=abc123' },
        metadataPath: 'raw/websocket/ws-0001/metadata.json',
        framesIndexPath: 'raw/websocket/ws-0001/frames.index.jsonl',
      },
    ],
  });
  return {
    dossier,
    replay: deriveReplayPlan({
      facts,
      dossier,
      valueFlow,
      wsHandshakes: [
        {
          channelId: 'ws-0001',
          url: 'wss://kvm.test/stream?t=viewer-token-value',
          createdAt: at(9),
          requestHeaders: { cookie: 'session=abc123' },
          metadataPath: 'raw/websocket/ws-0001/metadata.json',
          framesIndexPath: 'raw/websocket/ws-0001/frames.index.jsonl',
        },
      ],
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
        requiresDynamicValueIds: ['value-0004'],
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
      '未定位到启动请求：动作后在血缘集合内没有带正文的 POST 请求，也没有值传播背书的通道来源请求',
      '未观察到 Viewer 实时通道：动作 → 打开 → 渲染表面 → 双向通道四组事实未合取（规范 §7.3）',
    ]);
    expect(replay.manifest.channels).toEqual([]);
    // 登录链不受影响：登录请求仍在计划里
    expect(replay.manifest.requests.map(request => request.requestId)).toEqual(['http-000002']);
  });

  it('反例：值传播图为空 → 动态值清单为空（静态回放），不编造替换需求', () => {
    const { replay } = plan(
      baseFacts(),
      { schemaVersion: '2.0.0', nodes: [], edges: [] },
    );
    expect(replay.manifest.replayable).toBe(true);
    for (const request of replay.manifest.requests) {
      expect(request.requiresDynamicValueIds).toEqual([]);
    }
    expect(replay.manifest.channels[0].requiresDynamicValueIds).toEqual([]);
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
  });
});
