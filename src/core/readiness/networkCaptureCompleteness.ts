import type { HttpRequestRecord, PendingNetworkTask } from '../network/createNetworkRecorder';
import { isKeyAdapterSourceUrl } from '../network/sourceCapture';
import {
  isCriticalRequestBodyMissing,
  isCriticalResponseBodyMissing,
  isExplicitKvmLaunchRequest,
  sameCaptureContext,
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
  return !isCriticalResponseBodyMissing(request);
}

export function isMaterialSourceRequest(request: HttpRequestRecord) {
  const looksLikeSource =
    /^(?:script|document)$/i.test(request.resourceType) ||
    /\.(?:m?js|html?)(?:[?#]|$)/i.test(request.url);
  if (!looksLikeSource) return false;
  return isKeyAdapterSourceUrl(request.url);
}

/** OpenBMC/华为会反复查询 KvmService 资源；不含一次性 Action / Token。 */
export function isRepeatableKvmPollRequest(request: HttpRequestRecord) {
  const url = request.url.toLowerCase();
  if (/\/actions\//i.test(url) || /setkvmkey|starth5kvm/i.test(url)) return false;
  if (/\/api\/kvm\/token|h5viewercfg|\/bmc\/php\/gettoken\.php/i.test(url)) return false;
  if (request.tags.includes('login') || isMaterialSourceRequest(request)) return false;
  return /kvmservice/i.test(url);
}

/** 未完成时会影响离线适配资料完整性的请求：登录、KVM 启动/Token、Viewer/Worker 源码。 */
export function isMaterialIncompleteRequest(request: HttpRequestRecord) {
  if (request.tags.includes('login')) return true;
  if (isExplicitKvmLaunchRequest(request, false)) return true;
  return isMaterialSourceRequest(request);
}

function hasRepeatablePollTwin(
  request: HttpRequestRecord,
  requests: HttpRequestRecord[],
  inFlightIds: Set<string>,
) {
  if (!isRepeatableKvmPollRequest(request)) return false;
  const identity = normalizeHttpRequestIdentity(request.method, request.url);
  return requests.some(other => {
    if (other.id === request.id) return false;
    if (inFlightIds.has(other.id)) return false;
    if (!isRepeatableKvmPollRequest(other)) return false;
    if (!sameCaptureContext(request, other)) return false;
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
    if (hasRepeatablePollTwin(request, allRequests, inFlightIds)) continue;
    if (isMaterialIncompleteRequest(request)) {
      material.push(id);
    }
  }
  return material;
}

export function materialPendingTaskIds(
  pendingTasks: PendingNetworkTask[] | undefined,
  requests: HttpRequestRecord[] | undefined,
  inFlightRequestIds?: string[],
) {
  const material: string[] = [];
  for (const task of pendingTasks || []) {
    if (task.kind === 'target-attach') {
      material.push(task.requestId ? `target-attach:${task.requestId}` : 'target-attach');
      continue;
    }
    if (!task.requestId) {
      material.push(task.kind || 'unknown');
      continue;
    }
    const request = (requests || []).find(item => item.id === task.requestId);
    if (!request) {
      material.push(task.requestId);
      continue;
    }
    if (hasRepeatablePollTwin(request, requests || [], new Set(inFlightRequestIds || []))) continue;
    if (isMaterialIncompleteRequest(request)) {
      material.push(task.requestId);
    }
  }
  return material;
}
