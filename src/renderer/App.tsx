import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Archive, Download, FolderOpen, Play } from 'lucide-react';

import { APP_VERSION } from '../version';
import { STAGE_BAR_STEPS, derivePageStage, stageBarOf, stageStatusText } from './stage';

/**
 * 单屏单作业工作台（规范 §4 / §5，阶段 5 收口）。
 * 顶栏常驻「原始资料 · 未脱敏」；两个输入（BMC 地址 + 设备说明）；
 * 阶段条 + 稳定宽度计数器 + 最近事实（非敏感摘要）；高级诊断默认折叠；
 * 导出永远手动（COMPLETE 不自动弹保存框；INCOMPLETE 按钮明确写「导出未完整包」）。
 */

interface StatusJob {
  jobId: string;
  state: 'capturing' | 'stopped' | 'exported';
  workflowStatus: 'TARGET_OPENED' | 'LOGIN_REACHED' | 'KVM_REACHED';
  windowsOpen: boolean;
  storageLimited: boolean;
  windowsLabel: string;
  finalizing: boolean;
  counts: {
    httpTransactions: number;
    targets: number;
    channels: number;
    websocketChannels: number;
    actions: number;
  };
  bytesWritten: number;
  captureIntegrity: 'COMPLETE' | 'INCOMPLETE' | null;
  incompleteReasons: string[];
  recentFacts: Array<{ occurredAt: string; kind: string; text: string }>;
  diagnostics: {
    droppedEvents: number;
    droppedEventByMethod: Record<string, number>;
    gapCounts: Record<string, number>;
    storageLimitReached: boolean;
    observerHookFailures: Array<{ hook: string; stage: string; detail: string }>;
    channelGaps: string[];
    unsupportedChannels: string[];
    captureWindowLogTail: string[];
    disk: { freeBytes: number; marginBytes: number; ok: boolean } | null;
  };
}

interface StatusPayload {
  ok: true;
  job: StatusJob | null;
  export: { zipPath: string; fileName: string; status: { captureIntegrity: string } } | null;
  recovery: {
    kind: 'recovered' | 'exported' | 'discarded' | 'retained' | 'refused' | 'failed';
    jobId?: string;
    zipPath?: string;
    workspacePath?: string;
    reason?: string;
    error?: string;
    conservative?: boolean;
    workflowStatus?: string;
    targetUrl?: string;
    deviceLabel?: string;
    captureIntegrity?: string;
  } | null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

function formatTime(iso: string): string {
  const matched = /^(\d{2}:\d{2}:\d{2})/.exec(new Date(iso).toTimeString());
  return matched ? matched[1] : iso;
}

function gapTotal(job: StatusJob | null): number {
  if (!job) return 0;
  return Object.values(job.diagnostics.gapCounts).reduce((sum, count) => sum + count, 0);
}

export function App() {
  const [target, setTarget] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);

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

  async function start() {
    setLaunching(true);
    try {
      await run(() => window.kvmRecon!.startCapture(target, deviceLabel));
    } finally {
      setLaunching(false);
    }
  }

  function retainWorkspace() {
    if (!window.confirm('原始工作区将保留在本机，且不是已验证的 Capture Pack。保留后可以开始下一台。确定继续吗？')) return;
    void run(() => window.kvmRecon!.retainWorkspace());
  }

  const preloadMissing = typeof window !== 'undefined' && !window.kvmRecon?.startCapture;
  const job = status?.job ?? null;
  const recovery = status?.recovery ?? null;
  // 恢复作业待导出期间不能开始新作业（与恢复卡文案承诺一致，主进程同样拒绝）
  const canStart =
    !job && !busy && target.trim().length > 0 && !preloadMissing &&
    recovery?.kind !== 'recovered' && recovery?.kind !== 'refused' && recovery?.kind !== 'failed';
  const canStop = job?.state === 'capturing' && !busy;
  const canExport = job && job.state !== 'exported' && !busy;
  // 已导出作业可清理；零观察事实（无事务/通道/动作行）的已收尾作业也允许
  // 直接丢弃（主进程 checkUnexportedDiscard 门禁复核，界面只做宽判）
  const canDiscard =
    job &&
    !busy &&
    (job.state === 'exported' ||
      (job.state === 'stopped' &&
        job.counts.httpTransactions === 0 &&
        job.counts.channels === 0 &&
        job.counts.actions === 0));
  const canExportRecovered = recovery?.kind === 'recovered' && !busy;
  const canDiscardRecovered = canExportRecovered;
  const canReveal = job?.state === 'exported' && Boolean(status?.export) && !busy;

  const stage = derivePageStage({
    job: job
      ? {
          state: job.state,
          workflowStatus: job.workflowStatus,
          finalizing: job.finalizing,
          captureIntegrity: job.captureIntegrity,
        }
      : null,
    launching: launching && !job,
  });
  const bar = stageBarOf(stage);
  const exportLabel =
    job && job.state === 'stopped' && job.captureIntegrity !== 'COMPLETE' ? '导出未完整包' : '导出采集包';

  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="app-name">
          KVM-Recon <span className="mono">v{APP_VERSION}</span>
        </span>
        <span className="sensitive-badge" role="status">
          原始资料 · 未脱敏
        </span>
      </header>

