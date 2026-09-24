import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Archive, ArrowRight, Check, ChevronDown, Circle, Download, FolderOpen, LoaderCircle, Play, ShieldAlert, Square, X } from 'lucide-react';

import { APP_VERSION } from '../version';
import brandMark from './assets/brand-mark.png';
import { INCOMPLETE_REASON_CODES, incompleteReasonInfo, type IncompleteReasonInfo } from '../core/capture-pack-v2/incompleteReasons';
import type { IncompleteReasonCode } from '../core/capture-pack-v2/types';
import { STAGE_BAR_STEPS, derivePageStage, stageBarOf, stageHintText, stageStatusText, stageToneOf } from './stage';

/** 单作业采集工作台；导出始终由用户在收尾后手动触发。 */

export interface StatusJob {
  jobId: string;
  state: 'capturing' | 'stopped' | 'exported';
  workflowStatus: 'TARGET_OPENED' | 'LOGIN_REACHED' | 'KVM_REACHED';
  windowsOpen: boolean;
  storageLimited: boolean;
  windowsLabel: string;
  targetLabel: string;
  targetUrl: string;
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
    discardable?: boolean;
    discardNote?: string;
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

/** 载荷里的原因码是字符串；未登记的代码只显示原码，不编造说明。 */
function reasonInfoOf(code: string): IncompleteReasonInfo | null {
  return (INCOMPLETE_REASON_CODES as readonly string[]).includes(code)
    ? incompleteReasonInfo(code as IncompleteReasonCode)
    : null;
}

function Counter({ label, value, tone }: { label: string; value: string | number; tone?: 'success' | 'failure' }) {
  return (
    <div className="counter-cell">
      <span className="counter-label">{label}</span>
      <span className={`counter-value${tone ? ` tone-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

export function App() {
  const [target, setTarget] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);

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
  // 已处理完的恢复结果（导出 / 丢弃 / 保留）只是提示，可以关闭；待处理的恢复卡不可关闭
  const recoveryResolved =
    recovery?.kind === 'exported' || recovery?.kind === 'discarded' || recovery?.kind === 'retained';
  const noticeKey = recovery
    ? `${recovery.kind}:${recovery.jobId ?? ''}:${recovery.zipPath ?? recovery.workspacePath ?? ''}`
    : null;
  const shownRecovery = recovery && !(recoveryResolved && dismissedNotice === noticeKey) ? recovery : null;
  // 恢复作业待导出期间不能开始新作业（与恢复卡文案承诺一致，主进程同样拒绝）
  const canStart =
    !job && !busy && target.trim().length > 0 && !preloadMissing &&
    recovery?.kind !== 'recovered' && recovery?.kind !== 'refused' && recovery?.kind !== 'failed';
  const canStop = job?.state === 'capturing' && !job.finalizing && !busy;
  const canExport = job?.state === 'stopped' && !busy;
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
  // 主进程恢复时已跑只读丢弃门禁；有现场证据时直接置灰，点击时主进程仍会复核
  const canDiscardRecovered = canExportRecovered && recovery?.discardable === true;
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
  const incompleteFinalStep = (stage === 'incomplete' || stage === 'exported') && job?.captureIntegrity !== 'COMPLETE';
  const exportLabel =
    job && job.state === 'stopped' && job.captureIntegrity !== 'COMPLETE' ? '导出未完整包' : '导出采集包';
  const tone = stageToneOf(stage, status?.export?.status.captureIntegrity ?? null);
  // 作业标题以主进程下发为准：渲染层刷新后本地输入框的值已丢失
  const shownTarget = job?.targetLabel || target.trim();
  const shownDeviceLabel = job?.windowsLabel || deviceLabel.trim();
  // 载荷按时间升序；内部滚动的 feed 最新在上，不用滚到底才能看到新事实
  const facts = job ? [...job.recentFacts].reverse() : [];
  const missing = gapTotal(job);
  const websockets = job?.counts.websocketChannels ?? 0;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="brand">
          <img className="brand-mark" src={brandMark} alt="" aria-hidden="true" />
          <span className="app-name">KVM-Recon</span>
          <span className="app-version">v{APP_VERSION}</span>
        </span>
        <span className="sensitive-badge" role="status">
          <ShieldAlert size={15} aria-hidden /> 原始资料 · 未脱敏
        </span>
      </header>

      {preloadMissing ? (
        <p className="error-card" role="alert">
          <AlertTriangle size={14} aria-hidden /> 采集接口未加载：请使用 KVM-Recon 桌面应用打开本页面，不要用浏览器打开。
        </p>
      ) : null}

      {shownRecovery ? (
        <div className={`recovery-card${recoveryResolved ? ' is-resolved' : ''}`} role="alert" aria-label="崩溃恢复结果">
          <div className="recovery-head">
            <h2>{recoveryResolved ? '作业已处理' : '上次作业恢复'}</h2>
            {recoveryResolved ? (
              <button type="button" className="icon-button" onClick={() => setDismissedNotice(noticeKey)} title="关闭提示" aria-label="关闭提示">
                <X size={16} aria-hidden />
              </button>
            ) : null}
          </div>
          {shownRecovery.kind === 'recovered' ? (
            <>
              <p>
                上次未完成的作业 <code>{shownRecovery.jobId}</code> 已恢复接管（
                {shownRecovery.conservative ? '硬崩溃保守摘要' : '真实摘要'}
                {shownRecovery.deviceLabel ? <> · 设备说明：{shownRecovery.deviceLabel}</> : ''}
                {shownRecovery.targetUrl ? <> · 目标 <code>{shownRecovery.targetUrl}</code></> : ''}
                {shownRecovery.workflowStatus ? ` · 恢复时派生：${shownRecovery.workflowStatus}` : ''}
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
                  title={shownRecovery.discardNote ?? '仅确认没有任何已知现场证据时可丢弃；否则保留原始资料'}
                >
                  丢弃恢复作业
                </button>
                <button type="button" className="secondary" onClick={retainWorkspace} disabled={busy} title="保留原始工作区并释放单作业入口">
                  <Archive size={14} aria-hidden /> 保留原始资料并继续
                </button>
              </div>
              {shownRecovery.discardable === false && shownRecovery.discardNote ? (
                <p className="recovery-note">不能直接丢弃：{shownRecovery.discardNote}</p>
              ) : null}
            </>
          ) : shownRecovery.kind === 'exported' ? (
            <p>
              上次未完成的作业 {shownRecovery.jobId} 已恢复并手动导出到 <code>{shownRecovery.zipPath}</code>
              （{shownRecovery.conservative ? '硬崩溃保守摘要' : '真实摘要'}，包为{' '}
              {shownRecovery.captureIntegrity ?? '未知完整度'}）。
            </p>
          ) : shownRecovery.kind === 'discarded' ? (
            <p>
              恢复作业 {shownRecovery.jobId} 已丢弃：{shownRecovery.reason}
            </p>
          ) : shownRecovery.kind === 'retained' ? (
            <p>作业 {shownRecovery.jobId} 的原始资料已保留在 <code>{shownRecovery.workspacePath}</code>。这不是已验证的采集包。</p>
          ) : shownRecovery.kind === 'refused' ? (
            <>
              <p>拒绝恢复作业 {shownRecovery.jobId ?? ''}：{shownRecovery.reason}</p>
              <button type="button" className="secondary" onClick={retainWorkspace} disabled={busy} title="保留原始工作区并释放单作业入口">
                <Archive size={14} aria-hidden /> 保留原始资料并继续
              </button>
            </>
          ) : (
            <>
              <p>恢复作业 {shownRecovery.jobId ?? ''} 失败：{shownRecovery.error}</p>
              <button type="button" className="secondary" onClick={() => void run(() => window.kvmRecon!.revealWorkspaceFolder())} disabled={busy} title="打开原始工作区供人工检查">
                <FolderOpen size={14} aria-hidden /> 打开原始资料目录
              </button>
            </>
          )}
        </div>
      ) : null}

      {job ? (
        <section className="job-header" aria-label="当前作业">
          <div className="job-subject">
            <span className="job-field">
              <span className="job-field-label">BMC</span>
              <span className="job-target" title={job.targetUrl}>{shownTarget || '—'}</span>
            </span>
            <span className="job-field">
              <span className="job-field-label">设备</span>
              <span className={shownDeviceLabel ? 'job-device' : 'job-device muted'}>{shownDeviceLabel || '未填写设备说明'}</span>
            </span>
          </div>
          <span className="job-id">
            作业 <code>{job.jobId}</code>
          </span>
        </section>
      ) : null}

      <section className={`status-panel tone-${tone}`} aria-label="当前状态">
        <div className="status-head">
          <div className="status-copy" role="status">
            <h1 className="status-title">{stageStatusText(stage)}</h1>
            <p className="status-hint">{stageHintText(stage)}</p>
            {job && job.state === 'capturing' && !job.windowsOpen ? (
              <p className="status-note">
                <AlertTriangle size={15} aria-hidden /> 采集窗口已关闭，可以停止并收尾。
              </p>
            ) : null}
          </div>

          {job ? (
            <div className="primary-actions" aria-label="作业操作">
              {job.state === 'capturing' ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void run(() => window.kvmRecon!.stopCapture())}
                  disabled={!canStop}
                  title="停止并收尾"
                >
                  <Square size={15} aria-hidden /> 停止并收尾
                </button>
              ) : null}
              {job.state === 'stopped' && canDiscard ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void run(() => window.kvmRecon!.discardCapture())}
                  disabled={busy}
                  title="清理本作业临时目录并采集下一台"
                >
                  <ArrowRight size={15} aria-hidden /> 舍弃空作业并继续
                </button>
              ) : null}
              {job.state === 'stopped' ? (
                <button
                  type="button"
                  onClick={() => void run(() => window.kvmRecon!.exportCapture())}
                  disabled={!canExport}
                  title={exportLabel}
                >
                  <Download size={16} aria-hidden /> {exportLabel}
                </button>
              ) : null}
              {job.state === 'exported' && canReveal ? (
                <button type="button" className="secondary" onClick={() => void run(() => window.kvmRecon!.revealExportFolder())} title="打开所在文件夹">
                  <FolderOpen size={15} aria-hidden /> 打开所在文件夹
                </button>
              ) : null}
              {job.state === 'exported' && canDiscard ? (
                <button
                  type="button"
                  onClick={() => void run(() => window.kvmRecon!.discardCapture())}
                  disabled={busy}
                  title="清理本作业临时目录并采集下一台"
                >
                  <ArrowRight size={16} aria-hidden /> 采集下一台
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {!job ? (
          <form
            className="target-row"
            aria-label="新建采集作业"
            onSubmit={event => {
              event.preventDefault();
              if (canStart) void start();
            }}
          >
            <label>
              BMC 地址
              <input
                className="target-input"
                value={target}
                onChange={event => setTarget(event.target.value)}
                placeholder="例如 10.10.8.111 或 https://10.10.8.111:8443"
                disabled={busy}
                spellCheck={false}
                autoFocus
              />
            </label>
            <label>
              设备说明（可选）
              <input
                value={deviceLabel}
                onChange={event => setDeviceLabel(event.target.value)}
                placeholder="例如 Dell R740 / iDRAC9"
                disabled={busy}
              />
            </label>
            <button type="submit" disabled={!canStart} title="开始采集">
              {launching ? <LoaderCircle size={16} className="spin" aria-hidden /> : <Play size={16} aria-hidden />} 开始采集
            </button>
          </form>
        ) : null}

        <div className="stage-bar" aria-label="采集阶段">
          {STAGE_BAR_STEPS.map((step, index) => {
            const state = incompleteFinalStep && index === 3 ? 'warning' : bar[index];
            return (
              <span key={step} className={`stage-step stage-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="stage-marker" aria-hidden="true">
                  {state === 'done' ? <Check size={17} /> : state === 'warning' ? <AlertTriangle size={16} /> : state === 'active' ? <LoaderCircle size={16} /> : <Circle size={12} />}
                </span>
                <span className="stage-name">{step}</span>
              </span>
            );
          })}
        </div>

        {error ? (
          <p className="panel-alert" role="alert">
            <AlertTriangle size={15} aria-hidden /> <span>{error}</span>
          </p>
        ) : null}

        {job?.storageLimited ? (
          <p className="panel-alert" role="alert">
            <AlertTriangle size={15} aria-hidden /> <span>磁盘水位已触发（storageLimited），包完整性不保证 COMPLETE。</span>
          </p>
        ) : null}

        {job && job.state === 'stopped' && job.incompleteReasons.length > 0 ? (
          <div className="incomplete-reasons" aria-label="完整度缺失明细">
            <h3>
              <AlertTriangle size={15} aria-hidden /> 采集不完整：{job.incompleteReasons.length} 项原因
            </h3>
            <ul>
              {job.incompleteReasons.map(reason => {
                const info = reasonInfoOf(reason);
                return (
                  <li key={reason}>
                    <div className="reason-head">
                      <span className="reason-title">{info?.title ?? '未登记的原因'}</span>
                      <code className="reason-code">{reason}</code>
                    </div>
                    {info ? <p className="reason-summary">{info.summary}</p> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {status?.export ? (
          <p className="export-path">
            已导出：<code>{status.export.zipPath}</code>（{status.export.status.captureIntegrity}）
          </p>
        ) : null}
      </section>

      <section className="counters" aria-label="采集计数">
        <Counter label="HTTP" value={job?.counts.httpTransactions ?? 0} />
        <Counter label="目标" value={job?.counts.targets ?? 0} />
        <Counter label="WS" value={websockets} tone={websockets > 0 ? 'success' : undefined} />
        <Counter label="已写入" value={formatBytes(job?.bytesWritten ?? 0)} />
        <Counter label="缺失" value={missing} tone={missing > 0 ? 'failure' : undefined} />
      </section>

      <section className={`recent-facts${job ? '' : ' is-idle'}`} aria-label="最近事实">
        <h3>
          最近事实
          {facts.length > 0 ? <span className="section-meta">最新在上</span> : null}
        </h3>
        {facts.length > 0 ? (
          <ul className="facts-list">
            {facts.map((fact, index) => (
              <li key={`${fact.occurredAt}-${index}`}>
                <span className="fact-time">{formatTime(fact.occurredAt)}</span>
                <span className="fact-text">{fact.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="facts-empty">
            {job ? '暂无事实记录。' : '开始采集后，这里会实时显示窗口挂载、页面导航和通道建立等事实。'}
          </p>
        )}
      </section>

      <AdvancedDiagnostics job={job} busy={busy} onRetain={retainWorkspace} />
    </div>
  );
}

/**
 * 高级诊断：默认折叠；空闲时展开只有一句说明，不参与高度分摊。
 * 用受控折叠而不是 <details>：有作业时展开要作为 flex 子项与最近事实分摊剩余高度，
 * 保证页面只有并排的两个滚动区域，不出现嵌套滚动。
 */
export function AdvancedDiagnostics({ job, busy, onRetain }: { job: StatusJob | null; busy: boolean; onRetain: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`advanced-diagnostics${open ? ' is-open' : ''}${job ? '' : ' is-idle'}`} aria-label="高级诊断">
      <button
        type="button"
        className="diagnostics-toggle"
        aria-expanded={open}
        aria-controls={open ? 'diagnostics-body' : undefined}
        onClick={() => setOpen(value => !value)}
      >
        <span><Activity size={14} aria-hidden /> 高级诊断</span>
        <ChevronDown size={15} className="diagnostics-chevron" aria-hidden="true" />
      </button>
      {open && !job ? (
        <div id="diagnostics-body" className="diagnostics-body">
          <p className="muted">开始采集后，这里显示缺口、丢弃事件、磁盘余量和采集窗口日志。</p>
        </div>
      ) : null}
      {open && job ? (
        <div id="diagnostics-body" className="diagnostics-body">
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
          {job.state === 'stopped' ? (
            <button type="button" className="secondary retain-button" onClick={onRetain} disabled={busy} title="保留原始工作区并释放单作业入口">
              <Archive size={14} aria-hidden /> 保留原始资料并继续
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
