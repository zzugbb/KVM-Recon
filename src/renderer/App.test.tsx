import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import { APP_VERSION } from '../version';

describe('App（单作业工作台，阶段 2）', () => {
  it('渲染单作业工作台：未脱敏常驻提示 + 两个输入 + 生命周期按钮', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('KVM-Recon');
    expect(html).toContain(`v${APP_VERSION}`);
    expect(html).toContain('原始资料 · 未脱敏');
    expect(html).toContain('BMC 地址');
    expect(html).toContain('设备说明');
    expect(html).toContain('开始采集');
    expect(html).toContain('停止并收尾');
    expect(html).toContain('导出采集包');
    expect(html).toContain('丢弃已导出作业');
    expect(html).toContain('当前作业');
    expect(html).toContain('空闲：填写 BMC 地址后点「开始采集」');
    // 单作业模型：不再有多作业列表 / 打开与对比包 / 暂停 / 手动截图入口
    expect(html).not.toContain('作业列表');
    expect(html).not.toContain('打开 Capture Pack');
    expect(html).not.toContain('对比');
    expect(html).not.toContain('暂停采集');
    expect(html).not.toContain('采集当前画面');
    expect(html).not.toContain('离场适配就绪');
  });
});
