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
  });
});
