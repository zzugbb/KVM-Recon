import { useEffect, useState } from 'react';

import type { CaptureReadiness, ChecklistItem } from '../core/capture-pack/types';
import { createEmptyCapturePack } from '../core/capture-pack/createEmptyCapturePack';
import { buildLiveCaptureSnapshot } from '../core/delivery/buildLiveCaptureSnapshot';

interface FormattedCaptureError {
  title: string;
  impact: string;
  action: string;
  detail: string;
}

type CapturePhase = 'idle' | 'capturing' | 'exported';

const previewPack = createEmptyCapturePack({
  jobId: 'preview-empty-job',
  startedAt: '2026-08-24T10:00:00.000+08:00',
  target: {
    host: '0.0.0.0',
    port: 443,
    scheme: 'https',
  },
});

const emptySnapshot = buildLiveCaptureSnapshot({});

function phaseLabel(phase: CapturePhase) {
  if (phase === 'capturing') return '当前阶段：采集中';
  if (phase === 'exported') return '当前阶段：导出结果';
  return '当前阶段：新建采集';
}

function statusText(status: string) {
  if (status === 'pass') return '已采集';
  if (status === 'needs_user_action') return '待现场操作';
  if (status === 'missing') return '缺失';
  if (status === 'unknown') return '未知';
  if (status === 'not_applicable') return '不适用';
  return status;
}

export function App() {
  const [host, setHost] = useState('10.0.0.10');
  const [port, setPort] = useState('443');
  const [operatorNote, setOperatorNote] = useState('');
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [jobId, setJobId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<FormattedCaptureError | null>(null);
  const [readiness, setReadiness] = useState(previewPack.manifest.readiness.status);
  const [statusHint, setStatusHint] = useState(previewPack.checklist.items[0]?.userAction || '');
  const [progressItems, setProgressItems] = useState<ChecklistItem[]>(emptySnapshot.items);

  function applySnapshot(snapshot: { readiness: CaptureReadiness; items: ChecklistItem[] }) {
    setReadiness(snapshot.readiness);
    setProgressItems(snapshot.items);
    const pending = snapshot.items.find(item => item.status !== 'pass' && item.status !== 'not_applicable');
    setStatusHint(pending?.userAction || '关键资料已采集，可导出后查看报告。');
  }

  async function refreshSnapshot(nextJobId = jobId) {
    if (!nextJobId || !window.kvmRecon?.getCaptureSnapshot) return;
    const result = await window.kvmRecon.getCaptureSnapshot(nextJobId);
    if (result.ok) applySnapshot(result);
  }

  useEffect(() => {
    if (phase !== 'capturing' || !jobId) return undefined;
    void refreshSnapshot(jobId);
    const timer = window.setInterval(() => {
      void refreshSnapshot(jobId);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [phase, jobId]);

  async function startCapture() {
    const numericPort = Number(port) || 443;
    setError(null);
    if (!window.kvmRecon?.startCapture) {
      setMessage('当前运行环境不支持采集窗口。');
      return;
    }

    const result = await window.kvmRecon.startCapture({
      host,
      port: numericPort,
      scheme: 'https',
      operatorNote,
    });
    if (!result.ok) {
      setPhase('idle');
      setError(result.error);
      setMessage('');
      return;
    }
    setJobId(result.jobId);
    setPhase('capturing');
    applySnapshot(result.snapshot);
    setMessage(`采集作业已启动：${result.jobId}`);
  }

  async function collectCurrentPage() {
    setError(null);
    if (!jobId || !window.kvmRecon?.collectCapturePage) {
      setError({
        title: '尚未开始采集',
        impact: '当前没有可补采的页面。',
        action: '请先点击“新建采集作业”，打开 BMC 后再采集当前页面。',
        detail: '',
      });
      return;
    }
    const result = await window.kvmRecon.collectCapturePage(jobId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    applySnapshot(result);
    setMessage('已采集当前页面截图、storage 和选择器。');
  }

  async function exportCapture() {
    setError(null);
    if (!window.kvmRecon?.exportCapture) {
      setMessage('当前运行环境不支持导出 Capture Pack。');
      return;
    }
    if (!jobId) {
      setError({
        title: '尚未开始采集',
        impact: '当前没有可导出的 Capture Pack。',
        action: '请先点击“新建采集作业”，完成登录和 HTML5 KVM 打开后再导出。',
        detail: '',
      });
      return;
    }

    const result = await window.kvmRecon.exportCapture(jobId);
    if (!result.ok) {
      if (result.canceled) {
        setMessage('已取消导出。');
        return;
      }
      setError(result.error);
      setMessage('');
      return;
    }
    setPhase('exported');
    setReadiness(result.readiness);
    setStatusHint(`已导出 ${result.fileName}，请打开 report.html 确认离场结论。`);
    setMessage(`已导出：${result.fileName}`);
    await refreshSnapshot(jobId);
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
        <p className="phase-label">{phaseLabel(phase)}</p>
        <div className="target-form">
          <label>
            BMC 地址
            <input value={host} onChange={event => setHost(event.target.value)} />
          </label>
          <label>
            端口
            <input value={port} onChange={event => setPort(event.target.value)} />
          </label>
          <label className="note-field">
            作业备注
            <input
              value={operatorNote}
              onChange={event => setOperatorNote(event.target.value)}
              placeholder="可选，不填写账号或密码"
            />
          </label>
        </div>
        <div className="actions">
          <button type="button" onClick={startCapture} disabled={phase === 'capturing'}>
            新建采集作业
          </button>
          <button
            type="button"
            className="secondary"
            onClick={collectCurrentPage}
            disabled={phase !== 'capturing'}
          >
            采集当前页面
          </button>
          <button
            type="button"
            className="secondary"
            onClick={exportCapture}
            disabled={phase !== 'capturing'}
          >
            停止采集并导出
          </button>
        </div>
        {message ? <p className="message">{message}</p> : null}
        {error ? (
          <aside className="error-card" aria-label="Capture error">
            <strong>{error.title}</strong>
            <p>{error.impact}</p>
            <p>{error.action}</p>
            {error.detail ? <p className="error-detail">{error.detail}</p> : null}
          </aside>
        ) : null}
      </section>

      <section className="status-card" aria-label="Capture Pack readiness">
        <div>
          <strong className="status-label">离场适配就绪：{readiness}</strong>
        </div>
        <p>{statusHint}</p>
        <div className="progress-list" aria-label="Capture progress">
          <h2>采集进度</h2>
          <ul>
            {progressItems.map(item => (
              <li key={item.id}>
                <div>
                  <span>{item.title}</span>
                  {item.userAction ? <p>{item.userAction}</p> : null}
                </div>
                <strong>{statusText(item.status)}</strong>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
