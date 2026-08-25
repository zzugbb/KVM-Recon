import { useEffect, useRef, useState } from 'react';

import type { CaptureReadiness, ChecklistItem } from '../core/capture-pack/types';
import type { CapturePackComparison, CapturePackSummary } from '../core/capture-pack/summarizeCapturePack';
import type { ScreenshotRole } from '../core/browser/browserCaptureCore';
import type { CaptureJobSummary } from '../core/delivery/captureJob';
import { MAX_CAPTURE_JOBS } from '../core/delivery/captureJob';
import { createEmptyCapturePack } from '../core/capture-pack/createEmptyCapturePack';
import { buildLiveCaptureSnapshot } from '../core/delivery/buildLiveCaptureSnapshot';
import { APP_VERSION } from '../version';
import {
  jobRowStatus,
  nextStepText,
  phaseLabel,
  type CapturePhase,
} from './captureStatus';
import { readReadmePreview } from './readmePreview';

interface FormattedCaptureError {
  title: string;
  impact: string;
  action: string;
  detail: string;
}

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
const readmePreview = readReadmePreview();

function displayedAppVersion() {
  if (typeof window !== 'undefined' && window.kvmRecon?.appVersion) {
    return window.kvmRecon.appVersion;
  }
  return APP_VERSION;
}

const PRELOAD_MISSING_ERROR: FormattedCaptureError = {
  title: '采集接口未加载',
  impact: '主界面预加载脚本没有生效，采集、导出、打开和对比 Capture Pack 都不可用。',
  action:
    '请使用 GitHub Releases 安装包启动本应用，不要用浏览器打开页面。若已是安装包（含 v0.2.0），请改用修复预加载脚本后的新版本。这与有没有 Capture Pack 无关。',
  detail: '',
};

function statusText(status: string) {
  if (status === 'pass') return '已采集';
  if (status === 'needs_user_action') return '待现场操作';
  if (status === 'missing') return '缺失';
  if (status === 'unknown') return '未知';
  if (status === 'not_applicable') return '不适用';
  return status;
}

function formatSummaryValue(value: string | number | string[]) {
  if (Array.isArray(value)) return value.join(', ') || '无';
  if (value === '' || value === 0) return String(value);
  return String(value);
}

