import type { HttpRequestRecord } from './createNetworkRecorder';

export const SOURCE_TEXT_SAMPLE_LIMIT = 64 * 1024;
export const SOURCE_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
export const SOURCE_MAX_FILES = 24;
export const SOURCE_TOTAL_BUDGET_BYTES = 8 * 1024 * 1024;
export const SOURCE_REFERENCED_LIMIT = 256;
// 24 文件 / 8 MiB 是硬上限：现场代表机（惠普约 9、新戴尔 4、旧戴尔最多约 20）未超。
// 超过后重复采集也无法变成 YES，清单会明确提示不要反复重采。

export type SourceKind = 'javascript' | 'html';

export interface SourceFileRecord {
  id: string;
  url: string;
  kind: SourceKind;
  sha256: string;
  bytes: number;
  truncated: boolean;
  text: string;
  captureWindowId?: string;
  windowRole?: string;
}

export interface PageReferencedScript {
  url: string;
  kind: SourceKind;
  initiator?: string;
  captureWindowId?: string;
  windowRole?: string;
}

const SENSITIVE_QUERY_KEY_RE =
  /password|passwd|pwd|token|csrf|cookie|sessionid|session_id|qsessionid|uniqueid|authparam|garc|x-auth-token/i;

const ADAPTER_SOURCE_HINT =
  /kvm|viewer|console|vnc|irc|vconsole|h5|encrypt|login|session|auth|websocket|vkvm|html5/i;

const VIEWER_SOURCE_HINT =
  /kvm|viewer|console|vnc|irc|vconsole|h5|html5|vkvm|websocket|encrypt/i;

const VENDOR_LIBRARY_HINT =
  /(?:^|\/)(?:jquery|bootstrap|lodash|underscore|moment|webfont|fontawesome|chart\.min|d3\.min)(?:[-./]|$)|cdnjs|jsdelivr|unpkg|googleapis/i;

const PRIMARY_BUNDLE_HINT = /\/(?:main|polyfills?|runtime)[^/]*\.m?js(?:[?#]|$)/i;
const WORKER_HINT = /worker/i;

export function isHtmlSourceText(text: string) {
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 512).toLowerCase();
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    /^<html[\s>]/.test(head) ||
    (head.includes('<head') && head.includes('<body'))
  );
}

export function isJavascriptSourceText(
  text: string,
  contentType = '',
  resourceType = '',
  url = '',
) {
  if (/^script$/i.test(resourceType)) return true;
  if (/javascript|ecmascript/i.test(contentType)) return true;
  if (/\.(?:m?js)(?:[?#]|$)/i.test(url) && /script/i.test(resourceType)) return true;
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 160);
  return /^(?:['"]use strict['"]|;?\s*(?:function|var |let |const |class |import |export |\/\*|\/\/)|!function|\(\s*function|\(\(\)\s*=>|void\s+function|webpackChunk|self\.webpackChunk)/.test(
    head,
  );
}

export function classifySourceKind(
  text: string,
  contentType = '',
  resourceType = '',
  url = '',
): SourceKind | undefined {
  if (isHtmlSourceText(text)) return 'html';
  if (isJavascriptSourceText(text, contentType, resourceType, url)) return 'javascript';
  if (/^document$/i.test(resourceType) || /(?:text|application)\/(?:x-)?html/i.test(contentType)) {
    return 'html';
  }
  return undefined;
}

export function sourceFilePath(id: string, kind: SourceKind) {
  const safeId = id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'source';
  return `http/sources/${safeId}.${kind === 'html' ? 'html' : 'js'}`;
}

export function sourceUrlKey(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || '').split('#')[0].split('?')[0];
  }
}

export function sourceUrlIdentity(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY_RE.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return String(url || '').split('#')[0];
  }
}

export function isKeyAdapterSourceUrl(url: string) {
  return VIEWER_SOURCE_HINT.test(url) || PRIMARY_BUNDLE_HINT.test(url) || WORKER_HINT.test(url);
}

export function isViewerSourceContext(
  item: { windowRole?: string; captureWindowId?: string },
  viewerWindowIds: Iterable<string> = [],
) {
  const windowId = item.captureWindowId;
  if (!windowId) return false;
  for (const id of viewerWindowIds) {
    if (id && id === windowId) return true;
  }
  return false;
}

