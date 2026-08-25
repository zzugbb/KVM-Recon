import type { CaptureReadiness, ChecklistItem } from '../core/capture-pack/types';
import type { CaptureJobSummary } from '../core/delivery/captureJob';

export type CapturePhase = 'idle' | 'capturing' | 'exported';

export function phaseLabel(phase: CapturePhase, readiness: CaptureReadiness, paused: boolean) {
  if (phase === 'idle') return '当前阶段：新建采集';
  if (phase === 'exported') return '当前阶段：已导出';
  if (paused) return '当前阶段：已暂停';
  if (readiness === 'YES') return '当前阶段：可导出';
  return '当前阶段：采集中';
}

export function jobRowStatus(job: Pick<CaptureJobSummary, 'exported' | 'paused' | 'windowsOpen' | 'readiness'>) {
  if (job.exported) return '已导出';
  if (job.paused) return '已暂停';
  if (job.readiness === 'YES') return job.windowsOpen ? '可导出' : '可导出（窗口已关）';
  if (job.windowsOpen) return '采集中';
  return '窗口已关';
}

export function nextStepText(input: {
  phase: CapturePhase;
  readiness: CaptureReadiness;
  items: ChecklistItem[];
  capturingScreenshot: boolean;
  paused: boolean;
  windowsOpen: boolean;
  exportFileName?: string;
}) {
  if (input.phase === 'idle') {
    return '填写 BMC 地址后点「新建采集作业」。在弹出窗口里手工登录，再打开 HTML5 KVM。';
  }
  if (input.phase === 'exported') {
    return input.exportFileName
      ? `已导出 ${input.exportFileName}，请打开 report.html 确认离场结论。`
      : '已导出 Capture Pack，请打开 report.html 确认离场结论。';
  }
  if (input.paused) {
    return '已暂停记录。采集窗口仍开着，点「继续采集」后恢复。';
  }
  if (input.capturingScreenshot) {
    return '正在自动截取 KVM 画面，请把远程控制台留在前台。';
  }
  if (input.readiness === 'YES') {
    return input.windowsOpen
      ? '资料已齐，点「导出 Capture Pack」。采集窗口可先留着。'
      : '资料已齐，点「导出 Capture Pack」。';
  }

  const pending = input.items.find(item => item.status !== 'pass' && item.status !== 'not_applicable');
  if (!pending) {
    return '资料已齐，点「导出 Capture Pack」。';
  }
  if (pending.id === 'bmc.connection' || pending.id === 'login.chain') {
    return '请在采集窗口登录 BMC。登录和后续流量会自动记录。';
  }
  if (
    pending.id === 'page.kvm.entry' ||
    pending.id === 'ws.kvm.established' ||
    pending.id === 'http.key_api'
  ) {
    return '请在采集窗口打开 HTML5 KVM，并把画面留在前台。打开后会自动截图。';
  }
  if (pending.id === 'page.viewer.screenshot') {
    return 'KVM 已打开，正在等待自动截图。请把画面窗口留在前台。';
  }
  return pending.userAction || '请按下方采集进度补齐缺失项。';
}
