import type {
  CaptureChecklist,
  CaptureReadiness,
  ChecklistItem,
  ChecklistSeverity,
  ChecklistStatus,
} from '../capture-pack/types';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import type {
  HttpRequestRecord,
  WebSocketFrameRecord,
  WebSocketRecord,
} from '../network/createNetworkRecorder';

interface BrowserTimelineJson {
  jobId: string;
  events: Array<{
    type: string;
    [key: string]: unknown;
  }>;
}

interface NetworkSnapshot {
  httpRequests: HttpRequestRecord[];
  webSockets: WebSocketRecord[];
  webSocketFrames: WebSocketFrameRecord[];
}

interface RedactionSummary {
  status: 'pass' | 'fail';
  redactedFields: number;
}

interface BuildReadinessChecklistInput {
  probe?: ProbeBmcTargetResult | null;
  page?: BrowserTimelineJson | null;
  network?: NetworkSnapshot | null;
  redaction: RedactionSummary;
}

function item(input: ChecklistItem): ChecklistItem {
  return input;
}

function statusForEvidence(evidence: string[], missingStatus: ChecklistStatus = 'missing') {
  return evidence.length > 0 ? 'pass' : missingStatus;
}

function selectorEvidence(page: BrowserTimelineJson | null | undefined): string[] {
  return (page?.events || [])
    .filter(event => event.type === 'selector-candidates')
    .flatMap(event => (Array.isArray(event.candidates) ? event.candidates : []))
    .filter((candidate): candidate is { role?: string; selector?: string } => {
      return Boolean(candidate) && typeof candidate === 'object';
    })
    .filter(candidate => candidate.role === 'kvm-entry' || candidate.role === 'viewer')
    .map(candidate => candidate.selector || '')
    .filter(Boolean);
}

