import { describe, expect, it } from 'vitest';

import { buildOemProfileArtifacts } from './buildOemProfileArtifacts';

const baseProbe = {
  basic: {
    host: '10.0.0.10',
    port: 443,
    scheme: 'https' as const,
    vendor: '',
    product: '',
    firmwareVersion: '',
  },
  paths: {},
  familySignatures: {
    primary: 'unknown-h5' as const,
    confidence: 0,
    candidates: [],
  },
  tls: {
    reachable: true,
    authorized: false,
    authorizationError: '',
    protocol: 'TLSv1.2',
    cipher: null,
    certificate: null,
  },
};

const emptyNetwork = {
  httpRequests: [],
  webSockets: [],
  webSocketFrames: [],
};

describe('buildOemProfileArtifacts', () => {
  it('builds an AMI MegaRAC profile draft from token API, cookies, CSRF, and KVM WS facts', () => {
    const artifacts = buildOemProfileArtifacts({
      probe: {
        ...baseProbe,
        paths: { apiRandomtag: true, apiSession: true, apiKvmToken: true },
        familySignatures: {
          primary: 'ami-megarac',
          confidence: 0.9,
          candidates: [
            {
              kvmFamily: 'ami-megarac',
              confidence: 0.9,
              evidence: ['/api/randomtag', '/api/session', '/api/kvm/token'],
            },
          ],
        },
      },
      network: {
        httpRequests: [
          {
            id: 'login-1',
            timestamp: '2026-08-24T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://10.0.0.10/api/session',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: { Cookie: 'QSESSIONID=<redacted:len:32>' },
            responseHeaders: { 'set-cookie': 'QSESSIONID=<redacted:len:32>; Path=/' },
            requestBodySummary: { bytes: 32, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 64, redactedFields: ['CSRFToken', 'privilege'] },
            tags: ['login'],
          },
          {
            id: 'token-1',
            timestamp: '2026-08-24T12:00:02.000+08:00',
            method: 'GET',
            url: 'https://10.0.0.10/api/kvm/token',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: { 'X-CSRFTOKEN': '<redacted:len:32>' },
            responseHeaders: {},
            requestBodySummary: { bytes: 0, redactedFields: [] },
            responseBodySummary: { bytes: 32, redactedFields: ['token'] },
            tags: ['kvm-token'],
          },
        ],
        webSockets: [
          {
            id: 'ws-1',
            createdAt: '2026-08-24T12:00:03.000+08:00',
            url: 'wss://10.0.0.10/kvm',
            subProtocols: ['binary'],
            requestHeaders: {},
            binaryFrameCount: 8,
            textFrameCount: 0,
            tags: ['kvm-video'],
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-1',
            timestamp: '2026-08-24T12:00:03.100+08:00',
            direction: 'down',
            opcode: 'binary',
            bytes: 64,
            headHex: '17000001',
            sampled: true,
          },
        ],
      },
    });

    expect(artifacts.map(artifact => artifact.path)).toEqual(['artifacts/oem-profile.yaml']);
    expect(artifacts[0].content).toContain('kvmFamily: ami-megarac');
    expect(artifacts[0].content).toContain('- QSESSIONID');
    expect(artifacts[0].content).toContain('- CSRFToken');
    expect(artifacts[0].content).toContain('tokenApi: /api/kvm/token');
    expect(artifacts[0].content).toContain('- /kvm');
    expect(artifacts[0].content).toContain('- binary');
    expect(artifacts[0].content).toContain('- privilege');
    expect(artifacts[0].content).not.toContain('secret');
  });

  it('builds a Huawei iBMC profile draft from Redfish and KVM service facts', () => {
    const artifacts = buildOemProfileArtifacts({
      probe: {
        ...baseProbe,
        basic: { ...baseProbe.basic, vendor: 'Huawei', product: 'iBMC' },
        paths: { sessionService: true, kvmService: true, setKvmKey: true },
        familySignatures: {
          primary: 'huawei-ibmc',
          confidence: 0.88,
          candidates: [
            {
              kvmFamily: 'huawei-ibmc',
              confidence: 0.88,
              evidence: ['redfish.vendor=Huawei', 'KvmService', 'SetKvmKey'],
            },
          ],
        },
      },
      network: {
        httpRequests: [
          {
            id: 'set-key',
            timestamp: '2026-08-24T12:00:02.000+08:00',
            method: 'POST',
            url: 'https://10.0.0.10/redfish/v1/Managers/1/KvmService/Actions/KvmService.SetKvmKey',
            resourceType: 'xhr',
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            requestBodySummary: { bytes: 80, redactedFields: ['KvmKey'] },
            responseBodySummary: { bytes: 16, redactedFields: [] },
            tags: ['kvm-token'],
          },
        ],
        webSockets: [
          {
            id: 'ws-hw',
            createdAt: '2026-08-24T12:00:03.000+08:00',
            url: 'wss://10.0.0.10:2198/websocket',
            subProtocols: [],
            requestHeaders: {},
            binaryFrameCount: 4,
            textFrameCount: 0,
            tags: ['kvm-video'],
          },
        ],
        webSocketFrames: [
          {
            socketId: 'ws-hw',
            timestamp: '2026-08-24T12:00:03.100+08:00',
            direction: 'down',
            opcode: 'binary',
            bytes: 32,
            headHex: '48574b56',
            sampled: true,
          },
        ],
      },
    });

    expect(artifacts[0].content).toContain('kvmFamily: huawei-ibmc');
    expect(artifacts[0].content).toContain('redfishLogin: /redfish/v1/SessionService');
    expect(artifacts[0].content).toContain('kvmService: /redfish/v1/Managers/1/KvmService');
    expect(artifacts[0].content).toContain('setKvmKey: /redfish/v1/Managers/1/KvmService/Actions/KvmService.SetKvmKey');
    expect(artifacts[0].content).toContain('kvmPort: 2198');
    expect(artifacts[0].content).toContain('- 48574b56');
  });

  it('builds an OpenBMC H5 profile draft from SessionService, X-Auth-Token, UNIQUEID, and video WS facts', () => {
    const artifacts = buildOemProfileArtifacts({
      probe: {
        ...baseProbe,
        paths: { sessionService: true, kvmVideo: true },
        familySignatures: {
          primary: 'openbmc-h5',
          confidence: 0.82,
          candidates: [
            {
              kvmFamily: 'openbmc-h5',
              confidence: 0.82,
              evidence: ['/redfish/v1/SessionService', '/kvm/video'],
            },
          ],
        },
      },
      network: {
        httpRequests: [
          {
            id: 'obmc-login',
            timestamp: '2026-08-24T12:00:00.000+08:00',
            method: 'POST',
            url: 'https://10.0.0.10/redfish/v1/SessionService/Sessions',
            resourceType: 'xhr',
            status: 201,
            requestHeaders: {},
            responseHeaders: { 'X-Auth-Token': '<redacted:len:32>' },
            requestBodySummary: { bytes: 40, redactedFields: ['Password'] },
            responseBodySummary: { bytes: 64, redactedFields: ['UNIQUEID'] },
            tags: ['login'],
          },
        ],
        webSockets: [
          {
            id: 'ws-obmc',
            createdAt: '2026-08-24T12:00:03.000+08:00',
            url: 'wss://10.0.0.10/kvm/video',
            subProtocols: ['binary'],
            requestHeaders: {},
            binaryFrameCount: 5,
            textFrameCount: 0,
            tags: ['kvm-video'],
          },
        ],
        webSocketFrames: [],
      },
    });

    expect(artifacts[0].content).toContain('kvmFamily: openbmc-h5');
    expect(artifacts[0].content).toContain('sessionService: /redfish/v1/SessionService');
    expect(artifacts[0].content).toContain('- X-Auth-Token');
    expect(artifacts[0].content).toContain('- UNIQUEID');
    expect(artifacts[0].content).toContain('videoPath: /kvm/video');
    expect(artifacts[0].content).toContain('- binary');
  });

  it('does not generate an empty OEM profile for unknown or not-h5 families', () => {
    const unknown = buildOemProfileArtifacts({
      probe: baseProbe,
      network: emptyNetwork,
    });
    const notH5 = buildOemProfileArtifacts({
      probe: {
        ...baseProbe,
        familySignatures: {
          primary: 'not-h5',
          confidence: 0,
          candidates: [],
        },
      },
      network: emptyNetwork,
    });

    expect(unknown[0]?.path).toBe('artifacts/notes.md');
    expect(unknown[0]?.content).toContain('dell-idrac-h5');
    expect(notH5[0]?.path).toBe('artifacts/notes.md');
    expect(notH5[0]?.content).toContain('primary=not-h5');
  });
});
