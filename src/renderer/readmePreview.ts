import type { CaptureReadiness, ChecklistItem } from '../core/capture-pack/types';
import type { CaptureJobSummary } from '../core/delivery/captureJob';
import type { CapturePhase } from './captureStatus';

export interface ReadmePreviewState {
  host: string;
  port: string;
  vendor: string;
  product: string;
  firmware: string;
  location: string;
  operatorNote: string;
  phase: CapturePhase;
  jobId: string;
  jobs: CaptureJobSummary[];
  windowsOpen: boolean;
  readiness: CaptureReadiness;
  progressItems: ChecklistItem[];
}

function isReadmeProgressPreview() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('preview') === 'progress';
  } catch {
    // 捕获非浏览器环境或无效 location：预览参数仅用于 README 截图，失败时走真实空界面
    return false;
  }
}

const progressItems: ChecklistItem[] = [
  {
    id: 'bmc.connection',
    title: 'BMC 基础连接',
    status: 'pass',
    severity: 'blocking',
    evidence: ['https://10.0.0.10:443'],
    userAction: '',
  },
  {
    id: 'bmc.fingerprint',
    title: 'BMC 协议族指纹',
    status: 'pass',
    severity: 'warning',
    evidence: ['ami-megarac:0.9'],
    userAction: '',
  },
  {
    id: 'login.chain',
    title: '登录链路 HTTP 资料',
    status: 'pass',
    severity: 'blocking',
    evidence: ['login-1'],
    userAction: '',
  },
  {
    id: 'page.kvm.entry',
    title: 'HTML5 KVM 入口',
    status: 'needs_user_action',
    severity: 'blocking',
    evidence: [],
    userAction: '请登录 BMC 后点击“远程控制台 / HTML5 KVM”，等待 viewer 页面或弹窗出现。',
  },
  {
    id: 'http.key_api',
    title: 'KVM 关键 HTTP API',
    status: 'missing',
    severity: 'warning',
    evidence: [],
    userAction: '',
  },
  {
    id: 'ws.kvm.established',
    title: 'KVM WebSocket',
    status: 'needs_user_action',
    severity: 'blocking',
    evidence: [],
    userAction: '',
  },
  {
    id: 'page.viewer.screenshot',
    title: 'KVM 画面截图',
    status: 'missing',
    severity: 'warning',
    evidence: [],
    userAction: '',
  },
  {
    id: 'tls.certificate',
    title: 'TLS 证书信息',
    status: 'pass',
    severity: 'info',
    evidence: ['TLSv1.2'],
    userAction: '',
  },
];

export function readReadmePreview(): ReadmePreviewState | null {
  if (!isReadmeProgressPreview()) return null;
  const jobId = 'job-readme-preview';
  const jobs: CaptureJobSummary[] = [
    {
      jobId,
      host: '10.0.0.10',
      port: 443,
      scheme: 'https',
      family: 'ami-megarac',
      startedAt: '2026-08-25T10:00:00.000+08:00',
      vendor: 'Inspur',
      product: 'NF5280',
      windowsOpen: true,
      paused: false,
      exported: false,
      readiness: 'NO',
    },
  ];
  return {
    host: '10.0.0.10',
    port: '443',
    vendor: 'Inspur',
    product: 'NF5280',
    firmware: '4.23',
    location: 'A-12-U3',
    operatorNote: '机房现场采集',
    phase: 'capturing',
    jobId,
    jobs,
    windowsOpen: true,
    readiness: 'NO',
    progressItems,
  };
}