function screenshotEvidence(page: BrowserTimelineJson | null | undefined): string[] {
  return (page?.events || [])
    .filter(event => event.type === 'screenshot')
    .map(event => event.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}

function urlContains(url: string, patterns: RegExp[]) {
  return patterns.some(pattern => pattern.test(url));
}

function loginEvidence(network: NetworkSnapshot | null | undefined): string[] {
  return (network?.httpRequests || [])
    .filter(
      request =>
        request.tags.includes('login') ||
        urlContains(request.url, [/\/api\/session/i, /sessionservice\/sessions/i, /login/i]),
    )
    .map(request => request.id);
}

function keyHttpEvidence(network: NetworkSnapshot | null | undefined): string[] {
  return (network?.httpRequests || [])
    .filter(
      request =>
        request.tags.includes('kvm-token') ||
        request.tags.includes('kvm-entry') ||
        urlContains(request.url, [/\/api\/kvm\/token/i, /kvmservice/i, /setkvmkey/i, /\/kvm\/video/i]),
    )
    .map(request => request.id);
}

function kvmWebSocketEvidence(network: NetworkSnapshot | null | undefined): string[] {
  return (network?.webSockets || [])
    .filter(socket => {
      const frameCount = socket.binaryFrameCount + socket.textFrameCount;
      return socket.tags.includes('kvm-video') && frameCount > 0;
    })
    .map(socket => socket.id);
}

function probeConnectionEvidence(probe: ProbeBmcTargetResult | null | undefined): string[] {
  if (!probe) return [];
  const evidence = [`${probe.basic.scheme}://${probe.basic.host}:${probe.basic.port}`];
  if (probe.tls.reachable) evidence.push(`tls:${probe.tls.protocol || 'reachable'}`);
  return evidence;
}

function familyEvidence(probe: ProbeBmcTargetResult | null | undefined): string[] {
  if (!probe || probe.familySignatures.primary === 'unknown-h5') return [];
  return [
    `${probe.familySignatures.primary}:${probe.familySignatures.confidence}`,
    ...probe.familySignatures.candidates.flatMap(candidate => candidate.evidence),
  ];
}

function tlsEvidence(probe: ProbeBmcTargetResult | null | undefined): {
  status: ChecklistStatus;
  evidence: string[];
} {
  if (!probe) return { status: 'unknown', evidence: [] };
  if (probe.basic.scheme !== 'https') return { status: 'not_applicable', evidence: ['target.scheme=http'] };
  if (!probe.tls.reachable) return { status: 'missing', evidence: [] };
  const evidence = [probe.tls.protocol || 'tls-reachable'];
  if (probe.tls.certificate?.subject.CN) evidence.push(`CN=${String(probe.tls.certificate.subject.CN)}`);
  return { status: 'pass', evidence };
}

function readinessFromItems(items: ChecklistItem[]): CaptureReadiness {
  const hasBlockingProblem = items.some(
    nextItem =>
      nextItem.severity === 'blocking' &&
      nextItem.status !== 'pass' &&
      nextItem.status !== 'not_applicable',
  );
  if (hasBlockingProblem) return 'NO';

  const hasWarningProblem = items.some(
    nextItem =>
      nextItem.severity === 'warning' &&
      nextItem.status !== 'pass' &&
      nextItem.status !== 'not_applicable',
  );
  return hasWarningProblem ? 'PARTIAL' : 'YES';
}

export function buildReadinessChecklist(input: BuildReadinessChecklistInput): CaptureChecklist {
  const connectionEvidence = probeConnectionEvidence(input.probe);
  const signatureEvidence = familyEvidence(input.probe);
  const loginIds = loginEvidence(input.network);
  const entryEvidence = [...selectorEvidence(input.page), ...keyHttpEvidence(input.network)];
  const httpIds = keyHttpEvidence(input.network);
  const wsIds = kvmWebSocketEvidence(input.network);
  const screenshots = screenshotEvidence(input.page);
  const tls = tlsEvidence(input.probe);

  const items: ChecklistItem[] = [
    item({
      id: 'bmc.connection',
      title: 'BMC 基础连接已采集',
      status: statusForEvidence(connectionEvidence, 'missing'),
      severity: 'blocking',
      evidence: connectionEvidence,
      userAction: connectionEvidence.length
        ? ''
        : '请确认 BMC 地址、端口和网络可达后重新执行基础探测。',
    }),
    item({
      id: 'bmc.fingerprint',
      title: 'BMC 协议族指纹已识别',
      status: statusForEvidence(signatureEvidence, 'unknown'),
      severity: 'warning',
      evidence: signatureEvidence,
      userAction: signatureEvidence.length
        ? ''
        : '请补充登录后页面截图、KVM 入口点击记录和 HTTP/WS 资料，便于离线判断协议族。',
    }),
    item({
      id: 'login.chain',
      title: '登录链路 HTTP 资料已采集',
      status: statusForEvidence(loginIds, 'needs_user_action'),
      severity: 'blocking',
      evidence: loginIds,
      userAction: loginIds.length
        ? ''
        : '请重新采集，在采集窗口完成 BMC 登录，并确认登录请求出现在 HTTP 列表中。',
    }),
    item({
      id: 'page.kvm.entry',
      title: 'HTML5 KVM 入口已采集',
      status: statusForEvidence(entryEvidence, 'needs_user_action'),
      severity: 'blocking',
      evidence: entryEvidence,
      userAction: entryEvidence.length
        ? ''
        : '请登录 BMC 后点击“远程控制台 / HTML5 KVM”，等待 viewer 页面或弹窗出现。',
    }),
    item({
      id: 'http.key_api',
      title: 'KVM 关键 HTTP API 已采集',
      status: statusForEvidence(httpIds, 'missing'),
      severity: 'warning',
      evidence: httpIds,
      userAction: httpIds.length
        ? ''
        : '请打开 KVM viewer 后等待 token、KvmService、SetKvmKey 或 KVM 入口相关请求完成。',
    }),
    item({
      id: 'ws.kvm.established',
      title: 'KVM WebSocket 已建立并捕获帧',
      status: statusForEvidence(wsIds, 'needs_user_action'),
      severity: 'blocking',
      evidence: wsIds,
      userAction: wsIds.length
        ? ''
        : '请登录 BMC 并打开 HTML5 KVM，等待至少 10 秒直到出现 WS 下行帧。若 KVM 在新窗口打开，请把该窗口留在前台。',
    }),
    item({
      id: 'page.viewer.screenshot',
      title: 'viewer 页面截图已采集',
      status: statusForEvidence(screenshots, 'missing'),
      severity: 'warning',
      evidence: screenshots,
      userAction: screenshots.length
        ? ''
        : '请打开 HTML5 KVM 后把画面窗口留在前台，选择截图角色并点击“采集当前页面”。',
    }),
    item({
      id: 'tls.certificate',
      title: 'TLS 证书信息已采集',
      status: tls.status,
      severity: 'info' as ChecklistSeverity,
      evidence: tls.evidence,
      userAction: tls.status === 'missing' ? '请确认 HTTPS 端口可达后重新执行 TLS 探测。' : '',
    }),
    item({
      id: 'redaction.safe',
      title: '导出脱敏检查通过',
      status: input.redaction.status === 'pass' ? 'pass' : 'fail',
      severity: 'blocking',
      evidence: [`redactedFields=${input.redaction.redactedFields}`],
      userAction:
        input.redaction.status === 'pass'
          ? ''
          : '请不要离场导出，先移除明文密码、Token、Cookie 或完整视频流后重新生成资料包。',
    }),
  ];

  return {
    readiness: readinessFromItems(items),
    items,
  };
}