export function App() {
  const [host, setHost] = useState(readmePreview?.host ?? '10.0.0.10');
  const [port, setPort] = useState(readmePreview?.port ?? '443');
  const [operatorNote, setOperatorNote] = useState(readmePreview?.operatorNote ?? '');
  const [vendor, setVendor] = useState(readmePreview?.vendor ?? '');
  const [product, setProduct] = useState(readmePreview?.product ?? '');
  const [firmware, setFirmware] = useState(readmePreview?.firmware ?? '');
  const [location, setLocation] = useState(readmePreview?.location ?? '');
  const [phase, setPhase] = useState<CapturePhase>(readmePreview?.phase ?? 'idle');
  const [jobId, setJobId] = useState(readmePreview?.jobId ?? '');
  const [jobs, setJobs] = useState<CaptureJobSummary[]>(readmePreview?.jobs ?? []);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<FormattedCaptureError | null>(null);
  const [readiness, setReadiness] = useState(readmePreview?.readiness ?? previewPack.manifest.readiness.status);
  const [progressItems, setProgressItems] = useState<ChecklistItem[]>(
    readmePreview?.progressItems ?? emptySnapshot.items,
  );
  const [screenshotRole, setScreenshotRole] = useState<ScreenshotRole>('viewer');
  const [windowsOpen, setWindowsOpen] = useState(readmePreview?.windowsOpen ?? false);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const snapshotBusy = useRef(false);
  const [packSummary, setPackSummary] = useState<CapturePackSummary | null>(null);
  const [packPath, setPackPath] = useState('');
  const [exportFileName, setExportFileName] = useState('');
  const [packComparison, setPackComparison] = useState<CapturePackComparison | null>(null);

  function applyJobs(nextJobs?: CaptureJobSummary[]) {
    if (nextJobs) {
      setJobs(nextJobs);
    }
  }

  function applySnapshot(snapshot: {
    readiness: CaptureReadiness;
    items: ChecklistItem[];
    windowsOpen?: boolean;
    paused?: boolean;
    capturingScreenshot?: boolean;
    jobs?: CaptureJobSummary[];
  }) {
    setReadiness(snapshot.readiness);
    setProgressItems(snapshot.items);
    if (typeof snapshot.windowsOpen === 'boolean') {
      setWindowsOpen(snapshot.windowsOpen);
    }
    if (typeof snapshot.paused === 'boolean') {
      setPaused(snapshot.paused);
    }
    setCapturingScreenshot(Boolean(snapshot.capturingScreenshot));
    applyJobs(snapshot.jobs);
  }

  function applySelectedJob(nextJobId: string, nextJobs = jobs) {
    const selected = nextJobs.find(job => job.jobId === nextJobId);
    setJobId(nextJobId);
    if (!selected) {
      setPhase('idle');
      setWindowsOpen(false);
      setPaused(false);
      setExportFileName('');
      return;
    }
    setPhase(selected.exported ? 'exported' : 'capturing');
    setWindowsOpen(selected.windowsOpen);
    setPaused(selected.paused);
    setReadiness(selected.readiness);
    if (!selected.exported) {
      setExportFileName('');
    }
  }

  async function refreshSnapshot(nextJobId = jobId) {
    if (!nextJobId || !window.kvmRecon?.getCaptureSnapshot) return;
    const result = await window.kvmRecon.getCaptureSnapshot(nextJobId);
    if (result.ok) applySnapshot(result);
  }

  async function refreshJobs() {
    if (!window.kvmRecon?.listCaptureJobs) return;
    const result = await window.kvmRecon.listCaptureJobs();
    if (result.ok) applyJobs(result.jobs);
  }

  useEffect(() => {
    if (!jobId && jobs.length === 0) return undefined;
    let cancelled = false;

    async function tick() {
      if (snapshotBusy.current) return;
      snapshotBusy.current = true;
      try {
        if (!cancelled) await refreshSnapshot(jobId);
        if (!cancelled) await refreshJobs();
      } finally {
        snapshotBusy.current = false;
      }
    }

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, jobs.length]);

  async function startCapture() {
    const numericPort = Number(port) || 443;
    setError(null);
    if (!host.trim()) {
      setError({
        title: '未填写 BMC 地址',
        impact: '无法开始采集。',
        action: '请输入目标 BMC 的 IP 或主机名后再新建采集作业。',
        detail: '',
      });
      return;
    }
    if (!window.kvmRecon?.startCapture) {
      setError(PRELOAD_MISSING_ERROR);
      return;
    }

    const result = await window.kvmRecon.startCapture({
      host,
      port: numericPort,
      scheme: 'https',
      operatorNote,
      operatorObserved: {
        vendor,
        product,
        firmware,
        location,
        note: operatorNote,
      },
    });
    if (!result.ok) {
      setError(result.error);
      setMessage('');
      return;
    }
    applyJobs(result.jobs);
    applySelectedJob(result.jobId, result.jobs);
    applySnapshot(result.snapshot);
    setExportFileName('');
    setMessage(`采集窗口已打开：${result.jobId}`);
  }

  async function stopCaptureWindows() {
    setError(null);
    if (!jobId || !window.kvmRecon?.stopCapture) {
      setError({
        title: '尚未开始采集',
        impact: '当前没有可关闭的采集窗口。',
        action: '请先点击“新建采集作业”，打开 BMC 后再关闭采集窗口。',
        detail: '',
      });
      return;
    }
    const result = await window.kvmRecon.stopCapture(jobId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    applySnapshot(result);
    setWindowsOpen(false);
    setMessage('采集窗口已关闭，作业数据仍保留，可继续导出 Capture Pack。');
  }

  async function togglePause() {
    setError(null);
    if (!jobId) return;
    const api = paused ? window.kvmRecon?.resumeCapture : window.kvmRecon?.pauseCapture;
    if (!api) return;
    const result = await api(jobId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    applySnapshot(result);
    setMessage(paused ? '已继续记录 HTTP / WebSocket / 点击。' : '已暂停记录，采集窗口仍保持打开。');
  }

  async function closeSelectedJob(targetJobId = jobId) {
    setError(null);
    const job = jobs.find(item => item.jobId === targetJobId);
    if (job && !job.exported) {
      const confirmed = window.confirm('该作业尚未导出，关闭后未导出资料会丢失。确定关闭？');
      if (!confirmed) return;
    }
    if (!targetJobId || !window.kvmRecon?.closeCaptureJob) return;
    const result = await window.kvmRecon.closeCaptureJob(targetJobId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    applyJobs(result.jobs);
    const next = result.jobs[result.jobs.length - 1];
    if (next) {
      applySelectedJob(next.jobId, result.jobs);
      await refreshSnapshot(next.jobId);
      setMessage(`已关闭作业 ${targetJobId}`);
      return;
    }
    setJobId('');
    setPhase('idle');
    setWindowsOpen(false);
    setPaused(false);
    setExportFileName('');
    applySnapshot(emptySnapshot);
    setMessage(`已关闭作业 ${targetJobId}`);
  }

  async function selectJob(nextJobId: string) {
    applySelectedJob(nextJobId);
    await refreshSnapshot(nextJobId);
  }

  async function refreshProbeAfterLogin() {
    setError(null);
    if (!jobId || !window.kvmRecon?.refreshCaptureProbe) {
      setError({
        title: '尚未开始采集',
        impact: '当前没有可复验的探测作业。',
        action: '请先登录 BMC，再点击“登录后复验探测”。',
        detail: '',
      });
      return;
    }
    const result = await window.kvmRecon.refreshCaptureProbe(jobId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    applySnapshot(result);
    setMessage('已用当前浏览器会话复验 BMC 指纹，Cookie 值不会写入导出包。');
  }

  async function collectCurrentPage() {
    setError(null);
    if (!jobId || !window.kvmRecon?.collectCapturePage) {
      setError({
        title: '尚未开始采集',
        impact: '当前没有可补采的页面。',
        action: '请先点击“新建采集作业”，打开 BMC 后再补拍画面。',
        detail: '',
      });
      return;
    }
    const result = await window.kvmRecon.collectCapturePage(jobId, screenshotRole);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    applySnapshot(result);
    setMessage('已采集当前画面。登录和 KVM 流量仍在自动记录，就绪后请导出。');
  }

  async function exportCapture() {
    setError(null);
    if (!window.kvmRecon?.exportCapture) {
      setError(PRELOAD_MISSING_ERROR);
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
    applyJobs(result.jobs);
    setPhase('exported');
    setWindowsOpen(false);
    setReadiness(result.readiness);
    setExportFileName(result.fileName);
    setMessage(`已导出：${result.fileName}`);
    await refreshSnapshot(jobId);
  }

  async function openCapturePack() {
    setError(null);
    if (!window.kvmRecon?.chooseCapturePack || !window.kvmRecon.summarizeCapturePack) {
      setError(PRELOAD_MISSING_ERROR);
      return;
    }
    const chosen = await window.kvmRecon.chooseCapturePack();
    if (!chosen.ok) {
      if (chosen.canceled) setMessage('已取消打开 Capture Pack。');
      return;
    }
    const result = await window.kvmRecon.summarizeCapturePack(chosen.filePath);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPackSummary(result.summary);
    setPackPath(result.filePath);
    setPackComparison(null);
    setMessage(`已打开 Capture Pack：${result.filePath}`);
  }

  async function compareOpenedPacks() {
    setError(null);
    if (!window.kvmRecon?.chooseCapturePack || !window.kvmRecon.compareCapturePacks) {
      setError(PRELOAD_MISSING_ERROR);
      return;
    }
    const left = await window.kvmRecon.chooseCapturePack();
    if (!left.ok) {
      if (left.canceled) setMessage('已取消对比。');
      return;
    }
    const right = await window.kvmRecon.chooseCapturePack();
    if (!right.ok) {
      if (right.canceled) setMessage('已取消对比。');
      return;
    }
    const result = await window.kvmRecon.compareCapturePacks(left.filePath, right.filePath);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPackComparison(result.comparison);
    setPackSummary(result.comparison.left);
    setPackPath(result.leftPath);
    setMessage('已完成本地对比，未调用公网。');
  }

  const selectedJob = jobs.find(job => job.jobId === jobId);
  const nextStep = nextStepText({
    phase,
    readiness,
    items: progressItems,
    capturingScreenshot,
    paused,
    windowsOpen,
    exportFileName,
  });

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Offline BMC/KVM Discovery Toolkit</p>
        <div className="hero-heading">
          <h1>KVM-Recon</h1>
          <span className="app-version" title="工具版本，与导出包 manifest.tool.version 一致">
            v{displayedAppVersion()}
          </span>
        </div>
        <p className="subtitle">离线 BMC/KVM 资料采集工具</p>
        <p className="description">
          在机房内采集登录、HTML5 KVM 入口、HTTP/WebSocket、页面截图和离场验收资料，
          导出脱敏 Capture Pack 供后续兼容性分析。
        </p>
        <p className="phase-label">{phaseLabel(phase, readiness, paused)}</p>
        <div className="target-form">
          <div className="field-row field-row-primary">
            <label>
              BMC 地址
              <input value={host} onChange={event => setHost(event.target.value)} />
            </label>
            <label>
              端口
              <input value={port} onChange={event => setPort(event.target.value)} />
            </label>
          </div>
          <div className="field-row field-row-pair">
            <label>
              现场厂商
              <input
                value={vendor}
                onChange={event => setVendor(event.target.value)}
                placeholder="铭牌，不作为 kvmFamily"
              />
            </label>
            <label>
              现场型号
              <input
                value={product}
                onChange={event => setProduct(event.target.value)}
                placeholder="可选"
                title={product}
              />
            </label>
          </div>
          <div className="field-row field-row-pair">
            <label>
              现场固件
              <input
                value={firmware}
                onChange={event => setFirmware(event.target.value)}
                placeholder="可选"
              />
            </label>
            <label>
              机柜位置
              <input
                value={location}
                onChange={event => setLocation(event.target.value)}
                placeholder="可选"
              />
            </label>
          </div>
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
          <button type="button" className={phase === 'idle' ? undefined : 'secondary'} onClick={startCapture} disabled={jobs.length >= MAX_CAPTURE_JOBS}>
            新建采集作业
          </button>
          <button
            type="button"
            className="secondary"
            onClick={togglePause}
            disabled={!jobId || !windowsOpen}
          >
            {paused ? '继续采集' : '暂停采集'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={stopCaptureWindows}
            disabled={phase !== 'capturing' || !windowsOpen}
          >
            关闭采集窗口
          </button>
          <button
            type="button"
            className="secondary"
            onClick={refreshProbeAfterLogin}
            disabled={!jobId || phase === 'idle'}
          >
            登录后复验探测
          </button>
          <button
            type="button"
            className={readiness === 'YES' && phase !== 'exported' ? undefined : 'secondary'}
            onClick={exportCapture}
            disabled={!jobId}
          >
            {phase === 'exported' ? '再次导出' : readiness === 'YES' ? '导出 Capture Pack' : '停止采集并导出'}
          </button>
        </div>
        <p className="next-step">{nextStep}</p>
        <div className="actions-extra">
          <span className="actions-extra-label">补拍画面（可选）</span>
          <select
            value={screenshotRole}
            onChange={event => setScreenshotRole(event.target.value as ScreenshotRole)}
            disabled={phase !== 'capturing' || !windowsOpen || capturingScreenshot}
            aria-label="补拍画面类型"
            title="只给手动补拍打标签，不影响自动采集"
          >
            <option value="viewer">KVM 画面</option>
            <option value="login">登录页</option>
            <option value="home">登录后首页</option>
            <option value="kvm-entry">点 KVM 的菜单页</option>
            <option value="error">异常画面</option>
          </select>
          <button
            type="button"
            className="secondary"
            onClick={collectCurrentPage}
            disabled={phase !== 'capturing' || !windowsOpen || capturingScreenshot}
          >
            {capturingScreenshot ? '正在截图…' : '采集当前画面'}
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
        {selectedJob ? (
          <p>
            当前作业 {selectedJob.jobId} · {selectedJob.host}:{selectedJob.port} · {jobRowStatus(selectedJob)}
          </p>
        ) : null}
        <div className="progress-list" aria-label="Capture progress">
          <h2>采集进度</h2>
          <ul>
            {progressItems.map(item => (
              <li key={item.id}>
                <span>{item.title}</span>
                <strong>{statusText(item.status)}</strong>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="status-card job-list" aria-label="Capture jobs">
        <h2>作业列表</h2>
        <p>可同时保留最多 {MAX_CAPTURE_JOBS} 个作业；新建不会覆盖上一份未导出资料。</p>
        {jobs.length === 0 ? (
          <p>还没有采集作业。</p>
        ) : (
          <ul>
            {jobs.map(job => (
              <li key={job.jobId}>
                <button
                  type="button"
                  className={job.jobId === jobId ? 'job-item active' : 'job-item'}
                  onClick={() => {
                    void selectJob(job.jobId);
                  }}
                >
                  <strong>
                    {job.host}:{job.port}
                  </strong>
                  <span>
                    {job.family} · {job.readiness} · {jobRowStatus(job)}
                    {job.vendor || job.product ? ` · ${[job.vendor, job.product].filter(Boolean).join(' ')}` : ''}
                  </span>
                </button>
                <button type="button" className="secondary" onClick={() => void closeSelectedJob(job.jobId)}>
                  关闭作业
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="status-card pack-review" aria-label="Capture pack review">
        <h2>本地打开 / 对比 Capture Pack</h2>
        <p>只在本机读取 zip，不调用公网，也不写 Adapter。</p>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void openCapturePack()}>
            打开 Capture Pack
          </button>
          <button type="button" className="secondary" onClick={() => void compareOpenedPacks()}>
            对比两份
          </button>
        </div>
        {packSummary ? (
          <dl className="pack-summary">
            <div>
              <dt>文件</dt>
              <dd>{packPath || '本地 zip'}</dd>
            </div>
            <div>
              <dt>协议族</dt>
              <dd>{packSummary.family}</dd>
            </div>
            <div>
              <dt>现场厂商/型号</dt>
              <dd>
                {[packSummary.observedVendor, packSummary.observedProduct].filter(Boolean).join(' ') || '无'}
              </dd>
            </div>
            <div>
              <dt>离场结论</dt>
              <dd>{packSummary.readiness}</dd>
            </div>
            <div>
              <dt>HTTP / WS</dt>
              <dd>
                {packSummary.httpRequestCount} / {packSummary.webSocketCount}
              </dd>
            </div>
            <div>
              <dt>WebSocket</dt>
              <dd>{formatSummaryValue(packSummary.webSocketUrls)}</dd>
            </div>
            <div>
              <dt>画面标签</dt>
              <dd>{formatSummaryValue(packSummary.screenshotRoles)}</dd>
            </div>
            {packSummary.schemaErrors.length > 0 ? (
              <div>
                <dt>Schema</dt>
                <dd>{packSummary.schemaErrors.join('；')}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {packComparison ? (
          <table className="pack-diff">
            <thead>
              <tr>
                <th>字段</th>
                <th>左</th>
                <th>右</th>
              </tr>
            </thead>
            <tbody>
              {packComparison.diffs.map(diff => (
                <tr key={diff.field} className={diff.changed ? 'changed' : undefined}>
                  <td>{diff.field}</td>
                  <td>{diff.left || '无'}</td>
                  <td>{diff.right || '无'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </main>
  );
}
