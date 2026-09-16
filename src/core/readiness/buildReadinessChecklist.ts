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
import { detectProductHints } from '../signatures/detectProductHints';
import { isHuaweiVmediaWebSocketUrl, isKnownKvmWebSocketUrl } from '../signatures/kvmUrlPatterns';
import {
  criticalPayloadGaps,
  hasCorrelatedKvmLaunch,
  isExplicitKvmLaunchRequest,
} from './kvmLaunchCorrelation';
import { materialInFlightRequestIds, materialPendingTaskIds } from './networkCaptureCompleteness';
import type {
  HttpRequestRecord,
  NetworkIdleResult,
  WebSocketFrameRecord,
  WebSocketRecord,
} from '../network/createNetworkRecorder';
import {
  adapterSourceCoverage,
  pageReferencedScriptsFromEvents,
  pageScriptsEventsTruncated,
  SOURCE_MAX_FILES,
  SOURCE_TOTAL_BUDGET_BYTES,
  sourceInventoryEvidence,
} from '../network/sourceCapture';

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
  networkIdle?: NetworkIdleResult | null;
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

function isReliableLoginRequest(request: HttpRequestRecord) {
  if (isStaticAssetUrl(request.url)) return false;
  const loginUrl = urlContains(request.url, [
    /\/api\/(?:secure_session|session|session_encrypted)/i,
    /sessionservice\/sessions/i,
    /sessionservice\.createsession/i,
    /\/redfish\/v1\/sessions(?:[/?#]|$)/i,
    /\/sysmgmt\/2015\/bmc\/session/i,
    /\/json\/login_session/i,
    /\/bmc\/php\/(?:dologin|login)\.php/i,
    /(?:^|\/)(?:login|signin)(?:[/?#.]|$)/i,
  ]);
  if (!loginUrl && !request.tags.includes('login')) return false;
  if (request.method.toUpperCase() !== 'POST') return false;
  if (request.status == null || request.status < 200 || request.status >= 400) return false;

  const hasSessionHeader = Object.entries(request.responseHeaders).some(([name, value]) => {
    return /^(?:set-cookie|x-auth-token)$/i.test(name) && Boolean(value.trim());
  });
  const responseFields = [
    ...(request.responseBodySummary.jsonKeys || []),
    ...request.responseBodySummary.redactedFields,
    ...Object.keys(request.responseStructure?.jsonPaths || {}),
  ].join(' ');
  const responseSample = JSON.stringify(request.responseBodySummary.sample ?? '');
  const hasSessionStructure =
    /racsession|csrf|session(?:id|_id|_key)?|uniqueid|x-auth-token|privilege|token/i.test(
      responseFields,
    );
  const hasSuccessBody =
    /success|authenticated|login[ _-]?ok|"cc"\s*:\s*0/i.test(responseSample);
  return hasSessionHeader || hasSessionStructure || hasSuccessBody;
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
    .filter(isReliableLoginRequest)
    .map(request => request.id);
}

function isSuccessfulKvmLaunchRequest(request: HttpRequestRecord) {
  return isExplicitKvmLaunchRequest(request);
}

function keyHttpRequests(network: NetworkSnapshot | null | undefined): HttpRequestRecord[] {
  return (network?.httpRequests || []).filter(isSuccessfulKvmLaunchRequest);
}

function kvmEntryEvidence(network: NetworkSnapshot | null | undefined): string[] {
  return (network?.httpRequests || [])
    .filter(request => {
      if (isStaticAssetUrl(request.url)) return false;
      if (request.status == null || request.status < 200 || request.status >= 400) return false;
      return request.tags.includes('kvm-entry') || isExplicitKvmLaunchRequest(request);
    })
    .map(request => request.id);
}

function keyHttpEvidence(network: NetworkSnapshot | null | undefined): string[] {
  return keyHttpRequests(network).map(request => request.id);
}

function isKnownKvmSocketUrl(url: string) {
  return isKnownKvmWebSocketUrl(url);
}

function hasStrongKvmFrame(frames: WebSocketFrameRecord[]) {
  return frames.some(frame => {
    const text = decodeHeadHex(frame.headHex);
    return (
      frame.magic === 'AMI_IVTP_CONNECTION_ALLOWED' ||
      frame.magic === 'DELL_APCP' ||
      frame.magic === 'HUAWEI_KVM_FEF6' ||
      /^RFB 003\./.test(frame.magic || text) ||
      /^41504350/i.test(frame.headHex) ||
      /^fef6/i.test(frame.headHex)
    );
  });
}

function hasWeakAmiFrame(frames: WebSocketFrameRecord[]) {
  return frames.some(
    frame =>
      frame.magic === 'AMI_IVTP_BINARY' ||
      /^(13|14|17|22|35|3a|50|53)[0-9a-f]{6}/i.test(frame.headHex),
  );
}

export function kvmWebSocketEvidence(network: NetworkSnapshot | null | undefined): string[] {
  const launchRequests = keyHttpRequests(network);
  const framesBySocket = new Map<string, WebSocketFrameRecord[]>();
  for (const frame of network?.webSocketFrames || []) {
    const frames = framesBySocket.get(frame.socketId) || [];
    frames.push(frame);
    framesBySocket.set(frame.socketId, frames);
  }

  return (network?.webSockets || [])
    .filter(socket => {
      if (socket.tags.includes('vmedia') || isHuaweiVmediaWebSocketUrl(socket.url)) {
        return false;
      }
      const frames = framesBySocket.get(socket.id) || [];
      const downFrames = frames.filter(frame => frame.direction === 'down');
      if (downFrames.length === 0) return false;
      if (hasStrongKvmFrame(downFrames)) return true;
      if (socket.binaryFrameCount <= 0) return false;
      const hasKvmContext =
        socket.tags.includes('kvm-video') ||
        isKnownKvmSocketUrl(socket.url) ||
        hasCorrelatedKvmLaunch(launchRequests, socket);
      if (!hasKvmContext) return false;
      return (
        hasWeakAmiFrame(downFrames) ||
        socket.tags.includes('kvm-video') ||
        isKnownKvmSocketUrl(socket.url)
      );
    })
    .map(socket => socket.id);
}

export function reliableKvmWindows(
  network: NetworkSnapshot | null | undefined,
): Array<{ windowRole?: 'main' | 'popup'; captureWindowId?: string; socketId: string; createdAt: string }> {
  const socketIds = new Set(kvmWebSocketEvidence(network));
  return [...(network?.webSockets || [])]
    .filter(socket => socketIds.has(socket.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(socket => ({
      socketId: socket.id,
      createdAt: socket.createdAt,
      ...(socket.windowRole ? { windowRole: socket.windowRole } : {}),
      ...(socket.captureWindowId ? { captureWindowId: socket.captureWindowId } : {}),
    }));
}

function probeConnectionEvidence(probe: ProbeBmcTargetResult | null | undefined): string[] {
  if (!probe) return [];
  const httpResponses = [
    probe.redfish?.status || 0,
    ...Object.values(probe.pathDetails || {}).map(detail => detail?.status || 0),
  ].filter(status => status > 0);
  if (!probe.tls.reachable && httpResponses.length === 0) return [];
  const evidence = [`${probe.basic.scheme}://${probe.basic.host}:${probe.basic.port}`];
  if (probe.tls.reachable) evidence.push(`tls:${probe.tls.protocol || 'reachable'}`);
  if (httpResponses.length > 0) evidence.push(`http:${httpResponses.join(',')}`);
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

function viewerSourceItem(
  probe: ProbeBmcTargetResult | null | undefined,
  network: NetworkSnapshot | null | undefined,
  page?: BrowserTimelineJson | null,
): ChecklistItem {
  const family = probe ? scoreCapturedKvmFamily(probe, network) : { primary: 'unknown-h5' as const };
  const unclassified = family.primary === 'unknown-h5' || family.primary === 'not-h5';
  const viewerWindowIds = reliableKvmWindows(network)
    .map(window => window.captureWindowId)
    .filter((id): id is string => Boolean(id));
  const coverage = adapterSourceCoverage({
    requests: network?.httpRequests || [],
    referenced: pageReferencedScriptsFromEvents(page?.events || []),
    host: probe?.basic.host,
    unclassified,
    viewerWindowIds,
    referencedTruncated: pageScriptsEventsTruncated(page?.events || []),
  });
  const missingUrls = coverage.missingReferenced.map(item => `missing:${item.url}`);
  if (
    coverage.candidates.length === 0 &&
    coverage.requiredReferenced.length === 0 &&
    !coverage.referencedTruncated
  ) {
    if (unclassified && kvmWebSocketEvidence(network).length > 0) {
      return item({
        id: 'http.viewer_source',
        title: '关键 Viewer/认证源码资料',
        status: 'missing',
        severity: 'warning',
        evidence: [],
        userAction:
          '未知协议已有 KVM WebSocket，但未捕获 Viewer/登录 HTML 或 JS。请关闭并重新打开 HTML5 KVM，不要只等待脚本加载。',
      });
    }
    return item({
      id: 'http.viewer_source',
      title: '关键 Viewer/认证源码资料',
      status: 'not_applicable',
      severity: 'warning',
      evidence: [],
      userAction: '',
    });
  }
  if (
    coverage.missingReferenced.length > 0 ||
    coverage.incomplete.length > 0 ||
    coverage.referencedTruncated
  ) {
    const budgetExceeded = coverage.incomplete.some(request =>
      /source-budget-exceeded/i.test(request.responseBodySkippedReason || ''),
    );
    const tooLargeOrTruncated = coverage.incomplete.some(request =>
      /truncated|too-large/i.test(
        `${request.responseBodySkippedReason || ''} ${request.sourceTruncated ? 'truncated' : ''}`,
      ),
    );
    return item({
      id: 'http.viewer_source',
      title: '关键 Viewer/认证源码资料',
      status: 'missing',
      severity: 'warning',
      evidence: [
        ...missingUrls,
        ...coverage.incomplete.map(sourceInventoryEvidence),
        ...(coverage.referencedTruncated ? ['referenced-truncated'] : []),
      ],
      userAction: coverage.referencedTruncated
        ? '页面引用源码清单被截断，无法确认 Viewer 关键脚本是否采全。请关闭并重新打开 HTML5 KVM。'
        : coverage.missingReferenced.length
        ? '页面已引用 Viewer 主脚本/polyfill，但 Network 未采到正文（常见于弹窗在 debugger attach 前加载）。请关闭并重新打开 HTML5 KVM，不要只等待。'
        : budgetExceeded
          ? `关键源码数量或总量已达采集器上限（最多 ${SOURCE_MAX_FILES} 个文件、合计 ${Math.round(SOURCE_TOTAL_BUDGET_BYTES / (1024 * 1024))} MiB）。这是硬限制，重新打开 Viewer 或重新采集无法突破，请接受 PARTIAL。`
          : tooLargeOrTruncated
            ? '单文件超过 2 MiB 被截断或跳过。同一文件重新采集仍会截断，请接受 PARTIAL。'
            : 'Viewer 关键源码不完整。未知协议缺少完整源码时不能判 YES。',
    });
  }
  return item({
    id: 'http.viewer_source',
    title: '关键 Viewer/认证源码资料',
    status: 'pass',
    severity: 'warning',
    evidence: [
      ...coverage.requiredReferenced.map(item => `referenced:${item.url}`),
      ...coverage.candidates.map(sourceInventoryEvidence),
    ],
    userAction: '',
  });
}

function networkCaptureIncomplete(
  networkIdle: NetworkIdleResult | null | undefined,
  requests: HttpRequestRecord[] | undefined,
) {
  if (!networkIdle) return false;
  if ((networkIdle.attachFailures || []).length > 0) return true;
  if (materialPendingTaskIds(networkIdle.pendingTasks, requests, networkIdle.inFlightRequestIds).length > 0) {
    return true;
  }
  if (networkIdle.pendingTaskCount > 0 && !(networkIdle.pendingTasks && networkIdle.pendingTasks.length)) {
    return true;
  }
  return materialInFlightRequestIds(networkIdle.inFlightRequestIds, requests).length > 0;
}

function networkCaptureEvidence(
  networkIdle: NetworkIdleResult | null | undefined,
  requests: HttpRequestRecord[] | undefined,
) {
  const attachFailures = networkIdle?.attachFailures || [];
  const pendingTaskCount = networkIdle?.pendingTaskCount ?? 0;
  const pendingTasks = networkIdle?.pendingTasks || [];
  const inFlight = networkIdle?.inFlightRequestIds || [];
  const materialInFlight = materialInFlightRequestIds(inFlight, requests);
  const materialPending = materialPendingTaskIds(pendingTasks, requests, inFlight);
  if (!networkIdle) {
    return [
      'timedOut=false',
      'pendingTaskCount=0',
      'materialPendingCount=0',
      'inFlightRequestCount=0',
      'materialInFlightCount=0',
    ];
  }
  return [
    `timedOut=${Boolean(networkIdle.timedOut)}`,
    `pendingTaskCount=${pendingTaskCount}`,
    `materialPendingCount=${materialPending.length}`,
    `inFlightRequestCount=${inFlight.length}`,
    `materialInFlightCount=${materialInFlight.length}`,
    ...pendingTasks.map(
      task => `pending=${task.kind}${task.requestId ? `:${task.requestId}` : ''}`,
    ),
    ...materialPending.map(id => `materialPending=${id}`),
    ...inFlight.map(id => `inFlight=${id}`),
    ...materialInFlight.map(id => `materialInFlight=${id}`),
    ...attachFailures.map(failure => `attachFailed=${failure.sessionId}:${failure.reason}`),
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
  const loginIds = loginEvidence(input.network);
  const entryEvidence = [...selectorEvidence(input.page), ...kvmEntryEvidence(input.network)];
  const httpIds = keyHttpEvidence(input.network);
  const payloadGaps = criticalPayloadGaps(input.network?.httpRequests || []);
  const wsIds = kvmWebSocketEvidence(input.network);
  const screenshots = screenshotEvidence(input.page);
  const tls = tlsEvidence(input.probe);
  const productHints = detectProductHints({
    redfish: {
      vendor: input.probe?.basic.vendor,
      product: input.probe?.basic.product,
    },
    traffic: {
      httpUrls: (input.network?.httpRequests || []).map(request => request.url),
      webSocketUrls: (input.network?.webSockets || []).map(socket => socket.url),
      frameHeads: (input.network?.webSocketFrames || []).map(frame => frame.magic || frame.headHex),
      frameHeadHexes: (input.network?.webSocketFrames || []).map(frame => frame.headHex),
    },
  });
  const hpeDirectWs =
    productHints.some(hint => hint.productFamily === 'hpe-ilo-h5') &&
    (input.network?.webSockets || []).some(socket => /\/wss\/ircport(?:[/?#]|$)/i.test(socket.url));

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
      status: hpeDirectWs ? 'not_applicable' : statusForEvidence(httpIds, 'missing'),
      severity: 'warning',
      evidence: hpeDirectWs ? ['hpe-ilo-h5:direct-ws:/wss/ircport'] : httpIds,
      userAction: httpIds.length || hpeDirectWs
        ? ''
        : '请打开 KVM viewer 后等待 token、h5viewercfg、KvmService、SetKvmKey 或明确 KVM 启动接口完成。不要手工探测这些接口。',
    }),
    item({
      id: 'http.key_payload',
      title: '关键登录/KVM 请求正文',
      status: statusForEvidence(payloadGaps.length ? [] : ['payload-complete'], 'missing'),
      severity: 'warning',
      evidence: payloadGaps.length ? payloadGaps : ['payload-complete'],
      userAction: payloadGaps.length
        ? '关键登录 POST 或 KVM 启动接口缺少请求/响应正文。请在采集窗口完成登录并打开 KVM 后稍候再导出，避免空正文仍判 YES。'
        : '',
    }),
    viewerSourceItem(input.probe, input.network, input.page),
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
      id: 'network.capture.complete',
      title: '网络响应采集完整性',
      status: networkCaptureIncomplete(input.networkIdle, input.network?.httpRequests)
        ? 'needs_user_action'
        : 'pass',
      severity: 'warning',
      evidence: networkCaptureEvidence(input.networkIdle, input.network?.httpRequests),
      userAction: networkCaptureIncomplete(input.networkIdle, input.network?.httpRequests)
        ? '仍有会影响离线资料的请求未完成（登录、KVM Token/启动接口或 Viewer/Worker 源码）。请等待这些请求结束后再导出。BMC 页面上已成功采过的重复轮询不会单独把资料包打成 PARTIAL。'
        : '',
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
