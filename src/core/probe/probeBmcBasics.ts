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

export async function probeBmcBasics(input: ProbeBmcBasicsInput): Promise<ProbeBmcBasicsResult> {
  const redfish = await safeGet(input.httpClient, '/redfish/v1');
  const paths: NonNullable<ProbeSignatureInput['paths']> = {};

  await Promise.all(
    PATHS.map(async ([key, path]) => {
      const response = await safeGet(input.httpClient, path);
      paths[key] = isReachableStatus(response.status);
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
  };
}
