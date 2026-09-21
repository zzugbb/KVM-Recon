import { useEffect, useState } from 'react';

import { APP_VERSION } from '../version';

/**
 * 单作业工作台（规范 §4 / §5，阶段 2 最小面；阶段 5 收口打磨）。
 * 两个输入（BMC 地址 + 设备说明）+ 生命周期按钮（开始/停止/导出/丢弃），
 * 顶部常驻「原始资料 · 未脱敏」提示，启动时显示崩溃恢复结果。
 */

interface StatusJob {
  jobId: string;
  state: 'capturing' | 'stopped' | 'exported';
  windowsOpen: boolean;
  storageLimited: boolean;
  windowsLabel: string;
  diagnostics: {
    droppedEvents: number;
    droppedEventByMethod: Record<string, number>;
    gapCounts: Record<string, number>;
    storageLimitReached: boolean;
  };
}

interface StatusPayload {
  ok: true;
  job: StatusJob | null;
  export: { zipPath: string; fileName: string; status: { captureIntegrity: string } } | null;
  recovery: {
    kind: 'exported' | 'refused' | 'failed';
    jobId?: string;
    zipPath?: string;
    reason?: string;
    error?: string;
    conservative?: boolean;
  } | null;
}

function stateText(job: StatusJob | null) {
  if (!job) return '空闲';
  if (job.state === 'exported') return '已导出';
  if (job.state === 'stopped') return '已收尾（可导出）';
  return job.windowsOpen ? '采集中' : '采集窗口已关闭（可停止收尾）';
}

function gapSummary(job: StatusJob | null) {
  if (!job) return '';
  const gaps: Array<[string, string]> = Object.entries(job.diagnostics.gapCounts).map(
    ([key, count]) => [key, String(count)],
  );
  if (job.diagnostics.droppedEvents > 0) {
    gaps.push(['丢弃事件', String(job.diagnostics.droppedEvents)]);
  }
  if (gaps.length === 0) return '无缺口记录';
  return gaps.map(([key, count]) => `${key}×${count}`).join('、');
}

export function App() {
  const [target, setTarget] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    if (!window.kvmRecon?.getCaptureStatus) return;
    const result = (await window.kvmRecon.getCaptureStatus()) as StatusPayload | { ok: false; error: string };
    if (result.ok) {
      setStatus(result);
    } else {
      setError(result.error);
    }
  }

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 2000);
    return () => clearInterval(timer);
  }, []);

  async function run(action: () => Promise<{ ok: boolean } & Record<string, unknown>>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await action();
      if ('ok' in result && result.ok) {
        await refreshStatus();
      } else {
        setError(String(('error' in result && result.error) || '操作失败'));
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  }

  const preloadMissing = typeof window !== 'undefined' && !window.kvmRecon?.startCapture;
  const job = status?.job ?? null;
  const canStart = !job && !busy && target.trim().length > 0 && !preloadMissing;
  const canStop = job?.state === 'capturing' && !busy;
  const canExport = job && job.state !== 'exported' && !busy;
  const canDiscard = job?.state === 'exported' && !busy;

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="eyebrow">KVM-Recon v{APP_VERSION} · 离线 BMC/KVM 资料采集工具</p>
        <h1>单作业采集工作台</h1>
        <p className="description" role="status">
          原始资料 · 未脱敏：导出的 Capture Pack 可能包含有效凭据与会话，只能作为敏感文件保管。
        </p>
      </header>

      {preloadMissing ? (
        <p className="error-card" role="alert">
          采集接口未加载：请使用 KVM-Recon 桌面应用打开本页面，不要用浏览器打开。
        </p>
      ) : null}

      {status?.recovery ? (
        <div className="status-card" role="alert" aria-label="崩溃恢复结果">
          <h2>上次作业恢复</h2>
          {status.recovery.kind === 'exported' ? (
            <p>
              上次未完成的作业 {status.recovery.jobId} 已按保守事实恢复导出到{' '}
              <code>{status.recovery.zipPath}</code>
              （{status.recovery.conservative ? '硬崩溃保守摘要' : '真实摘要'}，包为 INCOMPLETE）。
            </p>
          ) : status.recovery.kind === 'refused' ? (
            <p>
              拒绝恢复作业 {status.recovery.jobId ?? ''}：{status.recovery.reason}
            </p>
          ) : (
            <p>
              恢复作业 {status.recovery.jobId ?? ''} 失败：{status.recovery.error}
            </p>
          )}
        </div>
      ) : null}

      <section className="target-form" aria-label="新建采集作业">
        <div className="field-row field-row-primary">
          <label>
            BMC 地址
            <input
              value={target}
              onChange={event => setTarget(event.target.value)}
              placeholder="例如 10.10.8.111 或 https://10.10.8.111:8443"
              disabled={Boolean(job) || busy}
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            设备说明（可选）
            <input
              value={deviceLabel}
              onChange={event => setDeviceLabel(event.target.value)}
              placeholder="例如 Dell R740 / iDRAC9"
              disabled={Boolean(job) || busy}
            />
          </label>
        </div>
        <div className="actions">
          <button type="button" onClick={() => void run(() => window.kvmRecon!.startCapture(target, deviceLabel))} disabled={!canStart}>
            开始采集
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void run(() => window.kvmRecon!.stopCapture())}
            disabled={!canStop}
          >
            停止并收尾
          </button>
          <button
            type="button"
            onClick={() => void run(() => window.kvmRecon!.exportCapture())}
            disabled={!canExport}
          >
            导出采集包
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void run(() => window.kvmRecon!.discardCapture())}
            disabled={!canDiscard}
          >
            丢弃已导出作业
          </button>
        </div>
      </section>

      {message ? (
        <p className="message" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="error-card" role="alert">
          {error}
        </p>
      ) : null}

      <section className="status-card" aria-label="当前作业">
        <h2>当前作业</h2>
        {job ? (
          <>
            <p>
              <span className="status-label">{stateText(job)}</span> · <code>{job.jobId}</code>
              {job.windowsLabel ? ` · ${job.windowsLabel}` : ''}
            </p>
            <p>缺口记录：{gapSummary(job)}</p>
            {job.storageLimited ? <p className="error-card">磁盘水位已触发（storageLimited），包完整性不保证 COMPLETE。</p> : null}
          </>
        ) : (
          <p>空闲：填写 BMC 地址后点「开始采集」，在弹出的窗口里手工登录并打开 HTML5 KVM。</p>
        )}
        {status?.export ? (
          <p>
            已导出：<code>{status.export.zipPath}</code>（{status.export.status.captureIntegrity}）
          </p>
        ) : null}
      </section>
    </div>
  );
}
