import { describe, expect, it } from 'vitest';

import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2CryptoCallRow,
  PackV2HttpTransactionRow,
  PackV2RenderSurfaceRow,
  PackV2ScriptEntry,
  PackV2TargetRow,
  PackV2ValueFlow,
} from '../capture-pack-v2/types';
import { deriveAdapterDossier, type DossierEngineInput } from './dossierEngine';
import type { PackWsHandshakeFact } from '../capture-pack-v2/readPackFacts';
import { deriveWorkflowStatus, type WorkflowFacts } from './workflowStatusEngine';

/**
 * 适配候选链派生（规范 §12）：候选按时间与因果关系定位，每步引用稳定
 * 证据 ID 与真实路径；反例覆盖：无关通道 / 无关脚本不入链、cookie 未传播
 * 不构成登录步、钩子失败折扣、时序倒挂、popup 场景与空事实下限。
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

interface FactsFixture {
  facts: WorkflowFacts;
  cryptoRows: PackV2CryptoCallRow[];
  scripts: PackV2ScriptEntry[];
  valueFlow: PackV2ValueFlow;
  wsHandshakes: PackWsHandshakeFact[];
}

/** 样例场景：登录（cookie 签发+传播）→ 点击 → 启动 POST → 导航打开 Viewer
 * → Canvas 表面 → Worker → 双向 WS 通道（查询参数携带启动响应里的 token）。 */
