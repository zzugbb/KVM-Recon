/**
 * workflowStatus 派生引擎（规范 §6 / §7.3，阶段 3 第 1 刀）。
 *
 * 从观察事实（HTTP 事务 / 用户动作 / target 血缘 / 通道行 / 主框架导航 /
 * 观察脚本钩子失败记账）派生 WorkflowStatus，协议无关、不依赖厂商 URL
 * 与页面语义：
 * - LOGIN_REACHED：POST + 请求正文 + 2xx/3xx 响应 Set-Cookie，且之后的
 *   请求逐字节携带该 name=value（观察到的 cookie 传播，不猜登录语义）；
 * - KVM_REACHED：用户动作（click / form-submit）之后出现主框架导航或
 *   popup target，且之后建立持续双向通道——WS 双向帧 >0、WebRTC 双向
 *   消息 >0，或 WebTransport 通道在场（payload 不可观察，存在即通道
 *   事实）；SSE / 下载为单向通道，单独不构成；
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
      issued.push({ at: timeOf(transaction.startedAt), transactionId: transaction.id, pair });
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

function deriveViewerActivity(facts: WorkflowFacts): boolean {
  const brokenHooks = new Set(facts.hookFailures.map(failure => failure.hook));
  // 钩子失败记账溢出（*）：观察面整体不可信，不派生 KVM_REACHED
  if (brokenHooks.has('*')) return false;
  // 动作观察面（observer action 钩子）失败：用户动作事实不可信
  if (brokenHooks.has('action')) return false;
  for (const action of facts.actions) {
    const at = timeOf(action.occurredAt);
    const targetOpenedAfterAction = facts.targets.some(
      target => target.type === 'popup' && target.attachedAt !== undefined && timeOf(target.attachedAt) >= at,
    );
    const navigatedAfterAction = facts.navigations.some(navigation => timeOf(navigation.occurredAt) >= at);
    if (!targetOpenedAfterAction && !navigatedAfterAction) continue;
    if (
      facts.channels.some(
        channel => timeOf(channel.createdAt) >= at && isBidirectionalChannel(channel, brokenHooks),
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
        `${headerOf(transaction.requestHeaders, 'cookie') ?? ''}:${transaction.startedAt}`,
    );
  }
  for (const action of facts.actions) {
    parts.push(`action:${action.id}:${action.occurredAt}`);
  }
  for (const target of facts.targets) {
    parts.push(`target:${target.id}:${target.type}:${target.attachedAt ?? ''}`);
  }
  for (const channel of facts.channels) {
    parts.push(
      `channel:${channel.id}:${channel.kind}:${channel.createdAt}:` +
        `${channel.frameCounts?.up ?? ''}/${channel.frameCounts?.down ?? ''}`,
    );
  }
  for (const navigation of facts.navigations) {
    parts.push(`nav:${navigation.occurredAt}:${navigation.url ?? ''}`);
  }
  for (const failure of facts.hookFailures) {
    parts.push(`hook:${failure.hook}`);
  }
  return parts.join('|');
}
