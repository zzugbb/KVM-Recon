import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import { APP_VERSION } from '../version';

/**
 * 单屏单作业工作台（规范 §5）：静态标记断言——阶段派生逻辑在 stage.test.ts。
 * 高级诊断默认折叠；0.2.x 交互（多作业/打开对比包/暂停/手动截图/复验）不得回归。
 */

describe('App（单屏单作业工作台，阶段 5）', () => {
  it('渲染 §5.2 单屏结构：顶栏未脱敏徽标 + 输入行 + 阶段条 + 计数器 + 最近事实', () => {
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
    expect(html).toContain('Targets');
    expect(html).toContain('WS');
    expect(html).toContain('已写入');
    expect(html).toContain('缺失');
    expect(html).toContain('最近事实');
    expect(html).toContain('等待输入');
  });

  it('生命周期按钮在场：停止并收尾 / 导出 / 打开所在文件夹 / 采集下一台', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('停止并收尾');
    expect(html).toContain('导出采集包');
    expect(html).toContain('打开所在文件夹');
    expect(html).toContain('采集下一台');
  });

  it('高级诊断默认折叠（details 未展开）', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('高级诊断');
    expect(html).toContain('<details class="advanced-diagnostics">');
    expect(html).not.toContain('<details class="advanced-diagnostics" open>');
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
