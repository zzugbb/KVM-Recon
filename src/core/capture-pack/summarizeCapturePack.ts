import JSZip from 'jszip';

import {
  validateChecklistShape,
  validateHttpRequestLineShape,
  validateManifestShape,
  validateWebSocketListShape,
} from './validateCapturePackShape';

export interface CapturePackSummary {
  family: string;
  readiness: string;
  host: string;
  port: number;
  jobId: string;
  httpRequestCount: number;
  webSocketCount: number;
  webSocketUrls: string[];
  screenshotRoles: string[];
  pathHits: string[];
  blockingItems: string[];
  schemaErrors: string[];
  observedVendor: string;
  observedProduct: string;
}

export interface CapturePackDiff {
  field: string;
  left: string;
  right: string;
  changed: boolean;
}

export interface CapturePackComparison {
  left: CapturePackSummary;
  right: CapturePackSummary;
  diffs: CapturePackDiff[];
}

async function readZipJson(zip: JSZip, path: string): Promise<unknown> {
  const file = zip.file(path);
  if (!file) return null;
  const text = await file.async('string');
  try {
    return JSON.parse(text);
  } catch (error) {
    // 捕获资料包内 JSON 损坏：现场 zip 可能被手工改过或传输截断
    // 策略：当作缺失文件，由 schemaErrors 提示，不抛出打断对比
    void error;
    return null;
  }
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) return '';
  return file.async('string');
}

function parseJsonl(text: string): unknown[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        // 捕获 jsonl 单行损坏：其余行仍可用于摘要
        // 策略：跳过该行，保留可解析记录
        void error;
        return null;
      }
    })
    .filter(item => item !== null);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function summarizeCapturePackZip(bytes: Uint8Array): Promise<CapturePackSummary> {
  const zip = await JSZip.loadAsync(bytes);
  const manifest = asRecord(await readZipJson(zip, 'manifest.json'));
  const checklist = asRecord(await readZipJson(zip, 'checklist.json'));
  const sockets = (await readZipJson(zip, 'ws/sockets.json')) ?? [];
  const screenshots = (await readZipJson(zip, 'page/screenshots.json')) ?? [];
  const pathEvidence = asRecord(await readZipJson(zip, 'probe/path-evidence.json'));
  const operatorObserved = asRecord(await readZipJson(zip, 'probe/operator-observed.json'));
  const requestLines = parseJsonl(await readZipText(zip, 'http/requests.jsonl'));

  const schemaErrors = [
    ...validateManifestShape(manifest),
    ...validateChecklistShape(Object.keys(checklist).length ? checklist : null),
    ...validateWebSocketListShape(sockets),
    ...requestLines.flatMap(line => validateHttpRequestLineShape(line)),
  ];

  const family = asRecord(manifest.family);
  const target = asRecord(manifest.target);
  const job = asRecord(manifest.job);
  const jobObserved = asRecord(job.observed);
  const readiness = asRecord(manifest.readiness);
  const items = Array.isArray(checklist.items) ? checklist.items : [];
  const socketList = Array.isArray(sockets) ? sockets : [];
  const screenshotList = Array.isArray(screenshots) ? screenshots : [];

  return {
    family: typeof family.primary === 'string' ? family.primary : '',
    readiness: typeof readiness.status === 'string' ? readiness.status : String(checklist.readiness || ''),
    host: typeof target.host === 'string' ? target.host : '',
    port: typeof target.port === 'number' ? target.port : 0,
    jobId: typeof job.id === 'string' ? job.id : '',
    httpRequestCount: requestLines.length,
    webSocketCount: socketList.length,
    webSocketUrls: socketList
      .map(item => (asRecord(item).url as string) || '')
      .filter(Boolean),
    screenshotRoles: [
      ...new Set(
        screenshotList
          .map(item => (asRecord(item).role as string) || '')
          .filter(Boolean),
      ),
    ],
    pathHits: Object.entries(pathEvidence)
      .filter(([, hit]) => hit === true)
      .map(([path]) => path),
    blockingItems: items
      .filter(item => {
        const record = asRecord(item);
        return record.severity === 'blocking' && record.status !== 'pass' && record.status !== 'not_applicable';
      })
      .map(item => String(asRecord(item).id || asRecord(item).title || '')),
    schemaErrors,
    observedVendor:
      (typeof operatorObserved.vendor === 'string' && operatorObserved.vendor) ||
      (typeof jobObserved.vendor === 'string' ? jobObserved.vendor : ''),
    observedProduct:
      (typeof operatorObserved.product === 'string' && operatorObserved.product) ||
      (typeof jobObserved.product === 'string' ? jobObserved.product : ''),
  };
}

function diffField(field: string, left: string, right: string): CapturePackDiff {
  return {
    field,
    left,
    right,
    changed: left !== right,
  };
}

export function compareCapturePacks(
  left: CapturePackSummary,
  right: CapturePackSummary,
): CapturePackComparison {
  return {
    left,
    right,
    diffs: [
      diffField('family', left.family, right.family),
      diffField('observedVendor', left.observedVendor, right.observedVendor),
      diffField('observedProduct', left.observedProduct, right.observedProduct),
      diffField('readiness', left.readiness, right.readiness),
      diffField('host', left.host, right.host),
      diffField('httpRequestCount', String(left.httpRequestCount), String(right.httpRequestCount)),
      diffField('webSocketCount', String(left.webSocketCount), String(right.webSocketCount)),
      diffField('webSocketUrls', left.webSocketUrls.join(', '), right.webSocketUrls.join(', ')),
      diffField('screenshotRoles', left.screenshotRoles.join(', '), right.screenshotRoles.join(', ')),
      diffField('pathHits', left.pathHits.join(', '), right.pathHits.join(', ')),
      diffField('blockingItems', left.blockingItems.join(', '), right.blockingItems.join(', ')),
    ],
  };
}
