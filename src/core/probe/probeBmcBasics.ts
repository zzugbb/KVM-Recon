import type { BmcTarget } from './types';

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

export interface BmcBasicInfo extends BmcTarget {
  vendor: string;
  product: string;
  firmwareVersion: string;
}

export interface ProbeRedfishSummary {
  path: '/redfish/v1' | '/redfish/v1/';
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
  body?: Record<string, unknown>;
}

export interface ProbeBmcBasicsResult {
  basic: BmcBasicInfo;
  redfish: ProbeRedfishSummary;
}

interface ProbeBmcBasicsInput {
  target: BmcTarget;
  httpClient: ProbeHttpClient;
}

function isUsableResponse(response: ProbeHttpResponse): boolean {
  if (response.status < 200 || response.status >= 300) return false;
  const data = response.data;
  return data !== null && typeof data === 'object' && !Array.isArray(data);
}

function stringField(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof data[key] === 'string') return data[key];
  }
  return '';
}

async function safeGet(client: ProbeHttpClient, path: string): Promise<ProbeHttpResponse> {
  try {
    return await client.get(path);
  } catch {
    // Redfish is optional: a failed probe must never stop browser evidence capture.
    return { status: 0 };
  }
}

export async function probeBmcBasics(input: ProbeBmcBasicsInput): Promise<ProbeBmcBasicsResult> {
  let path: ProbeRedfishSummary['path'] = '/redfish/v1/';
  let response = await safeGet(input.httpClient, path);
  if (!isUsableResponse(response)) {
    const fallback = await safeGet(input.httpClient, '/redfish/v1');
    if (isUsableResponse(fallback)) {
      path = '/redfish/v1';
      response = fallback;
    }
  }

  const data = isUsableResponse(response) ? response.data as Record<string, unknown> : {};
  const vendor = stringField(data, ['Vendor', 'vendor']);
  const product = stringField(data, ['Product', 'product', 'Model', 'model']);
  const firmwareVersion = stringField(data, ['FirmwareVersion', 'firmwareVersion', 'Version', 'version']);
  const rootFields: ProbeRedfishSummary['rootFields'] = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      rootFields[key] = value;
    }
  }
  const oem = data.Oem && typeof data.Oem === 'object' && !Array.isArray(data.Oem)
    ? data.Oem as Record<string, unknown>
    : {};
  const contentType = response.headers?.['content-type'] ?? response.headers?.['Content-Type'];
  return {
    basic: { ...input.target, vendor, product, firmwareVersion },
    redfish: {
      path,
      status: response.status,
      reachable: isUsableResponse(response),
      contentType: Array.isArray(contentType) ? contentType.join(', ') : contentType,
      redirected: Boolean(response.redirected),
      redirectLocation: response.redirectLocation || '',
      vendor,
      product,
      firmwareVersion,
      rootFields,
      oemKeys: Object.keys(oem),
      body: isUsableResponse(response) ? data : undefined,
    },
  };
}
