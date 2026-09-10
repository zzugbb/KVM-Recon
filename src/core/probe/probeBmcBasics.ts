import type { CaptureTarget } from '../capture-pack/types';
import { detectKvmFamily, type ProbeSignatureInput } from '../signatures/detectKvmFamily';

export interface ProbeHttpResponse {
  status: number;
  data?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  redirected?: boolean;
  redirectLocation?: string;
}

export interface ProbeHttpClient {
  get(path: string): Promise<ProbeHttpResponse>;
}

export interface BmcBasicInfo {
  host: string;
  port: number;
  scheme: CaptureTarget['scheme'];
  vendor: string;
  product: string;
  firmwareVersion: string;
}

export interface ProbeBmcBasicsResult {
  basic: BmcBasicInfo;
  paths: NonNullable<ProbeSignatureInput['paths']>;
  pathDetails?: ProbePathDetails;
  familySignatures: ReturnType<typeof detectKvmFamily>;
  redfish?: ProbeRedfishSummary;
}

export interface ProbeRedfishSummary {
  path: '/redfish/v1';
  status: number;
  reachable: boolean;
  contentType?: string;
  redirected?: boolean;
  redirectLocation?: string;
  vendor: string;
  product: string;
  firmwareVersion: string;
  rootFields: Record<string, string | number | boolean>;
  oemKeys?: string[];
}

export interface ProbePathEvidenceDetail {
  path: string;
  status: number;
  hit: boolean;
  contentType: string;
  redirected: boolean;
  redirectLocation: string;
  bodyKind: 'json-object' | 'json-array' | 'text' | 'html' | 'empty' | 'other';
  jsonKeys: string[];
  jsonShape: Record<string, string>;
}

export type ProbePathDetails = Partial<
  Record<keyof NonNullable<ProbeSignatureInput['paths']>, ProbePathEvidenceDetail>
>;

interface ProbeBmcBasicsInput {
  target: CaptureTarget;
  httpClient: ProbeHttpClient;
}

const PATHS: Array<[keyof NonNullable<ProbeSignatureInput['paths']>, string]> = [
  ['apiRandomtag', '/api/randomtag'],
  ['apiSession', '/api/session'],
  ['apiKvmToken', '/api/kvm/token'],
  ['randomtag', '/randomtag'],
  ['kvmVideo', '/kvm/video'],
  ['sessionService', '/redfish/v1/SessionService'],
  ['kvmService', '/redfish/v1/Managers/1/KvmService'],
  ['setKvmKey', '/redfish/v1/Managers/1/KvmService/Actions/KvmService.SetKvmKey'],
];

function isHtmlPayload(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  const head = data
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 512)
    .toLowerCase();
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    /^<html[\s>]/.test(head) ||
    (head.includes('<head') && head.includes('<body'))
  );
}

function contentType(headers?: ProbeHttpResponse['headers']): string {
  if (!headers) return '';
  const value = headers['content-type'] ?? headers['Content-Type'];
  if (Array.isArray(value)) return value.join(', ');
  return String(value || '');
}

function bodyKind(data: unknown): ProbePathEvidenceDetail['bodyKind'] {
  if (data == null || data === '') return 'empty';
  if (isHtmlPayload(data)) return 'html';
  if (Array.isArray(data)) return 'json-array';
  if (data && typeof data === 'object') return 'json-object';
  if (typeof data === 'string') return 'text';
  return 'other';
}

function collectJsonKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(item => collectJsonKeys(item)))];
  }
  const record = value as Record<string, unknown>;
  return [...new Set(Object.keys(record).concat(...Object.values(record).flatMap(collectJsonKeys)))];
}

function jsonShape(data: unknown): Record<string, string> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    shape[key] = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  }
  return shape;
}

function is2xx(status: number) {
  return status >= 200 && status < 300;
}

function isGenericAuthWall(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  const text = String(record.error || record.message || '');
  return record.cc === 7 || /invalid authentication/i.test(text);
}

function hasAnyKey(data: unknown, keys: string[]) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return keys.some(key => record[key] != null);
}

