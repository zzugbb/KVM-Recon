import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdvancedDiagnostics, App, type StatusJob } from './App';
import { APP_VERSION } from '../version';

/**
 * 单屏单作业工作台（规范 §5）：静态标记断言——阶段派生逻辑在 stage.test.ts。
 * 高级诊断默认折叠；0.2.x 交互（多作业/打开对比包/暂停/手动截图/复验）不得回归。
 */

const stoppedJob: StatusJob = {
  jobId: 'job-1-abcdef12',
  state: 'stopped',
  workflowStatus: 'KVM_REACHED',
  windowsOpen: true,
  storageLimited: false,
  windowsLabel: '',
  targetLabel: '10.10.8.111',
  targetUrl: 'https://10.10.8.111:443/',
  finalizing: false,
  counts: { httpTransactions: 3, targets: 1, channels: 1, websocketChannels: 1, actions: 2 },
  bytesWritten: 2048,
  captureIntegrity: 'COMPLETE',
  incompleteReasons: [],
  recentFacts: [],
  diagnostics: {
    droppedEvents: 0,
    droppedEventByMethod: {},
    gapCounts: {},
    storageLimitReached: false,
    observerHookFailures: [],
    channelGaps: [],
    unsupportedChannels: [],
    captureWindowLogTail: [],
    disk: null,
  },
};

describe('App（单屏单作业工作台）', () => {
  it('渲染 §5.2 单屏结构：顶栏未脱敏徽标 + 状态面板（表单 + 阶段条）+ 计数器 + 最近事实', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('KVM-Recon');
    expect(html).toContain(`v${APP_VERSION}`);
    expect(html).toContain('原始资料 · 未脱敏');
    expect(html).toContain('BMC 地址');
    expect(html).toContain('设备说明');
    expect(html).toContain('开始采集');
    expect(html).toContain('连接目标');
    expect(html).toContain('登录活动');
    expect(html).toContain('Viewer 活动');
    expect(html).toContain('完整性校验');
    expect(html).toContain('HTTP');
    expect(html).toContain('目标');
    expect(html).toContain('WS');
    expect(html).toContain('已写入');
    expect(html).toContain('缺失');
    expect(html).toContain('最近事实');
    expect(html).toContain('新建采集');
  });

  it('空闲态只显示可用入口，不占位展示其他生命周期操作', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('开始采集');
    expect(html).not.toContain('停止并收尾');
    expect(html).not.toContain('导出采集包');
    expect(html).not.toContain('打开所在文件夹');
    expect(html).not.toContain('采集下一台');
  });

  it('空闲态：新建作业表单位于状态面板内，开始采集是表单提交按钮', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('<section class="status-panel tone-neutral" aria-label="当前状态">');
    expect(html).toContain('<h1 class="status-title">新建采集</h1>');
    expect(html).toMatch(/<section class="status-panel[^"]*"[^>]*>.*<form class="target-row" aria-label="新建采集作业">/);
    expect(html).toMatch(/<form class="target-row"[^>]*>.*<button type="submit"[^>]*>.*开始采集<\/button><\/form>/);
    expect(html).not.toContain('class="primary-actions"');
  });

  it('空闲态高级诊断常驻但折叠且不参与高度分摊，最近事实为紧凑空态', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('<section class="advanced-diagnostics is-idle" aria-label="高级诊断">');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<section class="recent-facts is-idle" aria-label="最近事实">');
  });

  it('高级诊断默认折叠：折叠按钮 aria-expanded=false，诊断内容不渲染', () => {
    const html = renderToStaticMarkup(<AdvancedDiagnostics job={stoppedJob} busy={false} onRetain={() => undefined} />);

    expect(html).toContain('高级诊断');
    expect(html).toContain('<section class="advanced-diagnostics" aria-label="高级诊断">');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('class="diagnostics-body"');
    expect(html).not.toContain('advanced-diagnostics is-open');
  });

  it('反例：0.2.x 交互入口不得回归（多作业/打开对比包/暂停/手动截图/复验）', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).not.toContain('作业列表');
    expect(html).not.toContain('打开 Capture Pack');
    expect(html).not.toContain('对比');
    expect(html).not.toContain('暂停采集');
    expect(html).not.toContain('采集当前画面');
    expect(html).not.toContain('离场适配就绪');
    expect(html).not.toContain('手动截图');
    expect(html).not.toContain('复验');
  });
});
