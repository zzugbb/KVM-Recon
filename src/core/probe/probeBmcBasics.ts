import type { CaptureTarget } from '../capture-pack/types';
import { detectKvmFamily, type ProbeSignatureInput } from '../signatures/detectKvmFamily';

export interface ProbeHttpResponse {
  status: number;
  data?: unknown;
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
  familySignatures: ReturnType<typeof detectKvmFamily>;
  redfish?: ProbeRedfishSummary;
}

export interface ProbeRedfishSummary {
  path: '/redfish/v1';
  status: number;
  reachable: boolean;
  vendor: string;
  product: string;
  firmwareVersion: string;
  rootFields: Record<string, string | number | boolean>;
}

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

function isReachableStatus(status: number) {
  return (status >= 200 && status < 300) || status === 401 || status === 403 || status === 405;
}

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

export function isApiPathHit(status: number, data: unknown): boolean {
  if (!isReachableStatus(status)) return false;
  if (isHtmlPayload(data)) return false;
  if (status === 401 || status === 403 || status === 405) return true;
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
  if (!(status >= 200 && status < 300)) return false;
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

export async function probeBmcBasics(input: ProbeBmcBasicsInput): Promise<ProbeBmcBasicsResult> {
  const redfish = await safeGet(input.httpClient, '/redfish/v1');
  const paths: NonNullable<ProbeSignatureInput['paths']> = {};

  await Promise.all(
    PATHS.map(async ([key, path]) => {
      const response = await safeGet(input.httpClient, path);
      paths[key] =
        key === 'kvmVideo'
          ? isKvmVideoPathHit(response.status, response.data)
          : isApiPathHit(response.status, response.data);
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
    familySignatures,
    redfish: {
      path: '/redfish/v1',
      status: redfish.status,
      reachable: isApiPathHit(redfish.status, redfish.data),
      vendor,
      product,
      firmwareVersion,
      rootFields: primitiveRootFields(redfish.data),
    },
  };
}
