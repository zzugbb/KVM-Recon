/**
 * workflowStatus 派生引擎反例集。
 *
 * 通用规则（规范 §6 / §7.3，不依赖厂商 URL / 页面语义）：
 * - LOGIN_REACHED：POST + 请求正文 + 2xx/3xx + 响应 Set-Cookie，且之后的
 *   请求逐字节携带该 name=value（观察到的 cookie 传播）；
 * - KVM_REACHED：用户动作之后，在同一 target 血缘内严格按“导航/popup →
 *   新渲染/执行表面 → 持续双向通道”出现事实（WS 双向帧、WebRTC 双向消息、
 *   WebTransport 存在即通道事实）；
 * - 观察脚本钩子失败 = 对应观察面不可信，派生退回保守状态，不用残缺观察
 *   断言更高状态。
 */

import { describe, expect, it } from 'vitest';

import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2HttpTransactionRow,
  PackV2RenderSurfaceRow,
  PackV2TargetRow,
} from '../capture-pack-v2/types';
import type { ObserverHookFailure } from './collectorEvidence';
import { deriveWorkflowStatus, workflowFactsSignature, type WorkflowFacts, type WorkflowNavigationFact } from './workflowStatusEngine';

const T0 = Date.parse('2026-09-21T01:00:00.000Z');

function bodyRef(): PackV2HttpTransactionRow['requestBody'] {
  return { path: 'raw/http/bodies/0001', sha256: 'a'.repeat(64), bytes: 24 };
}

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function tx(overrides: Partial<PackV2HttpTransactionRow> & { id: string }): PackV2HttpTransactionRow {
  return {
    targetId: 'target-root',
    startedAt: at(0),
    method: 'GET',
    url: 'http://bmc.test/',
    resourceType: 'other',
    requestHeaders: {},
    status: 200,
    responseHeaders: {},
    ...overrides,
  };
}

function action(overrides: Partial<PackV2BrowserActionRow> = {}): PackV2BrowserActionRow {
  return {
    id: 'action-0001',
    occurredAt: at(0),
    kind: 'click',
    targetId: 'target-root',
    elementSummary: 'button#open',
    ...overrides,
  };
}

function target(overrides: Partial<PackV2TargetRow> & { id: string }): PackV2TargetRow {
  return {
    type: 'page',
    attached: true,
    url: null,
    ...overrides,
  };
}

function channel(overrides: Partial<PackV2ChannelRow> & { id: string }): PackV2ChannelRow {
  return {
    kind: 'websocket',
    url: 'ws://bmc.test/stream',
    targetId: 'target-root',
    createdAt: at(0),
    closedAt: null,
    frameCounts: { up: 2, down: 3 },
    payloadPath: 'raw/websocket/x/frames.bin',
    ...overrides,
  };
}

function nav(overrides: Partial<WorkflowNavigationFact> = {}): WorkflowNavigationFact {
  return {
    occurredAt: at(0),
    targetId: 'target-root',
    url: 'http://bmc.test/viewer',
    ...overrides,
  };
}

function hookFailure(overrides: Partial<ObserverHookFailure> = {}): ObserverHookFailure {
  return { hook: 'crypto', stage: 'install', detail: 'subtle is not extensible', ...overrides };
}

function renderSurface(
  overrides: Partial<PackV2RenderSurfaceRow> = {},
): PackV2RenderSurfaceRow {
  return {
    id: 'render-0001',
    occurredAt: at(1500),
    targetId: 'target-root',
    surface: 'canvas-context',
    detail: '2d',
    ...overrides,
  };
}

function facts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    transactions: [],
    actions: [],
    targets: [],
    channels: [],
    navigations: [],
    renderSurfaces: [],
    hookFailures: [],
    ...overrides,
  };
}

/** 完整登录传播事实：POST 登录 → Set-Cookie → 后续请求携带 name=value。 */
function loginPropagationFacts(): WorkflowFacts {
  return facts({
    transactions: [
      tx({
        id: 'req-login',
        method: 'POST',
        url: 'http://bmc.test/api/login',
        startedAt: at(0),
        requestBody: bodyRef(),
        responseHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
      }),
      tx({
        id: 'req-next',
        startedAt: at(1000),
        requestHeaders: { cookie: 'other=1; sid=abc123' },
      }),
    ],
  });
}

