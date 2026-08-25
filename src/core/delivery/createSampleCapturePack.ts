import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { assembleCapturePackForExport } from './assembleCapturePackForExport';
import { buildCapturePackZip } from '../capture-pack/buildCapturePackZip';

const sampleProbe = {
  basic: {
    host: '10.0.0.10',
    port: 443,
    scheme: 'https' as const,
    vendor: 'AMI',
    product: 'MegaRAC',
    firmwareVersion: '1.0.0',
  },
  paths: {
    apiRandomtag: true,
    apiSession: true,
    apiKvmToken: true,
  },
  familySignatures: {
    primary: 'ami-megarac' as const,
    confidence: 0.9,
    candidates: [
      {
        kvmFamily: 'ami-megarac' as const,
        confidence: 0.9,
        evidence: ['/api/randomtag', '/api/session', '/api/kvm/token'],
      },
    ],
  },
  redfish: {
    path: '/redfish/v1' as const,
    status: 200,
    reachable: true,
    vendor: 'AMI',
    product: 'MegaRAC',
    firmwareVersion: '1.0.0',
    rootFields: {
      Vendor: 'AMI',
      Product: 'MegaRAC',
      FirmwareVersion: '1.0.0',
    },
  },
  tls: {
    reachable: true,
    authorized: false,
    authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
    protocol: 'TLSv1.2',
    cipher: { name: 'AES128-GCM-SHA256', version: 'TLSv1.2' },
    certificate: {
      subject: { CN: 'bmc.local' },
      issuer: { CN: 'bmc.local' },
      subjectaltname: '',
      validFrom: 'Aug 24 00:00:00 2026 GMT',
      validTo: 'Aug 24 00:00:00 2027 GMT',
      selfSigned: true,
    },
  },
};

const sampleNetwork = {
  httpRequests: [
    {
      id: 'login-1',
      timestamp: '2026-08-24T13:55:00.000+08:00',
      method: 'POST',
      url: 'https://10.0.0.10/api/session',
      resourceType: 'xhr',
      status: 200,
      requestHeaders: {},
      responseHeaders: {},
      requestBodySummary: { bytes: 32, redactedFields: ['Password'] },
      responseBodySummary: { bytes: 64, redactedFields: ['CSRFToken'] },
      tags: ['login' as const],
    },
    {
      id: 'token-1',
      timestamp: '2026-08-24T13:55:02.000+08:00',
      method: 'GET',
      url: 'https://10.0.0.10/api/kvm/token',
      resourceType: 'xhr',
      status: 200,
      requestHeaders: {},
      responseHeaders: {},
      requestBodySummary: { bytes: 0, redactedFields: [] },
      responseBodySummary: { bytes: 32, redactedFields: ['token'] },
      tags: ['kvm-token' as const],
    },
  ],
  webSockets: [
    {
      id: 'ws-1',
      createdAt: '2026-08-24T13:55:03.000+08:00',
      closedAt: '2026-08-24T13:55:25.000+08:00',
      url: 'wss://10.0.0.10/kvm',
      subProtocols: ['binary'],
      requestHeaders: {},
      binaryFrameCount: 12,
      textFrameCount: 0,
      tags: ['kvm-video' as const],
    },
  ],
  webSocketFrames: [
    {
      socketId: 'ws-1',
      timestamp: '2026-08-24T13:55:03.100+08:00',
      direction: 'down' as const,
      opcode: 'binary' as const,
      bytes: 64,
      headHex: '17000001',
      sampled: true,
    },
  ],
};

const samplePage = {
  jobId: 'sample-job',
  events: [
    {
      type: 'selector-candidates',
      candidates: [{ role: 'kvm-entry', selector: '#kvm', confidence: 0.8 }],
      timestamp: '2026-08-24T13:55:01.000+08:00',
    },
  ],
};

export function createSampleCapturePack() {
  return assembleCapturePackForExport({
    jobId: 'sample-job',
    startedAt: '2026-08-24T13:55:00.000+08:00',
    endedAt: '2026-08-24T14:05:00.000+08:00',
    target: {
      host: '10.0.0.10',
      port: 443,
      scheme: 'https',
    },
    operatorNote: '样例包，仅用于说明导出目录与 README 格式。',
    operatorObserved: {
      vendor: 'AMI',
      product: 'MegaRAC SPX',
      firmware: '1.0.0',
      location: '实验室 A 柜',
      note: '样例包，仅用于说明导出目录与 README 格式。',
    },
    probe: sampleProbe,
    page: samplePage,
    network: sampleNetwork,
  });
}

export function diskContentFromArtifact(content: string | Uint8Array): string | Buffer {
  return typeof content === 'string' ? content : Buffer.from(content);
}

export async function writeSampleCapturePack(rootDir: string) {
  const assembled = createSampleCapturePack();
  const files: Array<{ path: string; content: string | Buffer }> = [
    {
      path: 'manifest.json',
      content: JSON.stringify(assembled.pack.manifest, null, 2),
    },
    {
      path: 'checklist.json',
      content: JSON.stringify(assembled.pack.checklist, null, 2),
    },
    {
      path: 'report.md',
      content: assembled.pack.reportMarkdown,
    },
    {
      path: 'report.html',
      content: assembled.pack.reportHtml || '',
    },
    ...(assembled.pack.artifacts ?? []).map(artifact => ({
      path: artifact.path,
      content: diskContentFromArtifact(artifact.content),
    })),
  ];

  for (const file of files) {
    const fullPath = join(rootDir, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }

  return {
    fileName: assembled.fileName,
    zip: await buildCapturePackZip(assembled.pack),
    files: files.map(file => file.path),
  };
}
