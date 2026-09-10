import { viewerScreenshotPaths } from '../browser/browserCaptureCore';
import type {
  CaptureChecklist,
  CaptureReadiness,
  ChecklistItem,
  ChecklistSeverity,
  ChecklistStatus,
} from '../capture-pack/types';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import { scoreCapturedKvmFamily } from '../signatures/detectKvmFamily';
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
  return viewerScreenshotPaths(page?.events || []);
}

function urlContains(url: string, patterns: RegExp[]) {
  return patterns.some(pattern => pattern.test(url));
}

function isStaticAssetUrl(url: string) {
  return /\.(?:png|jpe?g|gif|svg|ico|css|js|map|woff2?|ttf|eot)(?:[?#]|$)/i.test(url);
}

function decodeHeadHex(headHex: string): string {
  const hex = headHex.replace(/[^0-9a-f]/gi, '');
  if (hex.length < 2 || hex.length % 2 !== 0) return '';
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch (error) {
    // 捕获帧头 hex 解码失败：现场帧可能截断或非 UTF-8
    // 策略：仅跳过文本魔数，继续使用 URL、opcode 和字节数判断 WS 证据
    void error;
    return '';
  }
}

function loginEvidence(network: NetworkSnapshot | null | undefined): string[] {
  return (network?.httpRequests || [])
    .filter(
      request =>
        (request.tags.includes('login') && !isStaticAssetUrl(request.url)) ||
        (!isStaticAssetUrl(request.url) &&
          urlContains(request.url, [
            /\/api\/(?:secure_session|session|session_encrypted)/i,
            /sessionservice\/sessions/i,
            /sessionservice\.createsession/i,
            /\/sysmgmt\/2015\/bmc\/session/i,
            /\/json\/login_session/i,
            /(?:^|\/)(?:login|signin)(?:[/?#.]|$)/i,
            /\/bmc\/php\/(?:dologin|login|gettoken)\.php/i,
          ])),
    )
    .map(request => request.id);
}

function keyHttpEvidence(network: NetworkSnapshot | null | undefined): string[] {
  return (network?.httpRequests || [])
    .filter(
      request =>
        request.tags.includes('kvm-token') ||
        request.tags.includes('kvm-entry') ||
        urlContains(request.url, [
          /\/api\/kvm\/token/i,
          /kvmservice/i,
          /setkvmkey/i,
          /starth5kvm/i,
          /\/kvm\/video/i,
          /\/vnc\/vconsole/i,
          /\/restgui\/(?:html5viewer|views\/configuration\/vconsole)/i,
          /\/wss\/ircport/i,
          /\/js\/irc(?:KeyboardMouse)?\.js/i,
          /\/bmc\/pages\/remote\/kvm_by_html5\.html/i,
          /\/bmc\/resources\/js\/module\/remote\/html5\/kvmclient\.js/i,
          /\/bmc\/php\/(?:gettoken|setpropertybymethod|getmultiproperty|processparameter|editcookie)\.php/i,
        ]),
    )
    .map(request => request.id);
}

function isKnownKvmSocketUrl(url: string) {
  return urlContains(url, [
    /\/kvm(?:\/|\?|$)/i,
    /\/kvm\/video/i,
    /\/vnc\/vconsole/i,
    /:5900\/(?:$|\?|vkvm\/?)/i,
    /\/wss\/ircport/i,
    /:(?:2198|2199|8208)\/(?:websocket)?(?:\?|$)/i,
  ]);
}

function hasKnownKvmFrame(frames: WebSocketFrameRecord[]) {
  return frames.some(frame => {
    const text = decodeHeadHex(frame.headHex);
    return (
      frame.magic === 'AMI_IVTP_CONNECTION_ALLOWED' ||
      frame.magic === 'AMI_IVTP_BINARY' ||
      frame.magic === 'DELL_APCP' ||
      frame.magic === 'HUAWEI_KVM_FEF6' ||
      /^RFB 003\./.test(frame.magic || text) ||
      /\/xyz\/openbmc_project/i.test(text) ||
      /^41504350/i.test(frame.headHex) ||
      /^fef6/i.test(frame.headHex) ||
      /^(13|14|17|22|35|3a|50|53)[0-9a-f]{6}/i.test(frame.headHex)
    );
  });
}

export function kvmWebSocketEvidence(network: NetworkSnapshot | null | undefined): string[] {
  const framesBySocket = new Map<string, WebSocketFrameRecord[]>();
  for (const frame of network?.webSocketFrames || []) {
    const frames = framesBySocket.get(frame.socketId) || [];
    frames.push(frame);
    framesBySocket.set(frame.socketId, frames);
  }

  return (network?.webSockets || [])
    .filter(socket => {
      const frameCount = socket.binaryFrameCount + socket.textFrameCount;
      if (frameCount <= 0) return false;
      const frames = framesBySocket.get(socket.id) || [];
      const knownFrame = hasKnownKvmFrame(frames);
      if (knownFrame) return true;
      return socket.binaryFrameCount > 0 && (socket.tags.includes('kvm-video') || isKnownKvmSocketUrl(socket.url));
    })
    .map(socket => socket.id);
}

function probeConnectionEvidence(probe: ProbeBmcTargetResult | null | undefined): string[] {
  if (!probe) return [];
  const evidence = [`${probe.basic.scheme}://${probe.basic.host}:${probe.basic.port}`];
  if (probe.tls.reachable) evidence.push(`tls:${probe.tls.protocol || 'reachable'}`);
  return evidence;
}

function familyFingerprintItem(
  probe: ProbeBmcTargetResult | null | undefined,
  network: NetworkSnapshot | null | undefined,
): ChecklistItem {
  if (!probe) {
    return item({
      id: 'bmc.fingerprint',
      title: 'BMC 协议族指纹',
      status: 'unknown',
      severity: 'warning',
      evidence: [],
      userAction: '请补充登录后页面截图、KVM 入口点击记录和 HTTP/WS 资料，便于离线判断协议族。',
    });
  }

  const family = scoreCapturedKvmFamily(probe, network);
  const unclassified = family.primary === 'unknown-h5' || family.primary === 'not-h5';
  if (unclassified) {
    return item({
      id: 'bmc.fingerprint',
      title: 'BMC 协议族指纹',
      status: 'not_applicable',
      severity: 'warning',
      evidence: [`${family.primary}:${family.confidence}`],
      userAction: '无需补采已知族指纹。出机房后按 HTTP/WS 新建 Adapter，不要把该采集桶写进网关。',
    });
  }

  const evidence = [
    `${family.primary}:${family.confidence}`,
    ...family.candidates.flatMap(candidate => candidate.evidence),
  ];
  return item({
    id: 'bmc.fingerprint',
    title: 'BMC 协议族指纹',
    status: statusForEvidence(evidence, 'unknown'),
    severity: 'warning',
    evidence,
    userAction: evidence.length
      ? ''
      : '请补充登录后页面截图、KVM 入口点击记录和 HTTP/WS 资料，便于离线判断协议族。',
  });
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
  const loginIds = loginEvidence(input.network);
  const entryEvidence = [...selectorEvidence(input.page), ...keyHttpEvidence(input.network)];
  const httpIds = keyHttpEvidence(input.network);
  const wsIds = kvmWebSocketEvidence(input.network);
  const screenshots = screenshotEvidence(input.page);
  const tls = tlsEvidence(input.probe);

  const items: ChecklistItem[] = [
    item({
      id: 'bmc.connection',
      title: 'BMC 基础连接',
      status: statusForEvidence(connectionEvidence, 'missing'),
      severity: 'blocking',
      evidence: connectionEvidence,
      userAction: connectionEvidence.length
        ? ''
        : '请确认 BMC 地址、端口和网络可达后重新执行基础探测。',
    }),
    familyFingerprintItem(input.probe, input.network),
    item({
      id: 'login.chain',
      title: '登录链路 HTTP 资料',
      status: statusForEvidence(loginIds, 'needs_user_action'),
      severity: 'blocking',
      evidence: loginIds,
      userAction: loginIds.length
        ? ''
        : '请重新采集，在采集窗口完成 BMC 登录，并确认登录请求出现在 HTTP 列表中。',
    }),
    item({
      id: 'page.kvm.entry',
      title: 'HTML5 KVM 入口',
      status: statusForEvidence(entryEvidence, 'needs_user_action'),
      severity: 'blocking',
      evidence: entryEvidence,
      userAction: entryEvidence.length
        ? ''
        : '请登录 BMC 后点击“远程控制台 / HTML5 KVM”，等待 viewer 页面或弹窗出现。',
    }),
    item({
      id: 'http.key_api',
      title: 'KVM 关键 HTTP API',
      status: statusForEvidence(httpIds, 'missing'),
      severity: 'warning',
      evidence: httpIds,
      userAction: httpIds.length
        ? ''
        : '请打开 KVM viewer 后等待 token、KvmService、SetKvmKey 或 KVM 入口相关请求完成。',
    }),
    item({
      id: 'ws.kvm.established',
      title: 'KVM WebSocket',
      status: statusForEvidence(wsIds, 'needs_user_action'),
      severity: 'blocking',
      evidence: wsIds,
      userAction: wsIds.length
        ? ''
        : '请登录 BMC 并打开 HTML5 KVM，等待至少 10 秒直到出现 WS 下行帧。若 KVM 在新窗口打开，请把该窗口留在前台。',
    }),
    item({
      id: 'page.viewer.screenshot',
      title: 'KVM 画面截图',
      status: statusForEvidence(screenshots, 'missing'),
      severity: 'warning',
      evidence: screenshots,
      userAction: screenshots.length
        ? ''
        : '打开 HTML5 KVM 后会自动截图，无需再点「采集当前画面」。',
    }),
    item({
      id: 'tls.certificate',
      title: 'TLS 证书信息',
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
