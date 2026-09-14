import type { HttpRequestRecord } from './createNetworkRecorder';

export const SOURCE_TEXT_SAMPLE_LIMIT = 64 * 1024;
export const SOURCE_FILE_LIMIT_BYTES = 2 * 1024 * 1024;

export type SourceKind = 'javascript' | 'html';

export interface SourceFileRecord {
  id: string;
  url: string;
  kind: SourceKind;
  sha256: string;
  bytes: number;
  truncated: boolean;
  text: string;
}

const ADAPTER_SOURCE_HINT =
  /kvm|viewer|console|vnc|irc|vconsole|h5|encrypt|login|session|auth|websocket|vkvm|html5/i;

const VENDOR_LIBRARY_HINT =
  /(?:^|\/)(?:jquery|bootstrap|lodash|underscore|moment|polyfill|webfont|fontawesome|chart\.min|d3\.min)(?:[-./]|$)|cdnjs|jsdelivr|unpkg|googleapis/i;

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

export function isSourceResourceRecord(request: HttpRequestRecord) {
  const contentType = request.responseContentType || '';
  return (
    /^(?:script|document)$/i.test(request.resourceType) ||
    /javascript|ecmascript|(?:text|application)\/(?:x-)?html/i.test(contentType)
  );
}

export function isFirstPartySource(request: HttpRequestRecord, host?: string) {
  if (!host) return true;
  try {
    return new URL(request.url).hostname === host;
  } catch {
    return true;
  }
}

export function adapterSourceCandidates(
  requests: HttpRequestRecord[],
  input: { host?: string; unclassified: boolean },
) {
  const sources = requests.filter(isSourceResourceRecord);
  const keywordHits = sources.filter(request => ADAPTER_SOURCE_HINT.test(request.url));
  if (!input.unclassified) return keywordHits;
  const firstParty = sources.filter(
    request => isFirstPartySource(request, input.host) && !VENDOR_LIBRARY_HINT.test(request.url),
  );
  const byId = new Map<string, HttpRequestRecord>();
  for (const request of [...keywordHits, ...firstParty]) {
    byId.set(request.id, request);
  }
  return [...byId.values()];
}

export function isCompleteAdapterSource(request: HttpRequestRecord) {
  if (request.sourceTruncated) return false;
  const skip = request.responseBodySkippedReason || '';
  if (/^response-truncated:|^response-too-large:/.test(skip)) return false;
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
    /^response-truncated:|^response-too-large:/.test(request.responseBodySkippedReason || '');
  return `${request.id}:${hash}:${bytes}:${truncated ? 'truncated' : 'complete'}`;
}