export function isLikelySourceUrl(url: string) {
  if (!url || /^(?:data|blob):/i.test(url)) return false;
  return /\.(?:m?js|html?)(?:[?#]|$)/i.test(url) || /(?:^|\/)(?:main|polyfills?|runtime|worker)[^/]*$/i.test(url);
}

export function isFirstPartyUrl(url: string, host?: string) {
  if (!host) return true;
  try {
    return new URL(url).hostname === host;
  } catch {
    return true;
  }
}

export function isSourceResourceRecord(request: HttpRequestRecord) {
  const contentType = request.responseContentType || '';
  return (
    /^(?:script|document)$/i.test(request.resourceType) ||
    /javascript|ecmascript|(?:text|application)\/(?:x-)?html/i.test(contentType)
  );
}

export function isFirstPartySource(request: HttpRequestRecord, host?: string) {
  return isFirstPartyUrl(request.url, host);
}

export function isViewerFirstPartySource(
  item: { url: string; windowRole?: string; captureWindowId?: string },
  input: { host?: string; viewerWindowIds?: Iterable<string> },
) {
  if (!isLikelySourceUrl(item.url) && !isKeyAdapterSourceUrl(item.url)) return false;
  if (VENDOR_LIBRARY_HINT.test(item.url)) return false;
  if (!isFirstPartyUrl(item.url, input.host)) return false;
  return isViewerSourceContext(item, input.viewerWindowIds || []);
}

export function isRequiredReferencedSource(
  item: PageReferencedScript | string,
  input: { host?: string; unclassified: boolean; viewerWindowIds?: Iterable<string> },
) {
  const record = typeof item === 'string' ? { url: item } : item;
  const url = record.url;
  if (!isLikelySourceUrl(url) && !isKeyAdapterSourceUrl(url)) return false;
  if (VENDOR_LIBRARY_HINT.test(url)) return false;
  if (!isFirstPartyUrl(url, input.host)) return false;
  if (!input.unclassified) return ADAPTER_SOURCE_HINT.test(url);
  return isKeyAdapterSourceUrl(url) || isViewerFirstPartySource(record, input);
}

export function adapterSourceCandidates(
  requests: HttpRequestRecord[],
  input: { host?: string; unclassified: boolean; viewerWindowIds?: Iterable<string> },
) {
  const sources = requests.filter(isSourceResourceRecord);
  const keywordHits = sources.filter(request => ADAPTER_SOURCE_HINT.test(request.url));
  if (!input.unclassified) return keywordHits;
  const byId = new Map<string, HttpRequestRecord>();
  for (const request of sources) {
    if (VENDOR_LIBRARY_HINT.test(request.url)) continue;
    if (!isFirstPartySource(request, input.host)) continue;
    const keyDep = isKeyAdapterSourceUrl(request.url);
    const viewerFirstParty = isViewerFirstPartySource(request, input);
    if (!keyDep && !viewerFirstParty) continue;
    byId.set(request.id, request);
  }
  return [...byId.values()];
}

function pickBestSourceRequest(requests: HttpRequestRecord[]) {
  return requests.find(request => isCompleteAdapterSource(request)) || requests.at(-1);
}

export function matchSourceRequest(
  requests: HttpRequestRecord[],
  url: string,
  context?: { captureWindowId?: string; windowRole?: string },
) {
  const identity = sourceUrlIdentity(url);
  const matches = requests.filter(request => sourceUrlIdentity(request.url) === identity);
  if (!matches.length) return undefined;
  if (context?.captureWindowId) {
    const sameWindow = matches.filter(request => request.captureWindowId === context.captureWindowId);
    if (sameWindow.length) return pickBestSourceRequest(sameWindow);
    return pickBestSourceRequest(matches.filter(request => !request.captureWindowId));
  }
  if (context?.windowRole) {
    const sameRole = matches.filter(request => request.windowRole === context.windowRole);
    if (sameRole.length) return pickBestSourceRequest(sameRole);
    return pickBestSourceRequest(matches.filter(request => !request.windowRole));
  }
  return pickBestSourceRequest(matches);
}

export function pageScriptsEventsTruncated(
  events: Array<{ type?: string; truncated?: unknown }> | null | undefined,
) {
  return (events || []).some(event => event.type === 'page-scripts' && event.truncated === true);
}

export function pageReferencedScriptsFromEvents(
  events:
    | Array<{
        type?: string;
        scripts?: unknown;
        captureWindowId?: unknown;
        windowRole?: unknown;
      }>
    | null
    | undefined,
): PageReferencedScript[] {
  const byKey = new Map<string, PageReferencedScript>();
  for (const event of events || []) {
    if (event.type !== 'page-scripts' || !Array.isArray(event.scripts)) continue;
    const eventWindowId = typeof event.captureWindowId === 'string' ? event.captureWindowId : '';
    const eventWindowRole = typeof event.windowRole === 'string' ? event.windowRole : '';
    for (const item of event.scripts) {
      if (!item || typeof item !== 'object') continue;
      const record = item as PageReferencedScript;
      if (typeof record.url !== 'string' || !record.url) continue;
      const captureWindowId = record.captureWindowId || eventWindowId;
      const windowRole = record.windowRole || eventWindowRole;
      const key = `${sourceUrlIdentity(record.url)}|${captureWindowId}|${windowRole}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          url: record.url,
          kind: record.kind === 'html' ? 'html' : 'javascript',
          ...(record.initiator ? { initiator: record.initiator } : {}),
          ...(captureWindowId ? { captureWindowId } : {}),
          ...(windowRole ? { windowRole } : {}),
        });
      }
    }
  }
  return [...byKey.values()];
}

export function collectReferencedScriptsFromFacts(input: {
  scriptSrcs?: string[];
  performanceEntries?: Array<{ name: string; initiatorType?: string }>;
  iframeSrcs?: string[];
}): PageReferencedScript[] {
  const byKey = new Map<string, PageReferencedScript>();
  const push = (url: string, kind: SourceKind, initiator: string) => {
    if (!url || /^(?:data|blob):/i.test(url)) return;
    const key = sourceUrlIdentity(url);
    if (byKey.has(key)) return;
    byKey.set(key, { url, kind, initiator });
  };
  for (const src of input.scriptSrcs || []) {
    push(src, 'javascript', 'script-tag');
  }
  for (const entry of input.performanceEntries || []) {
    const name = String(entry.name || '');
    const initiator = String(entry.initiatorType || '');
    if (initiator === 'script' || initiator === 'worker' || isLikelySourceUrl(name)) {
      push(
        name,
        /\.html?(?:[?#]|$)/i.test(name) ? 'html' : 'javascript',
        initiator || 'performance',
      );
    }
  }
  for (const src of input.iframeSrcs || []) {
    push(src, 'html', 'iframe');
  }
  return [...byKey.values()];
}

export function sourceCapturePriority(input: {
  url: string;
  windowRole?: string;
  resourceType?: string;
}) {
  const url = input.url;
  let score = 0;
  if (input.windowRole === 'popup') score += 80;
  if (ADAPTER_SOURCE_HINT.test(url)) score += 60;
  if (PRIMARY_BUNDLE_HINT.test(url)) score += 50;
  if (/html5viewer|vconsole|kvmclient|irc\.js/i.test(url)) score += 40;
  if (/^document$/i.test(input.resourceType || '')) score += 20;
  if (WORKER_HINT.test(url)) score -= 25;
  return score;
}

export function isCompleteAdapterSource(request: HttpRequestRecord) {
  if (request.sourceTruncated) return false;
  const skip = request.responseBodySkippedReason || '';
  if (
    /^response-truncated:|^response-too-large:|^source-too-large-to-read:|^source-budget-exceeded:/.test(
      skip,
    )
  ) {
    return false;
  }
  if (request.responseBodyCaptured === false) return false;
  if (request.sourceSha256 && (request.sourceBytes || 0) > 0) return true;
  const sample = request.responseBodySummary.sample;
  if (typeof sample !== 'string') return false;
  if (sample.endsWith('<truncated>')) return false;
  return sample.trim().length >= 32;
}

export function sourceInventoryEvidence(request: HttpRequestRecord) {
  const hash = request.sourceSha256 ? `sha256=${request.sourceSha256.slice(0, 12)}` : 'sha256=missing';
  const bytes = `bytes=${request.sourceBytes ?? request.responseBodySummary.bytes}`;
  const truncated =
    request.sourceTruncated ||
    request.responseBodyCaptured === false ||
    /^response-truncated:|^response-too-large:|^source-too-large-to-read:|^source-budget-exceeded:/.test(
      request.responseBodySkippedReason || '',
    );
  return `${request.id}:${hash}:${bytes}:${truncated ? 'truncated' : 'complete'}`;
}

export function adapterSourceCoverage(input: {
  requests: HttpRequestRecord[];
  referenced: PageReferencedScript[];
  host?: string;
  unclassified: boolean;
  viewerWindowIds?: Iterable<string>;
  referencedTruncated?: boolean;
}) {
  const candidates = adapterSourceCandidates(input.requests, input);
  const requiredReferenced = input.referenced.filter(item =>
    isRequiredReferencedSource(item, input),
  );
  const missingReferenced = requiredReferenced.filter(
    item => !matchSourceRequest(input.requests, item.url, item),
  );
  const capturedRequired = requiredReferenced
    .map(item => matchSourceRequest(input.requests, item.url, item))
    .filter((request): request is HttpRequestRecord => Boolean(request));
  const incomplete = [...new Set([...candidates, ...capturedRequired])].filter(
    request => !isCompleteAdapterSource(request),
  );
  return {
    candidates,
    requiredReferenced,
    missingReferenced,
    incomplete,
    referencedTruncated: Boolean(input.referencedTruncated),
  };
}

function matchSourceFile(files: SourceFileRecord[], item: PageReferencedScript) {
  const matches = files.filter(file => sourceUrlIdentity(file.url) === sourceUrlIdentity(item.url));
  if (item.captureWindowId) {
    return (
      matches.find(file => file.captureWindowId === item.captureWindowId) ||
      matches.find(file => !file.captureWindowId)
    );
  }
  if (matches.length === 1) return matches[0];
  return matches.find(file => !file.captureWindowId);
}

export function buildSourceInventory(input: {
  sourceFiles: SourceFileRecord[];
  referenced: PageReferencedScript[];
  requests?: HttpRequestRecord[];
  host?: string;
  unclassified?: boolean;
  viewerWindowIds?: Iterable<string>;
}) {
  const files = input.sourceFiles.map(file => ({
    id: file.id,
    url: file.url,
    kind: file.kind,
    sha256: file.sha256,
    bytes: file.bytes,
    truncated: file.truncated,
    path: sourceFilePath(file.id, file.kind),
    ...(file.captureWindowId ? { captureWindowId: file.captureWindowId } : {}),
    ...(file.windowRole ? { windowRole: file.windowRole } : {}),
  }));
  const coverageInput = {
    host: input.host,
    unclassified: Boolean(input.unclassified),
    viewerWindowIds: input.viewerWindowIds,
  };
  const referenced = input.referenced.map(item => {
    const matchedFile = matchSourceFile(input.sourceFiles, item);
    const request = matchSourceRequest(input.requests || [], item.url, item);
    const required = isRequiredReferencedSource(item, coverageInput);
    const captured = Boolean(matchedFile);
    return {
      url: item.url,
      kind: item.kind,
      ...(item.initiator ? { initiator: item.initiator } : {}),
      ...(item.captureWindowId ? { captureWindowId: item.captureWindowId } : {}),
      ...(item.windowRole ? { windowRole: item.windowRole } : {}),
      required,
      captured,
      missing: !captured,
      ...(request?.id ? { requestId: request.id } : matchedFile ? { requestId: matchedFile.id } : {}),
    };
  });
  const skipped = (input.requests || [])
    .filter(request =>
      /^source-too-large-to-read:|^source-budget-exceeded:/.test(request.responseBodySkippedReason || ''),
    )
    .map(request => ({
      url: request.url,
      requestId: request.id,
      bytes: request.sourceBytes ?? request.responseBodySummary.bytes,
      reason: request.responseBodySkippedReason || '',
    }));
  return {
    files,
    referenced,
    ...(skipped.length ? { skipped } : {}),
  };
}
