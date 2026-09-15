import { describe, expect, it } from 'vitest';

import { assembleCapturePackForExport } from './assembleCapturePackForExport';

const completeProbe = {
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

const completeNetwork = {
  httpRequests: [
    {
      id: 'login-1',
      timestamp: '2026-08-24T12:00:00.000+08:00',
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
      timestamp: '2026-08-24T12:00:02.000+08:00',
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
      createdAt: '2026-08-24T12:00:03.000+08:00',
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
      timestamp: '2026-08-24T12:00:03.100+08:00',
      direction: 'down' as const,
      opcode: 'binary' as const,
      bytes: 64,
      headHex: '17000001',
      sampled: true,
    },
  ],
};

const pageWithScreenshot = {
  jobId: 'job-export-001',
  events: [
    {
      type: 'selector-candidates',
      candidates: [{ role: 'kvm-entry', selector: '#kvm', confidence: 0.8 }],
      timestamp: '2026-08-24T12:00:01.000+08:00',
    },
    {
      type: 'screenshot',
      path: 'page/screenshots/viewer.png',
      role: 'viewer',
      timestamp: '2026-08-24T12:00:04.000+08:00',
    },
  ],
};

describe('assembleCapturePackForExport', () => {
  it('assembles a named Capture Pack with probe, network, profile, and readiness artifacts', () => {
    const result = assembleCapturePackForExport({
      jobId: 'job-export-001',
      startedAt: '2026-08-24T13:55:00.000+08:00',
      endedAt: '2026-08-24T14:05:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
    });

    expect(result.fileName).toBe('KVM-Recon_20260824-135500_10-0-0-10_ami-megarac_YES.zip');
    expect(result.pack.manifest.family.primary).toBe('ami-megarac');
    expect(result.pack.manifest.readiness.status).toBe('YES');
    expect(result.pack.reportHtml).toContain('离场适配就绪：YES');
    expect(result.pack.artifacts?.map(item => item.path)).toEqual(
      expect.arrayContaining([
        'probe/bmc-basic.json',
        'probe/redfish.json',
        'http/requests.jsonl',
        'http/capture-status.json',
        'ws/sockets.json',
        'page/timeline.jsonl',
        'artifacts/oem-profile.yaml',
        'README.md',
      ]),
    );
  });

  it('records network idle timeout details and downgrades a complete capture to PARTIAL', () => {
    const result = assembleCapturePackForExport({
      jobId: 'job-export-timeout',
      startedAt: '2026-08-24T13:55:00.000+08:00',
      endedAt: '2026-08-24T14:05:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      networkIdle: {
        timedOut: true,
        pendingTaskCount: 2,
        inFlightRequestIds: ['target-1::request-3'],
      },
    });

    expect(result.pack.manifest.readiness.status).toBe('PARTIAL');
    const statusArtifact = result.pack.artifacts?.find(
      item => item.path === 'http/capture-status.json',
    );
    expect(JSON.parse(String(statusArtifact?.content))).toEqual({
      timedOut: true,
      pendingTaskCount: 2,
      inFlightRequestIds: ['target-1::request-3'],
    });
  });

  it('keeps screenshot png bytes under page/screenshots/', () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const result = assembleCapturePackForExport({
      jobId: 'job-export-001',
      startedAt: '2026-08-24T13:55:00.000+08:00',
      endedAt: '2026-08-24T14:05:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
      screenshotArtifacts: [
        {
          path: 'page/screenshots/viewer.png',
          content: png,
        },
      ],
    });

    expect(result.pack.artifacts).toContainEqual({
      path: 'page/screenshots/viewer.png',
      content: png,
    });
  });

  it('writes operator-observed labels without changing kvmFamily', () => {
    const result = assembleCapturePackForExport({
      jobId: 'job-export-001',
      startedAt: '2026-08-24T13:55:00.000+08:00',
      endedAt: '2026-08-24T14:05:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      operatorObserved: {
        vendor: 'Huawei',
        product: '2288H V5',
        firmware: 'iBMC 3.10',
        location: 'A柜 U12',
        note: '铭牌与 Redfish 不一致',
      },
      probe: completeProbe,
      page: pageWithScreenshot,
      network: completeNetwork,
    });

    expect(result.pack.manifest.family.primary).toBe('ami-megarac');
    expect(result.pack.manifest.job.observed).toEqual({
      vendor: 'Huawei',
      product: '2288H V5',
      firmware: 'iBMC 3.10',
      location: 'A柜 U12',
    });
    expect(result.pack.manifest.job.operatorNote).toBe('铭牌与 Redfish 不一致');
    const observed = result.pack.artifacts?.find(item => item.path === 'probe/operator-observed.json');
    expect(observed).toBeDefined();
    expect(JSON.parse(String(observed?.content))).toMatchObject({
      source: 'operator',
      vendor: 'Huawei',
      product: '2288H V5',
    });
    const packReadme = result.pack.artifacts?.find(item => item.path === 'README.md');
    expect(String(packReadme?.content)).toContain('不能替代工具判定的采集桶');
  });

  it('counts only viewer screenshots in the pack README', () => {
    const result = assembleCapturePackForExport({
      jobId: 'job-export-001',
      startedAt: '2026-08-24T13:55:00.000+08:00',
      endedAt: '2026-08-24T14:05:00.000+08:00',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      probe: completeProbe,
      page: {
        jobId: 'job-export-001',
        events: [
          {
            type: 'selector-candidates',
            candidates: [{ role: 'kvm-entry', selector: '#kvm', confidence: 0.8 }],
            timestamp: '2026-08-24T12:00:01.000+08:00',
          },
          {
            type: 'screenshot',
            path: 'page/screenshots/login.png',
            role: 'login',
            timestamp: '2026-08-24T12:00:04.000+08:00',
          },
        ],
      },
      network: completeNetwork,
    });

    expect(result.pack.manifest.readiness.status).toBe('PARTIAL');
    const packReadme = result.pack.artifacts?.find(item => item.path === 'README.md');
    expect(String(packReadme?.content)).toContain('有没有 viewer 截图：没有');
    expect(String(packReadme?.content)).toContain('KVM 画面截图：0');
  });

  it('reclassifies export primary using TLS and KVM traffic even if probe still says AMI', () => {
    const result = assembleCapturePackForExport({
      jobId: 'job-export-openbmc',
      startedAt: '2026-08-25T14:00:00.000+08:00',
      endedAt: '2026-08-25T14:10:00.000+08:00',
      target: {
        host: 'bmc.example',
        port: 443,
        scheme: 'https',
      },
      probe: {
        ...completeProbe,
        basic: {
          ...completeProbe.basic,
          host: 'bmc.example',
          vendor: '',
          product: '',
        },
        paths: {
          apiRandomtag: false,
          apiSession: false,
          apiKvmToken: false,
          randomtag: true,
          kvmVideo: false,
          sessionService: true,
          kvmService: true,
          setKvmKey: false,
        },
        tls: {
          ...completeProbe.tls,
          certificate: {
            ...completeProbe.tls.certificate,
            subject: { O: 'OpenBMC', CN: 'bmc' },
            issuer: { O: 'OpenBMC', CN: 'bmc' },
          },
        },
      },
      page: {
        jobId: 'job-export-openbmc',
        events: [],
      },
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-08-25T14:00:10.000+08:00',
            method: 'POST',
            url: 'https://bmc.example/redfish/v1/SessionService/Sessions',
            resourceType: 'xhr',
            status: 201,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 32, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 64, redactedFields: ['Token'] },
            tags: ['login' as const],
          },
          {
            id: 'kvm-1',
            timestamp: '2026-08-25T14:00:12.000+08:00',
            method: 'GET',
            url: 'https://bmc.example/redfish/v1/Managers/1/KvmService',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: { bytes: 32, redactedFields: [] },
            tags: [],
          },
        ],
        webSockets: [
          {
            id: 'ws-sub',
            createdAt: '2026-08-25T14:00:13.000+08:00',
            url: 'wss://bmc.example/subscribe',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 0,
            textFrameCount: 1,
            tags: [],
          },
          {
            id: 'ws-kvm',
            createdAt: '2026-08-25T14:00:14.000+08:00',
            url: 'wss://bmc.example/kvm/video',
            subProtocols: ['token'],
            requestHeaders: {},
            binaryFrameCount: 8,
            textFrameCount: 0,
            tags: ['kvm-video' as const],
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-sub',
            timestamp: '2026-08-25T14:00:13.100+08:00',
            direction: 'up' as const,
            opcode: 'text' as const,
            bytes: 48,
            headHex: Buffer.from('{"paths":["/xyz/openbmc_project/', 'utf8').toString('hex'),
            sampled: true,
          },
        ],
      },
    });

    expect(result.pack.manifest.family.primary).toBe('openbmc-h5');
    expect(result.fileName).toContain('openbmc-h5');
    expect(result.pack.manifest.family.candidates.map(item => item.kvmFamily)).not.toContain('huawei-ibmc');
    expect(result.pack.manifest.family.candidates.map(item => item.kvmFamily)).not.toContain(
      'ami-megarac',
    );
  });

  it('writes independent Viewer source files into the capture pack', () => {
    const result = assembleCapturePackForExport({
      jobId: 'job-source',
      startedAt: '2026-09-14T12:00:00.000+08:00',
      endedAt: '2026-09-14T12:01:00.000+08:00',
      target: { host: '10.0.0.10', port: 443, scheme: 'https' },
      probe: completeProbe,
      page: {
        jobId: 'job-source',
        events: [],
      },
      network: {
        httpRequests: [],
        webSockets: [],
        webSocketFrames: [],
      },
      sourceFiles: [
        {
          id: 'viewer-js',
          url: 'https://10.0.0.10/html5viewer.js',
          kind: 'javascript',
          sha256: 'abc123',
          bytes: 21,
          truncated: false,
          text: 'function startKvm() {}',
        },
      ],
    });

    expect(result.pack.artifacts?.map(item => item.path)).toEqual(
      expect.arrayContaining(['http/sources.json', 'http/sources/viewer-js.js']),
    );
    expect(result.pack.artifacts?.find(item => item.path === 'http/sources/viewer-js.js')?.content).toBe(
      'function startKvm() {}',
    );
  });

  it('keeps Dell HTML5 traffic in unknown-h5 and records product hints without changing the zip name', () => {
    const result = assembleCapturePackForExport({
      jobId: 'job-export-dell',
      startedAt: '2026-09-15T10:00:00.000+08:00',
      endedAt: '2026-09-15T10:10:00.000+08:00',
      target: {
        host: '10.10.8.101',
        port: 443,
        scheme: 'https',
      },
      probe: {
        ...completeProbe,
        basic: {
          ...completeProbe.basic,
          host: '10.10.8.101',
          vendor: 'Dell',
          product: 'iDRAC',
        },
        paths: {
          apiRandomtag: false,
          apiSession: false,
          apiKvmToken: false,
        },
        familySignatures: {
          primary: 'unknown-h5' as const,
          confidence: 0,
          candidates: [],
        },
      },
      page: pageWithScreenshot,
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-09-15T10:01:00.000+08:00',
            method: 'POST',
            url: 'https://10.10.8.101/sysmgmt/2015/bmc/session',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 32, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 64, redactedFields: [] },
            tags: ['login' as const],
          },
        ],
        webSockets: [
          {
            id: 'ws-dell',
            createdAt: '2026-09-15T10:02:00.000+08:00',
            url: 'wss://10.10.8.101/vmc/vconsole',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 4,
            textFrameCount: 0,
            tags: ['kvm-video' as const],
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-dell',
            timestamp: '2026-09-15T10:02:00.100+08:00',
            direction: 'down' as const,
            opcode: 'binary' as const,
            bytes: 64,
            headHex: '524642203030332e303038',
            sampled: true,
          },
        ],
      },
    });

    expect(result.pack.manifest.family.primary).toBe('unknown-h5');
    expect(result.pack.manifest.family.productHints?.[0]?.productFamily).toBe('dell-idrac-h5');
    expect(result.fileName).toMatch(/^KVM-Recon_20260915-100000_10-10-8-101_unknown-h5_(YES|PARTIAL|NO)\.zip$/);
    expect(result.fileName).not.toContain('dell-idrac');
    const packReadme = String(result.pack.artifacts?.find(item => item.path === 'README.md')?.content);
    expect(packReadme).toContain('采集桶（`manifest.family.primary`）：unknown-h5');
    expect(packReadme).toContain('产品提示：dell-idrac-h5');
    expect(packReadme).toContain('产品提示不是已经确认的 Adapter，也不改变包名');
    expect(packReadme).toContain('probe/path-details.json');
    expect(packReadme).toContain('probe/product-hints.json');
    expect(packReadme).toContain('http/adapter-evidence.json');
  });
});
