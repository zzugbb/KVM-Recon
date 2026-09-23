/**
 * workflowStatus 派生引擎（规范 §6 / §7.3，阶段 3 第 1 刀）。
 *
 * 从观察事实（HTTP 事务 / 用户动作 / target 血缘 / 通道行 / 主框架导航 /
 * 观察脚本钩子失败记账）派生 WorkflowStatus，协议无关、不依赖厂商 URL
 * 与页面语义：
 * - LOGIN_REACHED：POST + 请求正文 + 2xx/3xx 响应 Set-Cookie（签发时刻 =
 *   响应到达时刻，非请求开始时刻），且之后的请求逐字节携带该 name=value
 *   （观察到的 cookie 传播，不猜登录语义）；
 * - KVM_REACHED：用户动作（click / form-submit）之后，在动作 target 的
 *   血缘集合（自身 + 经 openerTargetId / parentTargetId 链关联的后代）内，
 *   严格按“打开或导航 → 新渲染/执行表面 → 持续双向通道”的顺序出现事实。
 *   WS 双向帧 >0、WebRTC 双向消息 >0，或 WebTransport 通道在场（payload
 *   不可观察，存在即通道事实）；SSE / 下载为单向通道，单独不构成；
 * - 否则 TARGET_OPENED。
 *
 * 钩子失败折扣：观察脚本某钩子安装失败时，对应观察面的事实不可信，
 * 派生退回保守状态，不用残缺观察断言更高状态。
 * 纯函数：只读事实、无副作用；时间戳不可解析时按 0 处理（保守可排序）。
 */

import type {
  PackV2BrowserActionRow,
  PackV2ChannelRow,
  PackV2HttpTransactionRow,
  PackV2RenderSurfaceRow,
  PackV2TargetRow,
  WorkflowStatus,
} from '../capture-pack-v2/types';
import type { ObserverHookFailure } from './collectorEvidence';

/** 主框架导航事实（Page.frameNavigated 无 parentId 的帧，attach 层记账）。 */
export interface WorkflowNavigationFact {
  occurredAt: string;
  targetId: string;
  url: string | null;
}

/** 派生引擎的只读事实快照（stop 前 collector 内存态；阶段 3 Viewer 识别共用）。 */
export interface WorkflowFacts {
  transactions: ReadonlyArray<PackV2HttpTransactionRow>;
  actions: ReadonlyArray<PackV2BrowserActionRow>;
  targets: ReadonlyArray<PackV2TargetRow>;
  channels: ReadonlyArray<PackV2ChannelRow>;
  navigations: ReadonlyArray<WorkflowNavigationFact>;
  /** 新建渲染/执行表面行（§7.3 第 2 组事实，五轮 G1）。 */
  renderSurfaces: ReadonlyArray<PackV2RenderSurfaceRow>;
  hookFailures: ReadonlyArray<ObserverHookFailure>;
}

export interface DerivedWorkflowStatus {
  workflowStatus: WorkflowStatus;
  /** LOGIN_REACHED 依据：观察到的 Set-Cookie cookie 传播。 */
  loginPropagation: boolean;
  /** KVM_REACHED 依据：§7.3 通用 Viewer 活动组合。 */
  viewerActivity: boolean;
}

