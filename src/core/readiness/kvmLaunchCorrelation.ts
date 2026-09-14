import type { HttpRequestRecord, WebSocketRecord } from '../network/createNetworkRecorder';
import { EXPLICIT_KVM_LAUNCH_URL_PATTERN } from '../signatures/kvmUrlPatterns';

export const KVM_LAUNCH_ASSOCIATION_MS = 120_000;

const ACCEPTABLE_RESPONSE_BODY_SKIP = /^(?:redirect-response|streaming-resource|binary-resource:|unsupported-content-type:|response-too-large:|inline-or-blob-url|loading-failed)/;

function isStaticAssetUrl(url: string) {
  return /\.(?:png|jpe?g|gif|svg|ico|css|js|map|woff2?|ttf|eot)(?:[?#]|$)/i.test(url);
}

function requestHeader(request: HttpRequestRecord, name: string) {
  return Object.entries(request.requestHeaders).find(([key]) => key.toLowerCase() === name)?.[1] || '';
}

function hasLegacyKvmReferer(request: HttpRequestRecord) {
  const referer = `${requestHeader(request, 'referer')} ${requestHeader(request, 'referrer')}`.toLowerCase();
  return /\/bmc\/(?:pages\/remote\/kvm_by_html5\.html|resources\/js\/module\/remote\/html5\/)/.test(
    referer,
  );
}

function isLegacyKvmSupportRequest(request: HttpRequestRecord) {
  return (
    /\/bmc\/php\/(?:setpropertybymethod|getmultiproperty|processparameter|editcookie)\.php/i.test(
      request.url,
    ) && hasLegacyKvmReferer(request)
  );
}

function isSuccessfulStatus(request: HttpRequestRecord) {
  return request.status != null && request.status >= 200 && request.status < 400;
}

function isFailedStatus(request: HttpRequestRecord) {
  return request.status != null && request.status >= 400;
}

/** 明确的 KVM token/启动接口，不含宽泛的 console/viewer 轮询。 */
export function isExplicitKvmLaunchRequest(
  request: HttpRequestRecord,
  requireSuccess = true,
) {
  if (isStaticAssetUrl(request.url)) return false;
  if (requireSuccess ? !isSuccessfulStatus(request) : isFailedStatus(request)) return false;
  if (
    request.tags.includes('kvm-token') &&
    (!/\/bmc\/php\/(?:setpropertybymethod|getmultiproperty|processparameter|editcookie)\.php/i.test(
      request.url,
    ) ||
      isLegacyKvmSupportRequest(request))
  ) {
    return true;
  }
  if (isLegacyKvmSupportRequest(request)) return true;
  return EXPLICIT_KVM_LAUNCH_URL_PATTERN.test(request.url);
}

export function sameCaptureContext(
  left?: { captureWindowId?: string; windowRole?: string },
  right?: { captureWindowId?: string; windowRole?: string },
) {
  if (left?.captureWindowId || right?.captureWindowId) {
    return Boolean(left?.captureWindowId) && left?.captureWindowId === right?.captureWindowId;
  }
  if (left?.windowRole || right?.windowRole) {
    return Boolean(left?.windowRole) && left?.windowRole === right?.windowRole;
  }
  return true;
}

export function hasCorrelatedKvmLaunch(
  requests: HttpRequestRecord[],
  socket: WebSocketRecord,
) {
  return correlatedKvmLaunchHttpIds(requests, socket).length > 0;
}

export function correlatedKvmLaunchHttpIds(requests: HttpRequestRecord[], socket: WebSocketRecord) {
  const socketTime = Date.parse(socket.createdAt);
  if (!Number.isFinite(socketTime)) return [];
  return requests
    .filter(request => {
      if (!isExplicitKvmLaunchRequest(request)) return false;
      if (!sameCaptureContext(request, socket)) return false;
      const requestTime = Date.parse(request.timestamp);
      return (
        Number.isFinite(requestTime) &&
        requestTime <= socketTime &&
        socketTime - requestTime <= KVM_LAUNCH_ASSOCIATION_MS
      );
    })
    .map(request => request.id);
}

export function correlatedLoginHttpIds(requests: HttpRequestRecord[], socket: WebSocketRecord) {
  const socketTime = Date.parse(socket.createdAt);
  if (!Number.isFinite(socketTime)) return [];
  return requests
    .filter(request => {
      if (!request.tags.includes('login') || !isSuccessfulStatus(request)) return false;
      if (!sameCaptureContext(request, socket)) return false;
      const requestTime = Date.parse(request.timestamp);
      return Number.isFinite(requestTime) && requestTime <= socketTime;
    })
    .slice(-4)
    .map(request => request.id);
}

export function isCriticalRequestBodyMissing(request: HttpRequestRecord) {
  if (request.method.toUpperCase() !== 'POST') return false;
  if (request.requestBodySkippedReason === 'get-request-post-data-failed') return true;
  return request.requestBodySummary.bytes <= 0;
}

export function isCriticalResponseBodyMissing(request: HttpRequestRecord) {
  const reason = request.responseBodySkippedReason || '';
  if (reason === 'get-response-body-failed') return true;
  if (ACCEPTABLE_RESPONSE_BODY_SKIP.test(reason)) return false;
  if (request.responseBodySummary.bytes > 0) return false;
  if (request.responseBodyCaptured) return false;
  return true;
}

export function criticalPayloadGaps(requests: HttpRequestRecord[]) {
  const gaps: string[] = [];
  for (const request of requests) {
    if (request.tags.includes('login') && request.method.toUpperCase() === 'POST' && isSuccessfulStatus(request)) {
      if (isCriticalRequestBodyMissing(request)) {
        gaps.push(`${request.id}:login-request-body-missing`);
      }
    }
    if (isExplicitKvmLaunchRequest(request)) {
      if (request.method.toUpperCase() === 'POST' && isCriticalRequestBodyMissing(request)) {
        gaps.push(`${request.id}:kvm-request-body-missing`);
      }
      if (isCriticalResponseBodyMissing(request)) {
        gaps.push(`${request.id}:kvm-response-body-missing`);
      }
    }
  }
  return gaps;
}