/** 完整 Viewer 活动事实：点击 → 主框架导航 → 渲染表面 → WS 双向帧。 */
function viewerActivityFacts(): WorkflowFacts {
  return facts({
    actions: [action({ occurredAt: at(0) })],
    navigations: [nav({ occurredAt: at(1000) })],
    renderSurfaces: [renderSurface()],
    channels: [channel({ id: 'ws-1', createdAt: at(2000) })],
  });
}

describe('workflowStatus 派生引擎（协议无关，观察事实驱动）', () => {
  it('完整 Viewer 活动组合（动作 + 主框架导航 + WS 双向帧）→ KVM_REACHED', () => {
    expect(deriveWorkflowStatus(viewerActivityFacts())).toMatchObject({
      workflowStatus: 'KVM_REACHED',
      viewerActivity: true,
    });
  });

  it('popup target 晚于动作出现 + WebRTC 双向消息 → KVM_REACHED', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        targets: [
          target({ id: 'target-popup', type: 'popup', openerTargetId: 'target-root', attachedAt: at(1000) }),
        ],
        renderSurfaces: [renderSurface({ targetId: 'target-popup', occurredAt: at(1500) })],
        channels: [channel({ id: 'pc-1', kind: 'webrtc', createdAt: at(2000), url: null, payloadPath: null })],
      }),
    );
    expect(derived.workflowStatus).toBe('KVM_REACHED');
  });

  it('iframe/OOPIF 子 target 通过 parentTargetId 进入动作血缘 → KVM_REACHED', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        targets: [
          target({
            id: 'target-oopif',
            type: 'oopif',
            parentTargetId: 'target-root',
            attachedAt: at(800),
          }),
        ],
        navigations: [nav({ targetId: 'target-oopif', occurredAt: at(1000) })],
        renderSurfaces: [
          renderSurface({ targetId: 'target-oopif', occurredAt: at(1500) }),
        ],
        channels: [
          channel({ id: 'ws-oopif', targetId: 'target-oopif', createdAt: at(2000) }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('KVM_REACHED');
  });

  it('WebTransport 通道存在（payload 不可观察，存在即通道事实）→ KVM_REACHED', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        navigations: [nav({ occurredAt: at(1000) })],
        renderSurfaces: [renderSurface()],
        channels: [
          channel({ id: 'wt-1', kind: 'webtransport', createdAt: at(2000), url: 'https://bmc.test/wt', frameCounts: null, payloadPath: null }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('KVM_REACHED');
  });

  it('KVM 组合叠加登录传播 → 仍是 KVM_REACHED（最高状态）', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      transactions: loginPropagationFacts().transactions,
    });
    expect(derived.workflowStatus).toBe('KVM_REACHED');
    expect(derived.loginPropagation).toBe(true);
  });

  it('观察到的 Set-Cookie cookie 传播（POST + 正文 + 2xx + name=value 复用）→ LOGIN_REACHED', () => {
    expect(deriveWorkflowStatus(loginPropagationFacts())).toMatchObject({
      workflowStatus: 'LOGIN_REACHED',
      loginPropagation: true,
      viewerActivity: false,
    });
  });

  it('反例：Set-Cookie 后无请求携带该 cookie → TARGET_OPENED', () => {
    const derived = deriveWorkflowStatus(
      facts({
        transactions: [
          tx({
            id: 'req-login',
            method: 'POST',
            requestBody: bodyRef(),
            responseHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
          }),
          tx({ id: 'req-next', startedAt: at(1000), requestHeaders: { cookie: 'other=1' } }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：cookie 同名不同值（值不匹配）→ 不构成传播', () => {
    const derived = deriveWorkflowStatus(
      facts({
        transactions: [
          tx({
            id: 'req-login',
            method: 'POST',
            requestBody: bodyRef(),
            responseHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
          }),
          tx({ id: 'req-next', startedAt: at(1000), requestHeaders: { cookie: 'sid=stale' } }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：GET + Set-Cookie + 复用（缺 POST 正文）→ 不构成登录传播', () => {
    const derived = deriveWorkflowStatus(
      facts({
        transactions: [
          tx({
            id: 'req-login',
            responseHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
          }),
          tx({ id: 'req-next', startedAt: at(1000), requestHeaders: { cookie: 'sid=abc123' } }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：Set-Cookie 响应非 2xx/3xx → 不构成登录传播', () => {
    const derived = deriveWorkflowStatus(
      facts({
        transactions: [
          tx({
            id: 'req-login',
            method: 'POST',
            requestBody: bodyRef(),
            status: 500,
            responseHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
          }),
          tx({ id: 'req-next', startedAt: at(1000), requestHeaders: { cookie: 'sid=abc123' } }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  // Set-Cookie 的签发时刻是响应到达时刻（startedAt + max(receiveMs,
  // sendMs+waitMs)），不是登录请求开始时刻——响应未到达前页面不可能持有该
  // cookie，开始时刻与到达时刻之间携带 name=value 的请求不是观察到的传播。
  it('反例：请求开始晚于登录请求、但早于登录响应到达（携带 cookie）→ 不构成传播', () => {
    const derived = deriveWorkflowStatus(
      facts({
        transactions: [
          tx({
            id: 'req-login',
            method: 'POST',
            startedAt: at(0),
            requestBody: bodyRef(),
            responseHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
            timing: { sendMs: 100, waitMs: 4900, receiveMs: 5000 },
          }),
          tx({ id: 'req-next', startedAt: at(1000), requestHeaders: { cookie: 'sid=abc123' } }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
    expect(derived.loginPropagation).toBe(false);
  });

  it('响应到达之后的请求携带 name=value → LOGIN_REACHED（到达时刻判定）', () => {
    const derived = deriveWorkflowStatus(
      facts({
        transactions: [
          tx({
            id: 'req-login',
            method: 'POST',
            startedAt: at(0),
            requestBody: bodyRef(),
            responseHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
            timing: { sendMs: 100, waitMs: 4900, receiveMs: 5000 },
          }),
          tx({ id: 'req-next', startedAt: at(6000), requestHeaders: { cookie: 'sid=abc123' } }),
        ],
      }),
    );
    expect(derived.workflowStatus).toBe('LOGIN_REACHED');
  });

  it('反例：导航与通道在场但无用户动作 → TARGET_OPENED', () => {
    const derived = deriveWorkflowStatus(
      facts({
        navigations: [nav({ occurredAt: at(1000) })],
        channels: [channel({ id: 'ws-1', createdAt: at(2000) })],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：通道创建早于动作 → 不算 Viewer 活动', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(5000) })],
        navigations: [nav({ occurredAt: at(6000) })],
        channels: [channel({ id: 'ws-1', createdAt: at(0) })],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：WS 只有下行帧（非双向）→ 不算持续双向通道', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        navigations: [nav({ occurredAt: at(1000) })],
        channels: [channel({ id: 'ws-1', createdAt: at(2000), frameCounts: { up: 0, down: 5 } })],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：SSE 单向通道（上行恒 0）→ 不算持续双向通道', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        navigations: [nav({ occurredAt: at(1000) })],
        channels: [channel({ id: 'sse-1', kind: 'sse', createdAt: at(2000), url: 'http://bmc.test/sse', frameCounts: { up: 0, down: 9 }, payloadPath: null })],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：popup 出现早于动作 → 不算 Viewer 活动', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(5000) })],
        targets: [
          target({ id: 'target-popup', type: 'popup', openerTargetId: 'target-root', attachedAt: at(0) }),
        ],
        channels: [channel({ id: 'ws-1', createdAt: at(6000) })],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：导航/通道属于无关窗口（targetId 不在动作血缘集合）→ 不算 Viewer 活动（三轮 T10）', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        navigations: [nav({ targetId: 'target-other', occurredAt: at(1000) })],
        channels: [channel({ id: 'ws-1', targetId: 'target-other', createdAt: at(2000) })],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：popup opener 无关（openerTargetId 不在血缘集合）→ 其通道不算 Viewer 活动（三轮 T10）', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        targets: [
          target({ id: 'target-popup', type: 'popup', openerTargetId: 'target-unrelated', attachedAt: at(1000) }),
        ],
        channels: [channel({ id: 'ws-1', targetId: 'target-popup', createdAt: at(2000) })],
      }),
    );
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('正例：真血缘 popup 上的通道（openerTargetId=target-root）→ KVM_REACHED（血缘正控制，三轮 T10）', () => {
    const derived = deriveWorkflowStatus(
      facts({
        actions: [action({ occurredAt: at(0) })],
        targets: [
          target({ id: 'target-popup', type: 'popup', openerTargetId: 'target-root', attachedAt: at(1000) }),
        ],
        renderSurfaces: [renderSurface({ targetId: 'target-popup', occurredAt: at(1500) })],
        channels: [channel({ id: 'ws-1', targetId: 'target-popup', createdAt: at(2000) })],
      }),
    );
    expect(derived.workflowStatus).toBe('KVM_REACHED');
  });

  it('反例：登录后 Dashboard 后台告警 WS（无任何渲染/执行表面）→ 不派生 KVM_REACHED', () => {
    // §7.3 四组事实合取：点击 + 导航/打开 + **新建 Canvas/Video/Worker/WASM/持续渲染表面**
    // + 持续双向通道。登录跳转 Dashboard 后建立的后台告警 WS 满足「动作→导航→双向
    // 通道」但没有任何表面证据——不是 KVM。
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      renderSurfaces: [],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：渲染表面属无关窗口（targetId 不在血缘集合）→ 不派生 KVM_REACHED', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      renderSurfaces: [renderSurface({ targetId: 'target-other', occurredAt: at(1500) })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：渲染表面晚于动作但早于 Viewer 导航 → 不复用 Dashboard 表面', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      renderSurfaces: [renderSurface({ occurredAt: at(500) })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：双向通道晚于导航但早于新渲染表面 → 不拼接倒挂事实', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      renderSurfaces: [renderSurface({ occurredAt: at(1500) })],
      channels: [channel({ id: 'ws-1', createdAt: at(1200) })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：渲染表面早于动作（登录前就存在的 Canvas）→ 不派生 KVM_REACHED', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      renderSurfaces: [renderSurface({ occurredAt: at(-1000) })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：render-surface 钩子失败 → 页面侧表面证据不可信，不派生 KVM_REACHED', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      hookFailures: [hookFailure({ hook: 'render-surface', stage: 'install' })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('正例：render-surface 钩子失败但血缘内 WASM 事务（CDP 观察，不受页面钩子影响）→ KVM_REACHED', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      renderSurfaces: [],
      transactions: [tx({ id: 'req-wasm', resourceType: 'wasm', startedAt: at(1500) })],
      hookFailures: [hookFailure({ hook: 'render-surface', stage: 'install' })],
    });
    expect(derived.workflowStatus).toBe('KVM_REACHED');
  });

  it('反例：WASM 事务属无关窗口 → 不派生 KVM_REACHED', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      renderSurfaces: [],
      transactions: [tx({ id: 'req-wasm', resourceType: 'wasm', targetId: 'target-other', startedAt: at(1500) })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：action 钩子安装失败（动作观察面不可信）→ 不派生 KVM_REACHED', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      hookFailures: [hookFailure({ hook: 'action', stage: 'install' })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('反例：webrtc-datachannel 钩子失败 + 仅 webrtc 双向通道 → 不派生 KVM_REACHED', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      channels: [channel({ id: 'pc-1', kind: 'webrtc', createdAt: at(2000), url: null, payloadPath: null })],
      hookFailures: [hookFailure({ hook: 'webrtc-datachannel', stage: 'send-wrap' })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });

  it('钩子失败折扣只影响对应观察面：webrtc 钩子失败不折扣 WS 通道', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      hookFailures: [hookFailure({ hook: 'webrtc', stage: 'install' })],
    });
    expect(derived.workflowStatus).toBe('KVM_REACHED');
  });

  it('钩子失败记账溢出（*）→ 全部观察面按不可信处理', () => {
    const derived = deriveWorkflowStatus({
      ...viewerActivityFacts(),
      hookFailures: [hookFailure({ hook: '*', stage: 'overflow', detail: '101 more suppressed' })],
    });
    expect(derived.workflowStatus).toBe('TARGET_OPENED');
  });
});

describe('workflowFactsSignature（派生缓存签名）', () => {
  it('派生引擎读取面内的原位变更必须改变签名（缓存不得给出过期状态）', () => {
    // 事务行原位变更：status null → 200、响应头补 Set-Cookie（responseReceived
    // 在 requestWillBeSent 之后到达，行数不变）
    const before = loginPropagationFacts();
    const pending = facts({
      transactions: [
        tx({
          id: 'req-login',
          method: 'POST',
          url: 'http://bmc.test/api/login',
          startedAt: at(0),
          requestBody: bodyRef(),
          status: null,
        }),
        before.transactions[1]!,
      ],
    });
    expect(workflowFactsSignature(pending)).not.toBe(workflowFactsSignature(before));

    // 通道帧计数原位变更（up 0 → 1：双向通道事实成立，行数不变）
    const idle = viewerActivityFacts();
    const idleChannel = idle.channels[0]!;
    expect(workflowFactsSignature(idle)).not.toBe(
      workflowFactsSignature({ ...idle, channels: [{ ...idleChannel, frameCounts: { up: 1, down: 3 } }] }),
    );

    // target attachedAt 补齐（挂载完成，行数不变）
    const unattached = facts({ targets: [target({ id: 't-1', attached: false, attachedAt: undefined })] });
    expect(workflowFactsSignature(unattached)).not.toBe(
      workflowFactsSignature(facts({ targets: [target({ id: 't-1', attached: true, attachedAt: at(500) })] })),
    );

    // 血缘投影原位变更（targetId 归属变化可翻转派生结果，行数不变）
    const lineage = viewerActivityFacts();
    expect(workflowFactsSignature(lineage)).not.toBe(
      workflowFactsSignature({ ...lineage, actions: [{ ...lineage.actions[0]!, targetId: 'target-other' }] }),
    );
    expect(workflowFactsSignature(lineage)).not.toBe(
      workflowFactsSignature({ ...lineage, navigations: [{ ...lineage.navigations[0]!, targetId: 'target-other' }] }),
    );
    expect(workflowFactsSignature(lineage)).not.toBe(
      workflowFactsSignature({ ...lineage, channels: [{ ...lineage.channels[0]!, targetId: 'target-other' }] }),
    );
    const lineageWithTarget = {
      ...lineage,
      targets: [target({ id: 'target-popup', type: 'popup', openerTargetId: 'target-root', attachedAt: at(1000) })],
    };
    expect(workflowFactsSignature(lineageWithTarget)).not.toBe(
      workflowFactsSignature({
        ...lineageWithTarget,
        targets: [target({ id: 'target-popup', type: 'popup', openerTargetId: 'target-unrelated', attachedAt: at(1000) })],
      }),
    );

    // 渲染表面投影（targetId 归属 / 时刻可翻转派生结果，行数不变）
    const surfaced = viewerActivityFacts();
    expect(workflowFactsSignature(surfaced)).not.toBe(
      workflowFactsSignature({ ...surfaced, renderSurfaces: [{ ...surfaced.renderSurfaces[0]!, targetId: 'target-other' }] }),
    );
    expect(workflowFactsSignature(surfaced)).not.toBe(
      workflowFactsSignature({ ...surfaced, renderSurfaces: [{ ...surfaced.renderSurfaces[0]!, occurredAt: at(-1000) }] }),
    );
    // WASM 表面证据读取面（resourceType / targetId 归属可翻转派生结果）
    const wasmBase = facts({
      ...viewerActivityFacts(),
      renderSurfaces: [],
      transactions: [tx({ id: 'req-wasm', resourceType: 'wasm', startedAt: at(1500) })],
    });
    expect(workflowFactsSignature(wasmBase)).not.toBe(
      workflowFactsSignature({
        ...wasmBase,
        transactions: [tx({ id: 'req-wasm', resourceType: 'wasm', targetId: 'target-other', startedAt: at(1500) })],
      }),
    );
    expect(workflowFactsSignature(wasmBase)).not.toBe(
      workflowFactsSignature({
        ...wasmBase,
        transactions: [tx({ id: 'req-wasm', resourceType: 'script', startedAt: at(1500) })],
      }),
    );
  });

  it('派生无关字段不变签名；追加型事实（动作/导航/钩子失败）追加即变签名', () => {
    const base = viewerActivityFacts();
    // 派生引擎不读 elementSummary / closedAt / url 细节（通道 url 不参与派生）
    expect(workflowFactsSignature(base)).toBe(
      workflowFactsSignature({
        ...base,
        actions: [{ ...base.actions[0]!, elementSummary: '另一个摘要' }],
        channels: [{ ...base.channels[0]!, url: 'ws://other.test/x', closedAt: at(9999) }],
      }),
    );

    // 追加动作 / 导航 / 钩子失败 → 签名变化
    expect(workflowFactsSignature(base)).not.toBe(
      workflowFactsSignature({ ...base, actions: [...base.actions, action({ id: 'action-0002' })] }),
    );
    expect(workflowFactsSignature(base)).not.toBe(
      workflowFactsSignature({ ...base, navigations: [...base.navigations, nav()] }),
    );
    expect(workflowFactsSignature(base)).not.toBe(
      workflowFactsSignature({ ...base, hookFailures: [hookFailure()] }),
    );
  });

  it('结构相同的两次快照签名一致（缓存命中路径）', () => {
    expect(workflowFactsSignature(loginPropagationFacts())).toBe(workflowFactsSignature(loginPropagationFacts()));
    expect(workflowFactsSignature(viewerActivityFacts())).toBe(workflowFactsSignature(viewerActivityFacts()));
  });
});
