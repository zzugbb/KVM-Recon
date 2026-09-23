/**
 * Viewer 活动识别纯模块（规范 §7.3）。
 *
 * 从 WorkflowFacts 识别 Viewer 活动组合信号：用户动作（click / form-submit）
 * 之后，在动作 target 的**血缘集合**（自身 + opener/parent 链后代）
 * 内出现 popup target 或主框架导航，随后新建渲染/执行表面并建立持续双向
 * 通道（动作 → 打开 → 表面 → 通道）。与 workflowStatusEngine 的 KVM_REACHED 派生共用同一
 * 事实组合与钩子失败折扣，不出现两套定义（单测以
 * deriveWorkflowStatus.viewerActivity 对照）。
 *
 * 纯函数、永不抛出：畸形事实按保守缺失处理，不构成信号。
 * 信号供自动收尾（§7.4）与诊断展示使用；识别失败不影响采集。
 */

import type { PackV2ChannelRow, PackV2RenderSurfaceRow } from '../capture-pack-v2/types';
import { timeOf, viewerLineageOf, type WorkflowFacts } from './workflowStatusEngine';

/** 一组被观察到的 Viewer 活动组合（§7.3）。 */
export interface ViewerActivitySignal {
  /** 触发组合的用户动作行 id。 */
  actionId: string;
  actionKind: string;
  actionAt: string;
  /** 打开证据：popup target 或主框架导航。 */
  openedVia: 'popup' | 'navigation';
  /** popup target id（openedVia=popup）或导航 URL（openedVia=navigation）。 */
  openedDetail: string;
  /** 打开证据的发生时刻（popup attachedAt / 导航 occurredAt）。 */
  openedAt: string;
  /** Viewer 所在根 target（popup target id 或导航 target id）：viewer-initial 阶段截图路由用（§7.4）。 */
  viewerTargetId: string;
  /** §7.3 第 2 组事实：动作后血缘内新建的渲染/执行表面（页面侧或 WASM 事务）。 */
  surfaceKind: string;
  surfaceAt: string;
  /** 动作后建立的持续双向通道 id。 */
  channelId: string;
  channelKind: string;
  channelCreatedAt: string;
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
 * §7.3 第 2 组事实：动作后在血缘集合内新建的渲染/执行表面——
 * 页面观察脚本上报的 render-surface 行（钩子失败时该观察面不可信），
 * 或 WASM 事务（CDP 观察）。与 workflowStatusEngine.earliestRenderSurfaceAt
 * 保持同一事实组合（宁可漏不可错）。
 */
function earliestSurfaceEvidence(
  facts: WorkflowFacts,
  lineage: ReadonlySet<string>,
  at: number,
  brokenHooks: ReadonlySet<string>,
): { kind: string; at: string } | null {
  let best: { kind: string; at: string } | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  const consider = (kind: string, occurredAt: string): void => {
    const when = timeOf(occurredAt);
    if (when < at || when >= bestAt) return;
    best = { kind, at: occurredAt };
    bestAt = when;
  };
  if (!brokenHooks.has('render-surface')) {
    for (const surface of facts.renderSurfaces) {
      if (!surface.targetId || !lineage.has(surface.targetId)) continue;
      consider(surface.surface, surface.occurredAt);
    }
  }
  for (const transaction of facts.transactions) {
    if (transaction.resourceType !== 'wasm') continue;
    if (!transaction.targetId || !lineage.has(transaction.targetId)) continue;
    consider('wasm', transaction.startedAt);
  }
  return best;
}

/**
 * 识别 Viewer 活动信号（每组动作一条：取最早的合格打开证据与最早的合格通道）。
 * 永不抛出：字段缺失 / 时间不可解析按保守处理，不构成信号。
 * 打开证据（popup / 导航）、渲染表面与通道都必须属动作 target 的血缘集合，
 * 且严格按“动作 → 打开 → 表面 → 通道”排序。任何倒挂都不构成信号，
 * 也不能复用打开前已存在的 Dashboard Canvas。无渲染/执行表面证据
 * （登录后 Dashboard 后台告警 WS）不构成信号（§7.3 四组事实合取）。
 */
export function detectViewerActivity(facts: WorkflowFacts): ViewerActivitySignal[] {
  const brokenHooks = new Set(facts.hookFailures.map(failure => failure.hook));
  // 钩子失败记账溢出（*）或动作观察面失败：用户动作事实不可信
  if (brokenHooks.has('*') || brokenHooks.has('action')) return [];
  const signals: ViewerActivitySignal[] = [];
  for (const action of facts.actions) {
    if (action.kind !== 'click' && action.kind !== 'form-submit') continue;
    const actionAt = timeOf(action.occurredAt);
    if (!actionAt) continue;
    // 动作 target 缺失 → 血缘不可判：零信号（保守方向）
    if (!action.targetId) continue;
    const lineage = viewerLineageOf(action.targetId, facts.targets);

    let openedVia: 'popup' | 'navigation' | null = null;
    let openedDetail = '';
    let openedAtIso = '';
    let viewerTargetId = '';
    let openedAt = Number.POSITIVE_INFINITY;
    for (const target of facts.targets) {
      if (target.type !== 'popup' || target.attachedAt === undefined) continue;
      if (!lineage.has(target.id)) continue;
      const at = timeOf(target.attachedAt);
      if (at < actionAt || at >= openedAt) continue;
      openedVia = 'popup';
      openedDetail = target.id;
      openedAtIso = target.attachedAt;
      viewerTargetId = target.id;
      openedAt = at;
    }
    for (const navigation of facts.navigations) {
      if (!lineage.has(navigation.targetId)) continue;
      const at = timeOf(navigation.occurredAt);
      if (at < actionAt || at > openedAt) continue;
      openedVia = 'navigation';
      openedDetail = navigation.url ?? '';
      openedAtIso = navigation.occurredAt;
      viewerTargetId = navigation.targetId;
      openedAt = at;
    }
    if (!openedVia) continue;

    const surface = earliestSurfaceEvidence(facts, lineage, openedAt, brokenHooks);
    if (!surface) continue;
    const surfaceAt = timeOf(surface.at);

    let channel: PackV2ChannelRow | null = null;
    let channelAt = Number.POSITIVE_INFINITY;
    for (const candidate of facts.channels) {
      if (candidate.targetId === null || !lineage.has(candidate.targetId)) continue;
      const at = timeOf(candidate.createdAt);
      if (at < surfaceAt || at > channelAt) continue;
      if (!isBidirectionalChannel(candidate, brokenHooks)) continue;
      channel = candidate;
      channelAt = at;
    }
    if (!channel) continue;

    signals.push({
      actionId: action.id,
      actionKind: action.kind,
      actionAt: action.occurredAt,
      openedVia,
      openedDetail,
      openedAt: openedAtIso,
      viewerTargetId,
      surfaceKind: surface.kind,
      surfaceAt: surface.at,
      channelId: channel.id,
      channelKind: channel.kind,
      channelCreatedAt: channel.createdAt,
    });
  }
  return signals;
}

/**
 * 活动指纹（§7.4 稳定窗口重置依据）：动作 / target / 通道 / 导航 / 渲染表面计数。
 * 新 target、通道、导航、渲染表面或用户动作出现 → 指纹变化 → 稳定窗口重置；
 * 事务行增长（后台轮询流量）不重置窗口。
 */
export function activityFingerprint(facts: WorkflowFacts): string {
  return `${facts.actions.length}/${facts.targets.length}/${facts.channels.length}/${facts.navigations.length}/${facts.renderSurfaces.length}`;
}
