import { useState } from 'react';

import { createEmptyCapturePack } from '../core/capture-pack/createEmptyCapturePack';

const previewPack = createEmptyCapturePack({
  jobId: 'preview-empty-job',
  startedAt: '2026-08-24T10:00:00.000+08:00',
  target: {
    host: '0.0.0.0',
    port: 443,
    scheme: 'https',
  },
});

export function App() {
  const [host, setHost] = useState('10.0.0.10');
  const [port, setPort] = useState('443');
  const [message, setMessage] = useState('');

  async function startCapture() {
    const numericPort = Number(port) || 443;
    if (!window.kvmRecon?.startCapture) {
      setMessage('当前运行环境不支持采集窗口。');
      return;
    }

    const result = await window.kvmRecon.startCapture({
      host,
      port: numericPort,
      scheme: 'https',
    });
    setMessage(`采集作业已启动：${result.jobId}`);
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Offline BMC/KVM Discovery Toolkit</p>
        <h1>KVM-Recon</h1>
        <p className="subtitle">离线 BMC/KVM 资料采集工具</p>
        <p className="description">
          在机房内采集登录、HTML5 KVM 入口、HTTP/WebSocket、页面截图和离场验收资料，
          导出脱敏 Capture Pack 供后续兼容性分析。
        </p>
        <div className="target-form">
          <label>
            BMC 地址
            <input value={host} onChange={event => setHost(event.target.value)} />
          </label>
          <label>
            端口
            <input value={port} onChange={event => setPort(event.target.value)} />
          </label>
        </div>
        <div className="actions">
          <button type="button" onClick={startCapture}>
            新建采集作业
          </button>
          <button type="button" className="secondary">
            打开 Capture Pack
          </button>
        </div>
        {message ? <p className="message">{message}</p> : null}
      </section>

      <section className="status-card" aria-label="Capture Pack readiness">
        <div>
          <strong className="status-label">
            离场适配就绪：{previewPack.manifest.readiness.status}
          </strong>
        </div>
        <p>{previewPack.checklist.items[0]?.userAction}</p>
      </section>
    </main>
  );
}
