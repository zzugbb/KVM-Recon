import type { HttpRequestRecord } from '../network/createNetworkRecorder';
import { isKeyAdapterSourceUrl } from '../network/sourceCapture';
import {
  isCriticalRequestBodyMissing,
  isCriticalResponseBodyMissing,
  isExplicitKvmLaunchRequest,
} from './kvmLaunchCorrelation';

export function normalizeHttpRequestIdentity(method: string, url: string) {
  return `${String(method || 'GET').toUpperCase()} ${normalizeHttpIdentityUrl(url)}`;
}

export function normalizeHttpIdentityUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return String(url || '').split('#')[0];
  }
}

function isSuccessfulStatus(request: HttpRequestRecord) {
  return request.status != null && request.status >= 200 && request.status < 400;
}

function isCompleteSuccessfulCapture(request: HttpRequestRecord) {
  if (!isSuccessfulStatus(request)) return false;
  if (request.tags.includes('login') && request.method.toUpperCase() === 'POST') {
    if (isCriticalRequestBodyMissing(request)) return false;
  }
  if (isExplicitKvmLaunchRequest(request) || isMaterialSourceRequest(request)) {
    return !isCriticalResponseBodyMissing(request);
  }
  return !isCriticalResponseBodyMissing(request) || Boolean(request.responseBodyCaptured);
}

export function isMaterialSourceRequest(request: HttpRequestRecord) {
  if (isKeyAdapterSourceUrl(request.url)) return true;
  return (
    /^(?:script|document)$/i.test(request.resourceType) &&
    /kvm|viewer|console|worker|h5|html5|vkvm/i.test(request.url)
  );
}

/** 未完成时会影响离线适配资料完整性的请求：登录、KVM 启动/Token、Viewer/Worker 源码。 */
export function isMaterialIncompleteRequest(request: HttpRequestRecord) {
  if (request.tags.includes('login')) return true;
  if (isExplicitKvmLaunchRequest(request, false)) return true;
  return isMaterialSourceRequest(request);
}

function hasCompleteTwin(
  request: HttpRequestRecord,
  requests: HttpRequestRecord[],
  inFlightIds: Set<string>,
) {
  const identity = normalizeHttpRequestIdentity(request.method, request.url);
  return requests.some(other => {
    if (other.id === request.id) return false;
    if (inFlightIds.has(other.id)) return false;
    if (normalizeHttpRequestIdentity(other.method, other.url) !== identity) return false;
    return isCompleteSuccessfulCapture(other);
  });
}

export function materialInFlightRequestIds(
  inFlightRequestIds: string[] | undefined,
  requests: HttpRequestRecord[] | undefined,
) {
  const inFlightIds = new Set(inFlightRequestIds || []);
  const allRequests = requests || [];
  const byId = new Map(allRequests.map(request => [request.id, request]));
  const material: string[] = [];
  for (const id of inFlightIds) {
    const request = byId.get(id);
    if (!request) {
      material.push(id);
      continue;
    }
    if (hasCompleteTwin(request, allRequests, inFlightIds)) continue;
    if (isMaterialIncompleteRequest(request)) {
      material.push(id);
    }
  }
  return material;
}