export function timeOf(iso: string | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 响应到达时间的近似（第五轮 G4；与 valueFlowEngine 同一实现语义）：
 * receiveMs 是 requestTime→receiveHeadersEnd 的累计偏移（CDP 语义），
 * startedAt + receiveMs 覆盖建连段，是响应头到达墙钟的轻微高估；
 * sendMs+waitMs 漏掉建连段。取两者较大值作为到达时间——拒绝边的保守
 * 方向（宁可晚判到达，不早判）。timing 缺失（CDP 未提供）时退回请求
 * 开始时间（诚实下限）。Set-Cookie 签发、响应正文的存在时刻都以到达
 * 时刻计：响应未到达前页面不可能持有该 cookie 或读到该正文。
 */
export function responseArrivalAt(transaction: PackV2HttpTransactionRow): number {
  const timing = transaction.timing;
  if (!timing) return timeOf(transaction.startedAt);
  const toHeaders = Math.max(
    timing.receiveMs || 0,
    (timing.sendMs || 0) + (timing.waitMs || 0),
  );
  return timeOf(transaction.startedAt) + toHeaders;
}

function headerOf(headers: Readonly<Record<string, string>>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return null;
}

/**
 * Set-Cookie 的 name=value 对（去掉 Path 等属性段）。
 * Chromium 在 CDP headers 对象里用 \n 合并重复 Set-Cookie 头，逐条拆开。
 */
export function setCookiePairs(value: string): string[] {
  return value
    .split('\n')
    .map(cookie => cookie.split(';')[0].trim())
    .filter(pair => {
      const eq = pair.indexOf('=');
      return eq > 0;
    });
}

function deriveLoginReached(facts: WorkflowFacts): boolean {
  const issued: Array<{ at: number; transactionId: string; pair: string }> = [];
  for (const transaction of facts.transactions) {
    if (transaction.method.toUpperCase() !== 'POST') continue;
    if (!transaction.requestBody) continue;
    if (transaction.status === null || transaction.status < 200 || transaction.status >= 400) continue;
    const setCookie = headerOf(transaction.responseHeaders, 'set-cookie');
    if (!setCookie) continue;
    for (const pair of setCookiePairs(setCookie)) {
      // 签发时刻 = 响应到达时刻（第五轮 G4）：请求开始晚于登录请求、但
      // 早于登录响应到达的请求不可能持有该 cookie，不构成传播证据
      issued.push({ at: responseArrivalAt(transaction), transactionId: transaction.id, pair });
    }
  }
  if (issued.length === 0) return false;
  for (const transaction of facts.transactions) {
    const cookieHeader = headerOf(transaction.requestHeaders, 'cookie');
    if (!cookieHeader) continue;
    const at = timeOf(transaction.startedAt);
    for (const token of cookieHeader.split(';')) {
      const pair = token.trim();
      if (!pair) continue;
      // 之后 = 严格更晚，或同毫秒内的不同事务（CDP 事件因果序先于时间戳精度）
      if (
        issued.some(
          entry =>
            entry.pair === pair &&
            (at > entry.at || (at === entry.at && entry.transactionId !== transaction.id)),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function isBidirectionalChannel(
  channel: PackV2ChannelRow,
  brokenHooks: ReadonlySet<string>,
): boolean {
  if (channel.kind === 'websocket') {
    // WS 走 CDP Network 域观察，不受页面观察脚本钩子影响
    return !!channel.frameCounts && channel.frameCounts.up > 0 && channel.frameCounts.down > 0;
  }
  if (channel.kind === 'webrtc') {
    if (brokenHooks.has('webrtc') || brokenHooks.has('webrtc-datachannel')) return false;
    return !!channel.frameCounts && channel.frameCounts.up > 0 && channel.frameCounts.down > 0;
  }
  if (channel.kind === 'webtransport') {
    if (brokenHooks.has('webtransport')) return false;
    // 入站流读取即消费（规范 §8.5）：payload 不可观察，通道在场即事实
    return true;
  }
  return false;
}

/**
 * 动作 target 的 Viewer 血缘集合（第 12 轮阻断 1）：自身 + 由它经
 * openerTargetId 链打开的 popup 后代，以及 parentTargetId 链挂载的
 * iframe/OOPIF/Worker 后代。另一棵血缘子树 / 无血缘窗口的导航与通道
 * 不在集合内，不构成信号（宁可漏不可错）。
 * detectViewerActivity（viewerActivity.ts）与 deriveViewerActivity 共用。
 */
export function viewerLineageOf(
  actionTargetId: string,
  targets: ReadonlyArray<PackV2TargetRow>,
): Set<string> {
  const lineage = new Set<string>([actionTargetId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const target of targets) {
      if (lineage.has(target.id)) continue;
      const parent =
        target.type === 'popup' ? target.openerTargetId : target.parentTargetId;
      if (!parent) continue;
      if (lineage.has(parent)) {
        lineage.add(target.id);
        grew = true;
      }
    }
  }
  return lineage;
}

/**
 * §7.3 第 2 组事实（五轮 G1）：动作后在动作 target 血缘集合内新建的
 * Canvas / Video / OffscreenCanvas / Worker / 持续渲染表面（页面观察脚本
 * 上报，钩子失败时该观察面不可信），或 WASM 事务（CDP Network 域观察，
 * 不受页面钩子影响）。登录跳转 Dashboard 后的后台告警 WS 没有任何表面
 * 证据，不构成 KVM。
 */
function earliestRenderSurfaceAt(
  facts: WorkflowFacts,
  lineage: ReadonlySet<string>,
  at: number,
  brokenHooks: ReadonlySet<string>,
): number | null {
  let earliest = Number.POSITIVE_INFINITY;
  if (!brokenHooks.has('render-surface')) {
    for (const surface of facts.renderSurfaces) {
      if (!surface.targetId || !lineage.has(surface.targetId)) continue;
      const occurredAt = timeOf(surface.occurredAt);
      if (occurredAt >= at && occurredAt < earliest) earliest = occurredAt;
    }
  }
  for (const transaction of facts.transactions) {
    if (transaction.resourceType !== 'wasm') continue;
    if (!transaction.targetId || !lineage.has(transaction.targetId)) continue;
    const occurredAt = timeOf(transaction.startedAt);
    if (occurredAt >= at && occurredAt < earliest) earliest = occurredAt;
  }
  return Number.isFinite(earliest) ? earliest : null;
}

function deriveViewerActivity(facts: WorkflowFacts): boolean {
  const brokenHooks = new Set(facts.hookFailures.map(failure => failure.hook));
  // 钩子失败记账溢出（*）：观察面整体不可信，不派生 KVM_REACHED
  if (brokenHooks.has('*')) return false;
  // 动作观察面（observer action 钩子）失败：用户动作事实不可信
  if (brokenHooks.has('action')) return false;
  for (const action of facts.actions) {
    const at = timeOf(action.occurredAt);
    // 时间不可解析 → 零信号（保守方向，与 detectViewerActivity 一致：不得把 0 凑成时序）
    if (!at) continue;
    // 动作 target 缺失 → 血缘不可判：零信号（保守方向）
    if (!action.targetId) continue;
    const lineage = viewerLineageOf(action.targetId, facts.targets);
    // 打开证据：血缘集合内动作之后出现的 popup 或主框架导航（取最早）
    let openedAt = Number.POSITIVE_INFINITY;
    for (const target of facts.targets) {
      if (target.type !== 'popup' || target.attachedAt === undefined) continue;
      if (!lineage.has(target.id)) continue;
      const attachedAt = timeOf(target.attachedAt);
      if (attachedAt >= at && attachedAt < openedAt) openedAt = attachedAt;
    }
    for (const navigation of facts.navigations) {
      if (!lineage.has(navigation.targetId)) continue;
      const occurredAt = timeOf(navigation.occurredAt);
      if (occurredAt >= at && occurredAt < openedAt) openedAt = occurredAt;
    }
    if (!Number.isFinite(openedAt)) continue;
    // 打开证据之后才新建的渲染/执行表面；不能借用
    // 登录前/导航前已存在的 Dashboard Canvas 拼出 Viewer。
    const surfaceAt = earliestRenderSurfaceAt(facts, lineage, openedAt, brokenHooks);
    if (surfaceAt === null) continue;
    // 通道必须不早于渲染表面：动作 → 打开 → 表面 → 通道。
    if (
      facts.channels.some(
        channel =>
          channel.targetId !== null &&
          lineage.has(channel.targetId) &&
          timeOf(channel.createdAt) >= surfaceAt &&
          isBidirectionalChannel(channel, brokenHooks),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function deriveWorkflowStatus(facts: WorkflowFacts): DerivedWorkflowStatus {
  const loginPropagation = deriveLoginReached(facts);
  const viewerActivity = deriveViewerActivity(facts);
  if (viewerActivity) return { workflowStatus: 'KVM_REACHED', loginPropagation, viewerActivity };
  if (loginPropagation) return { workflowStatus: 'LOGIN_REACHED', loginPropagation, viewerActivity };
  return { workflowStatus: 'TARGET_OPENED', loginPropagation, viewerActivity };
}

/**
 * 事实快照的变化签名（第 11 轮审核 P3-R11-4）。
 *
 * 只投影派生引擎读取、且可能随采集推进原位变更的字段（事务 status /
 * 响应 Set-Cookie / 请求 Cookie 头、通道帧计数、target attachedAt 等；
 * 追加型事实按 id + 派生相关字段投影）。O(n) 拼接远低于派生本身的
 * O(actions×navigations) 配对——renderer 2s 轮询 / 看门狗轮询在事实未
 * 变化时命中缓存即可，不重跑派生。多投影字段只导致多派一次（安全），
 * 漏投影字段会给出过期状态（危险），因此字段集合必须与
 * deriveLoginReached / deriveViewerActivity 的读取面保持同步。
 */
export function workflowFactsSignature(facts: WorkflowFacts): string {
  const parts: string[] = [];
  for (const transaction of facts.transactions) {
    parts.push(
      `tx:${transaction.id}:${transaction.method}:${transaction.requestBody ? 1 : 0}:` +
        `${transaction.status ?? ''}:${headerOf(transaction.responseHeaders, 'set-cookie') ?? ''}:` +
        `${headerOf(transaction.requestHeaders, 'cookie') ?? ''}:${transaction.startedAt}:` +
        // WASM 表面证据读取面（五轮 G1）：归属/资源类型可翻转派生结果
        `${transaction.resourceType}:${transaction.targetId ?? ''}:` +
        // 响应到达时刻读取面（五轮 G4）：timing 在 responseReceived 原位补齐，
        // LOGIN_REACHED 的签发时刻随之变化，漏投影会给过期状态
        `${transaction.timing?.sendMs ?? ''}/${transaction.timing?.waitMs ?? ''}/${transaction.timing?.receiveMs ?? ''}`,
    );
  }
  for (const action of facts.actions) {
    parts.push(`action:${action.id}:${action.targetId}:${action.occurredAt}`);
  }
  for (const target of facts.targets) {
    parts.push(
      `target:${target.id}:${target.type}:${target.openerTargetId ?? ''}:` +
        `${target.parentTargetId ?? ''}:${target.attachedAt ?? ''}`,
    );
  }
  for (const channel of facts.channels) {
    parts.push(
      `channel:${channel.id}:${channel.kind}:${channel.targetId ?? ''}:${channel.createdAt}:` +
        `${channel.frameCounts?.up ?? ''}/${channel.frameCounts?.down ?? ''}`,
    );
  }
  for (const navigation of facts.navigations) {
    parts.push(`nav:${navigation.occurredAt}:${navigation.targetId}:${navigation.url ?? ''}`);
  }
  for (const surface of facts.renderSurfaces) {
    parts.push(`surface:${surface.id}:${surface.targetId}:${surface.occurredAt}:${surface.surface}`);
  }
  for (const failure of facts.hookFailures) {
    parts.push(`hook:${failure.hook}`);
  }
  return parts.join('|');
}