function fullFixture(): FactsFixture {
  const loginTx = transaction('http-000002', 2, {
    method: 'POST',
    requestBody: { sha256: 'a'.repeat(64), bytes: 32, path: 'raw/http/bodies/aaa' },
    responseHeaders: { 'set-cookie': 'session=abc123; Path=/' },
  });
  const launchTx = transaction('http-000004', 4, {
    method: 'POST',
    requestBody: { sha256: 'b'.repeat(64), bytes: 32, path: 'raw/http/bodies/bbb' },
    requestHeaders: { cookie: 'session=abc123' },
  });
  const facts: WorkflowFacts = {
    transactions: [
      transaction('http-000001', 0, { resourceType: 'Document' }),
      loginTx,
      transaction('http-000003', 3, { requestHeaders: { cookie: 'session=abc123' } }),
      launchTx,
      transaction('http-000005', 5, { resourceType: 'Document' }),
      transaction('http-000006', 6, { resourceType: 'Script' }),
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
      {
        id: 'target-page-0001',
        type: 'page',
        attached: true,
        url: 'https://kvm.test/login',
        attachedAt: at(0),
      },
      {
        id: 'target-worker-0001',
        type: 'worker',
        attached: true,
        url: 'https://kvm.test/worker.js',
        parentTargetId: 'target-page-0001',
        attachedAt: at(7),
      },
    ],
    channels: [
      {
        id: 'ws-0001',
        kind: 'websocket',
        url: 'wss://kvm.test/stream?t=viewer-token-value',
        targetId: 'target-page-0001',
        createdAt: at(9),
        closedAt: at(10),
        frameCounts: { up: 2, down: 3 },
        payloadPath: 'raw/websocket/ws-0001/frames.bin',
      },
    ],
    navigations: [{ occurredAt: at(5), targetId: 'target-page-0001', url: 'https://kvm.test/viewer' }],
    renderSurfaces: [
      {
        id: 'render-0001',
        occurredAt: at(6),
        targetId: 'target-page-0001',
        surface: 'canvas-context',
        detail: '2d',
      },
    ],
    hookFailures: [],
  };
  const valueFlow: PackV2ValueFlow = {
    schemaVersion: '2.0.0',
    nodes: [
      { id: 'value-0001', kind: 'http-response', name: 'session（响应 Set-Cookie）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000002' },
      { id: 'value-0002', kind: 'cookie', name: 'session', evidencePath: 'raw/browser/storage.json' },
      { id: 'value-0003', kind: 'header', name: 'session（请求 Cookie 头）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000004' },
      { id: 'value-0004', kind: 'http-response', name: '响应正文（launch）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000004' },
      { id: 'value-0005', kind: 'url-param', name: 't（WS 握手查询参数）', evidencePath: 'raw/websocket/ws-0001/metadata.json', evidenceId: 'ws-0001' },
      { id: 'value-0006', kind: 'crypto-output', name: 'SHA-256 输出', evidencePath: 'raw/runtime/crypto.jsonl', evidenceId: 'crypto-0001' },
      { id: 'value-0007', kind: 'http-request-body', name: '请求正文（login）', evidencePath: 'raw/http/transactions.jsonl', evidenceId: 'http-000002' },
    ],
    edges: [
      { from: 'value-0001', to: 'value-0002', relation: 'propagated-to', evidencePath: 'raw/browser/storage.json' },
      { from: 'value-0002', to: 'value-0003', relation: 'propagated-to', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
      { from: 'value-0004', to: 'value-0005', relation: 'propagated-to', evidencePath: 'raw/websocket/ws-0001/metadata.json', replaySubstitution: true },
      { from: 'value-0006', to: 'value-0007', relation: 'used-in', evidencePath: 'raw/http/transactions.jsonl', replaySubstitution: true },
    ],
  };
  return {
    facts,
    cryptoRows: [
      {
        id: 'crypto-0001',
        occurredAt: at(1),
        targetId: 'target-page-0001',
        kind: 'digest',
        algorithm: 'SHA-256',
      },
    ],
    scripts: [
      { id: 'script-inline-0001', kind: 'inline', url: null, targetId: 'target-page-0001' },
      { id: 'script-net-0001', kind: 'network-script', url: 'https://kvm.test/worker.js', targetId: 'target-page-0001' },
      { id: 'script-worker-0001', kind: 'worker', url: 'https://kvm.test/worker.js', targetId: 'target-worker-0001' },
      { id: 'script-other-0001', kind: 'inline', url: null, targetId: 'target-unrelated-0001' },
    ],
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
  };
}

function derive(fixture: FactsFixture): ReturnType<typeof deriveAdapterDossier> {
  const input: DossierEngineInput = {
    facts: fixture.facts,
    cryptoRows: fixture.cryptoRows,
    scripts: fixture.scripts,
    valueFlow: fixture.valueFlow,
    wsHandshakes: fixture.wsHandshakes,
  };
  return deriveAdapterDossier(input);
}

describe('deriveAdapterDossier（适配候选链派生）', () => {
  it('正向：完整场景派生七步链，每步引用稳定 ID 与真实路径', () => {
    const result = derive(fullFixture());
    expect(result.candidateChain.map(step => step.role)).toEqual([
      'login-interaction',
      'session-established',
      'kvm-click',
      'launch-request',
      'viewer-opened',
      'script-worker-wasm',
      'realtime-channel',
    ]);
    for (const step of result.candidateChain) {
      expect(step.evidenceIds.length).toBeGreaterThan(0);
      expect(step.evidencePaths.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
    }
    const byRole = new Map(result.candidateChain.map(step => [step.role, step]));
    // 登录步：登录 POST + 喂入正文的 crypto 输出
    expect(byRole.get('login-interaction')?.evidenceIds).toEqual(['http-000002', 'crypto-0001']);
    // Session 步：签发节点与被携带的 storage cookie 节点
    expect(byRole.get('session-established')?.evidenceIds).toEqual(
      expect.arrayContaining(['http-000002', 'value-0001', 'value-0002']),
    );
    expect(byRole.get('kvm-click')?.evidenceIds).toEqual(['action-0002']);
    // 启动步：值传播背书来源（响应正文 → WS 查询参数）+ 时间窗口内血缘 POST
    expect(byRole.get('launch-request')?.evidenceIds).toEqual(['http-000004']);
    // Viewer 打开：导航 target + 文档事务 + 血缘内 Worker target
    expect(byRole.get('viewer-opened')?.evidenceIds).toEqual(
      expect.arrayContaining(['target-page-0001', 'http-000005', 'target-worker-0001']),
    );
    expect(byRole.get('viewer-opened')?.occurredAt).toBe(at(5));
    // 实时通道：通道 ID + 握手相关值节点；路径含元数据与帧索引
    expect(byRole.get('realtime-channel')?.evidenceIds).toEqual(
      expect.arrayContaining(['ws-0001', 'value-0005']),
    );
    expect(byRole.get('realtime-channel')?.evidencePaths).toEqual(
      expect.arrayContaining([
        'raw/websocket/ws-0001/metadata.json',
        'raw/websocket/ws-0001/frames.index.jsonl',
      ]),
    );
  });

  it('正向：ai/index 候选清单（登录 / 启动 / Viewer target / 脚本分类）', () => {
    const result = derive(fullFixture());
    expect(result.loginCandidateRequestIds).toEqual(['http-000002']);
    expect(result.kvmLaunchCandidateRequestIds).toEqual(['http-000004']);
    expect(result.viewerTargetIds).toEqual(
      expect.arrayContaining(['target-page-0001', 'target-worker-0001']),
    );
    // network-script 可按 URL 重取（证据在事务），不进动态脚本候选；
    // 无关 target 的脚本不进任何候选
    expect(result.dynamicScriptIds).toEqual(['script-inline-0001']);
    expect(result.workerIds).toEqual(['script-worker-0001']);
    expect(result.wasmIds).toEqual([]);
  });

  it('反例：空事实束 → 空链与空候选清单（诚实下限，不编造）', () => {
    const result = derive({
      facts: {
        transactions: [],
        actions: [],
        targets: [],
        channels: [],
        navigations: [],
        renderSurfaces: [],
        hookFailures: [],
      },
      cryptoRows: [],
      scripts: [],
      valueFlow: { schemaVersion: '2.0.0', nodes: [], edges: [] },
      wsHandshakes: [],
    });
    expect(result.candidateChain).toEqual([]);
    expect(result.loginCandidateRequestIds).toEqual([]);
    expect(result.kvmLaunchCandidateRequestIds).toEqual([]);
    expect(result.viewerTargetIds).toEqual([]);
    expect(result.dynamicScriptIds).toEqual([]);
    expect(result.workerIds).toEqual([]);
    expect(result.wasmIds).toEqual([]);
  });

  it('反例：签发的 cookie 未被任何后续请求携带 → 无登录步、无登录候选', () => {
    const fixture = fullFixture();
    for (const tx of fixture.facts.transactions) {
      tx.requestHeaders = {};
    }
    const result = derive(fixture);
    expect(result.candidateChain.map(step => step.role)).not.toContain('login-interaction');
    expect(result.candidateChain.map(step => step.role)).not.toContain('session-established');
    expect(result.loginCandidateRequestIds).toEqual([]);
    // Viewer 链与登录无关，仍在场
    expect(result.candidateChain.map(step => step.role)).toContain('realtime-channel');
  });

  it('反例：通道挂在动作血缘之外的 target → 不构成 Viewer 活动，链止于登录步', () => {
    const fixture = fullFixture();
    const channels = fixture.facts.channels as PackV2ChannelRow[];
    channels[0] = { ...channels[0], targetId: 'target-unrelated-0001' };
    const result = derive(fixture);
    const roles = result.candidateChain.map(step => step.role);
    expect(roles).toEqual(['login-interaction', 'session-established']);
    expect(result.viewerTargetIds).toEqual([]);
    expect(result.kvmLaunchCandidateRequestIds).toEqual([]);
  });

  it('反例：观察钩子失败记账溢出（*）→ 观察面不可信，无 Viewer 步', () => {
    const fixture = fullFixture();
    fixture.facts = {
      ...fixture.facts,
      hookFailures: [{ hook: '*', stage: 'install', detail: 'observer script failed' }],
    };
    const result = derive(fixture);
    const roles = result.candidateChain.map(step => step.role);
    expect(roles).not.toContain('kvm-click');
    expect(roles).not.toContain('realtime-channel');
    // 登录链只依赖 CDP 网络事实，不受页面观察钩子影响
    expect(roles).toContain('login-interaction');
  });

  it('反例：启动 POST 早于用户动作（时序倒挂）→ 不入启动候选', () => {
    const fixture = fullFixture();
    const transactions = fixture.facts.transactions as PackV2HttpTransactionRow[];
    const launch = transactions.find(tx => tx.id === 'http-000004');
    if (launch) launch.startedAt = at(1);    const result = derive(fixture);
    expect(result.candidateChain.map(step => step.role)).not.toContain('launch-request');
    expect(result.kvmLaunchCandidateRequestIds).toEqual([]);
  });

  it('popup 场景：Viewer 经 popup target 打开（无主框架导航）链仍完整', () => {
    const fixture = fullFixture();
    fixture.facts = {
      ...fixture.facts,
      navigations: [],
      targets: [
        ...fixture.facts.targets,
        {
          id: 'target-popup-0001',
          type: 'popup',
          attached: true,
          url: 'https://kvm.test/viewer',
          openerTargetId: 'target-page-0001',
          attachedAt: at(5),
        },
      ],
    };
    const result = derive(fixture);
    const opened = result.candidateChain.find(step => step.role === 'viewer-opened');
    expect(opened?.evidenceIds).toContain('target-popup-0001');
    expect(result.viewerTargetIds).toContain('target-popup-0001');
  });

  it('反例：血缘外的无关脚本不进任何候选清单', () => {
    const fixture = fullFixture();
    // target-unrelated-0001 不在动作 target 的血缘集合内
    const result = derive(fixture);
    expect(result.dynamicScriptIds).not.toContain('script-other-0001');
    expect(result.workerIds).not.toContain('script-other-0001');
    expect(result.wasmIds).not.toContain('script-other-0001');
  });

  it('WASM 脚本进 wasmIds；wasm 事务也可作启动窗口外的表面证据', () => {
    const fixture = fullFixture();
    fixture.scripts = [
      ...fixture.scripts,
      { id: 'script-wasm-0001', kind: 'wasm', url: 'https://kvm.test/decoder.wasm', targetId: 'target-page-0001' },
    ];
    const result = derive(fixture);
    expect(result.wasmIds).toEqual(['script-wasm-0001']);
    const scriptStep = result.candidateChain.find(step => step.role === 'script-worker-wasm');
    expect(scriptStep?.evidenceIds).toContain('script-wasm-0001');
  });

  it('反例（候选放宽）：纯 Token 登录（Authorization 头、无 Set-Cookie 签发）→ 有登录候选而无登录链步，workflowStatus 不升格', () => {
    const fixture = fullFixture();
    const transactions = fixture.facts.transactions as PackV2HttpTransactionRow[];
    const login = transactions.find(tx => tx.id === 'http-000002');
    if (login) {
      login.responseHeaders = {};
      login.requestHeaders = { authorization: 'Bearer token-abc123' };
    }
    for (const tx of transactions) {
      if (tx.id === 'http-000003' || tx.id === 'http-000004') {
        tx.requestHeaders = { authorization: 'Bearer token-abc123' };
      }
    }
    // 无双向通道 → 无 Viewer 活动：workflowStatus 诚实停在 TARGET_OPENED
    fixture.facts.channels[0].frameCounts = { up: 0, down: 3 };
    const result = derive(fixture);
    // 凭据头形态请求进登录候选（候选 ≠ 判定；含无正文的 GET）
    expect(result.loginCandidateRequestIds).toEqual(['http-000002', 'http-000003', 'http-000004']);
    const roles = result.candidateChain.map(step => step.role);
    expect(roles).not.toContain('login-interaction');
    expect(roles).not.toContain('session-established');
    // workflowStatus 不因候选而升格：登录链四组事实未合取
    const status = deriveWorkflowStatus(fixture.facts);
    expect(status.loginPropagation).toBe(false);
    expect(status.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例（候选放宽）：GET xhr/fetch 启动请求入启动候选，GET Other 不入', () => {
    const fixture = fullFixture();
    const transactions = fixture.facts.transactions as PackV2HttpTransactionRow[];
    const launchIndex = transactions.findIndex(tx => tx.id === 'http-000004');
    transactions[launchIndex] = {
      ...transactions[launchIndex],
      method: 'GET',
      requestBody: undefined,
      resourceType: 'XHR',
    };
    fixture.facts = {
      ...fixture.facts,
      transactions: [
        ...fixture.facts.transactions,
        transaction('http-000007', 5, { resourceType: 'Other' }),
        transaction('http-000008', 5, { resourceType: 'Fetch' }),
      ],
    };
    const result = derive(fixture);
    expect(result.kvmLaunchCandidateRequestIds).toEqual(['http-000004', 'http-000008']);
    const launchStep = result.candidateChain.find(step => step.role === 'launch-request');
    expect(launchStep?.evidenceIds).toEqual(['http-000004', 'http-000008']);
    expect(launchStep?.title).toContain('xhr-fetch GET');
  });
});