function isApiPathHit(key: keyof NonNullable<ProbeSignatureInput['paths']>, status: number, data: unknown): boolean {
  if (!is2xx(status)) return false;
  if (isHtmlPayload(data)) return false;
  if (isGenericAuthWall(data)) return false;
  if (key === 'apiRandomtag') {
    return hasAnyKey(data, ['encrypt_ctrl', 'encryptCtrl', 'random']);
  }
  if (key === 'randomtag') {
    return hasAnyKey(data, ['OemString', 'encryptCtrl', 'random']);
  }
  if (key === 'apiKvmToken') {
    return hasAnyKey(data, ['token', 'session', 'client_ip', 'cc']);
  }
  if (key === 'apiSession') {
    return hasAnyKey(data, ['racsession_id', 'CSRFToken', 'privilege', 'extendedpriv', 'cc']);
  }
  if (key === 'sessionService') {
    return hasAnyKey(data, ['Sessions', 'ServiceEnabled', 'SessionTimeout', 'Members', '@odata.id']);
  }
  if (key === 'kvmService') {
    return hasAnyKey(data, ['Id', 'Name', 'Port', 'EncryptionEnabled', 'KvmService', 'Actions', 'Enabled', '@odata.id']);
  }
  if (key === 'setKvmKey') {
    return hasAnyKey(data, ['authParam', 'Id', 'SecretKey']) || /Base\.1\.0\.Success/i.test(String(data));
  }
  if (data && typeof data === 'object') return true;
  if (typeof data === 'number' || typeof data === 'boolean') return true;
  if (data == null || data === '') return false;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    return trimmed.length > 0 && trimmed.length < 2048 && !trimmed.includes('<');
  }
  return false;
}

function isKvmVideoPathHit(status: number, data: unknown): boolean {
  // /kvm/video 是 WS 升级口，GET 常返回 401/空页，不能当 OpenBMC 强证据
  if (!is2xx(status)) return false;
  if (isHtmlPayload(data)) return false;
  return Boolean(data) && typeof data === 'object';
}

function readStringField(data: unknown, keys: string[]): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

async function safeGet(httpClient: ProbeHttpClient, path: string): Promise<ProbeHttpResponse> {
  try {
    return await httpClient.get(path);
  } catch {
    // 捕获单路径探测失败：网络错误或 BMC 拒绝连接时仅判定该路径未命中
    return { status: 0 };
  }
}

function buildPathDetail(
  key: keyof NonNullable<ProbeSignatureInput['paths']>,
  path: string,
  response: ProbeHttpResponse,
): ProbePathEvidenceDetail {
  const hit =
    key === 'kvmVideo'
      ? isKvmVideoPathHit(response.status, response.data)
      : isApiPathHit(key, response.status, response.data);
  return {
    path,
    status: response.status,
    hit,
    contentType: contentType(response.headers),
    redirected: Boolean(response.redirected),
    redirectLocation: response.redirectLocation || '',
    bodyKind: bodyKind(response.data),
    jsonKeys: collectJsonKeys(response.data),
    jsonShape: jsonShape(response.data),
  };
}

function primitiveRootFields(data: unknown): Record<string, string | number | boolean> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = value;
    }
  }
  return fields;
}

function oemKeys(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const oem = (data as Record<string, unknown>).Oem;
  if (!oem || typeof oem !== 'object' || Array.isArray(oem)) return [];
  return Object.keys(oem);
}

export async function probeBmcBasics(input: ProbeBmcBasicsInput): Promise<ProbeBmcBasicsResult> {
  const redfish = await safeGet(input.httpClient, '/redfish/v1');
  const paths: NonNullable<ProbeSignatureInput['paths']> = {};
  const pathDetails: ProbePathDetails = {};

  await Promise.all(
    PATHS.map(async ([key, path]) => {
      const response = await safeGet(input.httpClient, path);
      const detail = buildPathDetail(key, path, response);
      pathDetails[key] = detail;
      paths[key] = detail.hit;
    }),
  );

  const vendor = readStringField(redfish.data, ['Vendor', 'vendor']);
  const product = readStringField(redfish.data, ['Product', 'product', 'Model', 'model']);
  const firmwareVersion = readStringField(redfish.data, [
    'FirmwareVersion',
    'firmwareVersion',
    'Version',
    'version',
  ]);

  const familySignatures = detectKvmFamily({
    redfish: {
      vendor,
      product,
    },
    paths,
  });

  return {
    basic: {
      host: input.target.host,
      port: input.target.port,
      scheme: input.target.scheme,
      vendor,
      product,
      firmwareVersion,
    },
    paths,
    pathDetails,
    familySignatures,
    redfish: {
      path: '/redfish/v1',
      status: redfish.status,
      reachable: is2xx(redfish.status) && !isHtmlPayload(redfish.data) && Boolean(redfish.data),
      contentType: contentType(redfish.headers),
      redirected: Boolean(redfish.redirected),
      redirectLocation: redfish.redirectLocation || '',
      vendor,
      product,
      firmwareVersion,
      rootFields: primitiveRootFields(redfish.data),
      oemKeys: oemKeys(redfish.data),
    },
  };
}