      {preloadMissing ? (
        <p className="error-card" role="alert">
          <AlertTriangle size={14} aria-hidden /> 采集接口未加载：请使用 KVM-Recon 桌面应用打开本页面，不要用浏览器打开。
        </p>
      ) : null}

      {recovery ? (
        <div className="recovery-card" role="alert" aria-label="崩溃恢复结果">
          <h2>上次作业恢复</h2>
          {recovery.kind === 'recovered' ? (
            <>
              <p>
                上次未完成的作业 <code>{recovery.jobId}</code> 已恢复接管（
                {recovery.conservative ? '硬崩溃保守摘要' : '真实摘要'}
                {recovery.deviceLabel ? <> · 设备说明：{recovery.deviceLabel}</> : ''}
                {recovery.targetUrl ? <> · 目标 <code>{recovery.targetUrl}</code></> : ''}
                {recovery.workflowStatus ? ` · 恢复时派生：${recovery.workflowStatus}` : ''}
                ）。恢复不自动导出：请手动选择目录导出，导出完成前不能开始新的采集作业。
              </p>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void run(() => window.kvmRecon!.exportRecoveredCapture())}
                  disabled={!canExportRecovered}
                >
                  <Download size={14} aria-hidden /> 导出恢复作业
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void run(() => window.kvmRecon!.discardRecoveredCapture())}
                  disabled={!canDiscardRecovered}
                  title="仅确认没有任何已知现场证据时可丢弃；否则保留原始资料"
                >
                  丢弃恢复作业
                </button>
                <button type="button" className="secondary" onClick={retainWorkspace} disabled={busy} title="保留原始工作区并释放单作业入口">
                  <Archive size={14} aria-hidden /> 保留原始资料并继续
                </button>
              </div>
            </>
          ) : recovery.kind === 'exported' ? (
            <p>
              上次未完成的作业 {recovery.jobId} 已恢复并手动导出到 <code>{recovery.zipPath}</code>
              （{recovery.conservative ? '硬崩溃保守摘要' : '真实摘要'}，包为{' '}
              {recovery.captureIntegrity ?? '未知完整度'}）。
            </p>
          ) : recovery.kind === 'discarded' ? (
            <p>
              恢复作业 {recovery.jobId} 已丢弃：{recovery.reason}
            </p>
          ) : recovery.kind === 'retained' ? (
            <p>作业 {recovery.jobId} 的原始资料已保留在 <code>{recovery.workspacePath}</code>。这不是已验证的采集包。</p>
          ) : recovery.kind === 'refused' ? (
            <>
              <p>拒绝恢复作业 {recovery.jobId ?? ''}：{recovery.reason}</p>
              <button type="button" className="secondary" onClick={retainWorkspace} disabled={busy} title="保留原始工作区并释放单作业入口">
                <Archive size={14} aria-hidden /> 保留原始资料并继续
              </button>
            </>
          ) : (
            <>
              <p>恢复作业 {recovery.jobId ?? ''} 失败：{recovery.error}</p>
              <button type="button" className="secondary" onClick={() => void run(() => window.kvmRecon!.revealWorkspaceFolder())} disabled={busy} title="打开原始工作区供人工检查">
                <FolderOpen size={14} aria-hidden /> 打开原始资料目录
              </button>
            </>
          )}
        </div>
      ) : null}

      <section className="target-row" aria-label="新建采集作业">
        <label>
          BMC 地址
          <input
            value={target}
            onChange={event => setTarget(event.target.value)}
            placeholder="例如 10.10.8.111 或 https://10.10.8.111:8443"
            disabled={Boolean(job) || busy}
          />
        </label>
        <label>
          设备说明（可选）
          <input
            value={deviceLabel}
            onChange={event => setDeviceLabel(event.target.value)}
            placeholder="例如 Dell R740 / iDRAC9"
            disabled={Boolean(job) || busy}
          />
        </label>
        <button type="button" onClick={() => void start()} disabled={!canStart} title="开始采集">
          <Play size={14} aria-hidden /> 开始采集
        </button>
      </section>

      <section className="stage-bar" aria-label="采集阶段">
        {STAGE_BAR_STEPS.map((step, index) => (
          <span key={step} className={`stage-step stage-${bar[index]}`}>
            {step}
          </span>
        ))}
      </section>

      <section className="status-line" aria-label="当前状态" role="status">
        <span className="status-label">{stageStatusText(stage)}</span>
        {job ? <> · <code>{job.jobId}</code></> : null}
        {job && job.state === 'capturing' && !job.windowsOpen ? ' · 采集窗口已关闭（可停止收尾）' : ''}
      </section>

      {job && job.state === 'stopped' && job.incompleteReasons.length > 0 ? (
        <section className="incomplete-reasons" aria-label="完整度缺失明细">
          <h3>
            <AlertTriangle size={14} aria-hidden /> 采集不完整：{job.incompleteReasons.length} 项原因
          </h3>
          <ul>
            {job.incompleteReasons.map(reason => (
              <li key={reason}>
                <code>{reason}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {job?.storageLimited ? (
        <p className="error-card" role="alert">
          <AlertTriangle size={14} aria-hidden /> 磁盘水位已触发（storageLimited），包完整性不保证 COMPLETE。
        </p>
      ) : null}

      <section className="counters" aria-label="采集计数">
        <span>
          HTTP <span className="mono counter">{job?.counts.httpTransactions ?? 0}</span>
        </span>
        <span>
          Targets <span className="mono counter">{job?.counts.targets ?? 0}</span>
        </span>
        <span>
          WS <span className="mono counter">{job?.counts.websocketChannels ?? 0}</span>
        </span>
        <span>
          已写入 <span className="mono counter">{formatBytes(job?.bytesWritten ?? 0)}</span>
        </span>
        <span>
          缺失 <span className="mono counter">{gapTotal(job)}</span>
        </span>
      </section>

      <section className="recent-facts" aria-label="最近事实">
        <h3>最近事实</h3>
        {job && job.recentFacts.length > 0 ? (
          <ul className="facts-list">
            {job.recentFacts.map((fact, index) => (
              <li key={`${fact.occurredAt}-${index}`}>
                <span className="mono fact-time">{formatTime(fact.occurredAt)}</span> {fact.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">暂无事实记录。</p>
        )}
      </section>

      <footer className="action-bar">
        <details className="advanced-diagnostics">
          <summary>
            <Activity size={14} aria-hidden /> 高级诊断
          </summary>
          <div className="diagnostics-body">
            {job ? (
              <>
                <dl>
                  <dt>缺口分类</dt>
                  <dd>
                    {Object.entries(job.diagnostics.gapCounts).length > 0
                      ? Object.entries(job.diagnostics.gapCounts)
                          .map(([key, count]) => `${key}×${count}`)
                          .join('、')
                      : '无'}
                  </dd>
                  <dt>丢弃事件</dt>
                  <dd>
                    {job.diagnostics.droppedEvents === 0
                      ? '无'
                      : `${job.diagnostics.droppedEvents}（${Object.entries(job.diagnostics.droppedEventByMethod)
                          .map(([method, count]) => `${method}×${count}`)
                          .join('、')}）`}
                  </dd>
                  <dt>观察脚本钩子失败</dt>
                  <dd>
                    {job.diagnostics.observerHookFailures.length === 0
                      ? '无'
                      : job.diagnostics.observerHookFailures
                          .map(failure => `${failure.hook}/${failure.stage}：${failure.detail}`)
                          .join('；')}
                  </dd>
                  <dt>通道断档</dt>
                  <dd>{job.diagnostics.channelGaps.length === 0 ? '无' : job.diagnostics.channelGaps.join('；')}</dd>
                  <dt>不受支持通道</dt>
                  <dd>
                    {job.diagnostics.unsupportedChannels.length === 0
                      ? '无'
                      : job.diagnostics.unsupportedChannels.join('；')}
                  </dd>
                  <dt>磁盘信息</dt>
                  <dd>
                    {job.diagnostics.disk
                      ? `剩余 ${formatBytes(job.diagnostics.disk.freeBytes)}（安全余量 ${formatBytes(job.diagnostics.disk.marginBytes)}）`
                      : '不可用'}
                  </dd>
                </dl>
                {job.diagnostics.captureWindowLogTail.length > 0 ? (
                  <pre className="log-tail">{job.diagnostics.captureWindowLogTail.join('\n')}</pre>
                ) : null}
              </>
            ) : (
              <p className="muted">空闲：暂无诊断信息。</p>
            )}
          </div>
        </details>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void run(() => window.kvmRecon!.stopCapture())}
            disabled={!canStop}
            title="停止并收尾"
          >
            停止并收尾
          </button>
          <button
            type="button"
            onClick={() => void run(() => window.kvmRecon!.exportCapture())}
            disabled={!canExport}
            title={exportLabel}
          >
            <Download size={14} aria-hidden /> {exportLabel}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void run(() => window.kvmRecon!.revealExportFolder())}
            disabled={!canReveal}
            title="打开所在文件夹"
          >
            <FolderOpen size={14} aria-hidden /> 打开所在文件夹
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void run(() => window.kvmRecon!.discardCapture())}
            disabled={!canDiscard}
            title="采集下一台（清理本作业临时目录）"
          >
            采集下一台
          </button>
          {job?.state === 'stopped' ? (
            <button type="button" className="secondary" onClick={retainWorkspace} disabled={busy} title="保留原始工作区并释放单作业入口">
              <Archive size={14} aria-hidden /> 保留原始资料并继续
            </button>
          ) : null}
        </div>
      </footer>

      {error ? (
        <p className="error-card" role="alert">
          {error}
        </p>
      ) : null}

      {status?.export ? (
        <p className="export-summary">
          已导出：<code>{status.export.zipPath}</code>（{status.export.status.captureIntegrity}）
        </p>
      ) : null}
    </div>
  );
}
