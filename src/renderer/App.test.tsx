import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('App', () => {
  it('renders the desktop client starting point and empty capture readiness', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('KVM-Recon');
    expect(html).toContain('离线 BMC/KVM 资料采集工具');
    expect(html).toContain('离场适配就绪：NO');
    expect(html).toContain('新建采集作业');
    expect(html).toContain('停止采集并导出');
    expect(html).toContain('作业备注');
    expect(html).toContain('现场厂商');
    expect(html).toContain('现场型号');
    expect(html).toContain('机柜位置');
    expect(html).toContain('field-row-pair');
    expect(html).toContain('补拍画面（可选）');
    expect(html).toContain('采集当前画面');
    expect(html).toContain('actions-extra');
    expect(html).toContain('当前阶段：新建采集');
    expect(html).toContain('填写 BMC 地址后点「新建采集作业」');
    expect(html).not.toContain('请开始采集并至少完成 BMC 登录、HTML5 KVM 入口点击和 WebSocket 建立。');
    expect(html).toContain('采集进度');
    expect(html).toContain('采集当前画面');
    expect(html).toContain('关闭采集窗口');
    expect(html).toContain('登录后复验探测');
    expect(html).toContain('暂停采集');
    expect(html).toContain('作业列表');
    expect(html).toContain('打开 Capture Pack');
    expect(html).toContain('对比两份');
    expect(html).toContain('KVM 画面截图');
    expect(html).not.toContain('viewer 页面截图已采集');
    expect(html).toMatch(/采集当前画面[\s\S]*disabled|disabled[\s\S]*采集当前画面/);
  });
});
