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
    expect(html).toContain('当前阶段：新建采集');
    expect(html).toContain('采集进度');
    expect(html).toContain('采集当前页面');
    expect(html).toContain('请确认 BMC 地址、端口和网络可达后重新执行基础探测。');
    expect(html).toMatch(/采集当前页面[\s\S]*disabled|disabled[\s\S]*采集当前页面/);
  });
});
