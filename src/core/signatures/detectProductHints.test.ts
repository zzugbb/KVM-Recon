import { describe, expect, it } from 'vitest';

import { scoreCapturedKvmFamily } from './detectKvmFamily';
import { detectProductHints } from './detectProductHints';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import type { HttpRequestRecord, WebSocketFrameRecord, WebSocketRecord } from '../network/createNetworkRecorder';

function http(id: string, url: string, tags: HttpRequestRecord['tags'] = []): HttpRequestRecord {
  return {
    id,
    timestamp: '2026-09-15T14:00:00.000+08:00',
    method: 'GET',
    url,
    resourceType: 'xhr',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBodySummary: { bytes: 0, redactedFields: [] },
    responseBodySummary: { bytes: 32, redactedFields: [] },
    tags,
  };
}

function ws(id: string, url: string): WebSocketRecord {
  return {
    id,
    createdAt: '2026-09-15T14:00:01.000+08:00',
    url,
    subProtocols: ['binary'],
    requestHeaders: {},
    binaryFrameCount: 4,
    textFrameCount: 0,
    tags: ['kvm-video'],
  };
}

function frame(socketId: string, headHex: string): WebSocketFrameRecord {
  return {
    socketId,
    timestamp: '2026-09-15T14:00:01.100+08:00',
    direction: 'down',
    opcode: 'binary',
    bytes: Math.max(1, headHex.length / 2),
    headHex,
    sampled: true,
  };
}

const amiProbe: ProbeBmcTargetResult = {
  basic: {
    host: '10.0.0.10',
    port: 443,
    scheme: 'https',
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
    primary: 'ami-megarac',
    confidence: 0.9,
    candidates: [],
  },
  tls: {
    reachable: true,
    authorized: false,
    authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
    protocol: 'TLSv1.2',
    cipher: null,
    certificate: null,
  },
};

const blankProbe: ProbeBmcTargetResult = {
  ...amiProbe,
  basic: {
    ...amiProbe.basic,
    vendor: '',
    product: '',
    firmwareVersion: '',
  },
  paths: {},
  familySignatures: {
    primary: 'not-h5',
    confidence: 0,
    candidates: [],
  },
};

describe('detectProductHints', () => {
  it('does not emit unknown-h5 product hints for known AMI traffic with generic KVM words', () => {
    const network = {
      httpRequests: [
        http('login-1', 'https://10.0.0.10/api/session', ['login']),
        http('token-1', 'https://10.0.0.10/api/kvm/token', ['kvm-token']),
        http('viewer-1', 'https://10.0.0.10/html5viewer.html', ['kvm-entry']),
      ],
      webSockets: [ws('ws-1', 'wss://10.0.0.10/kvm')],
      webSocketFrames: [frame('ws-1', '17000001')],
    };

    expect(scoreCapturedKvmFamily(amiProbe, network).primary).toBe('ami-megarac');
    expect(
      detectProductHints({
        redfish: { vendor: 'AMI', product: 'MegaRAC' },
        observed: { vendor: 'AMI', product: 'MegaRAC SPX' },
        traffic: {
          httpUrls: network.httpRequests.map(item => item.url),
          webSocketUrls: network.webSockets.map(item => item.url),
          frameHeads: network.webSocketFrames.map(item => item.headHex),
        },
      }),
    ).toEqual([]);
  });

  it('keeps unclassified HTML5 traffic in the unknown-h5 capture bucket with empty product hints', () => {
    const network = {
      httpRequests: [
        http('login-1', 'https://bmc.example/login', ['login']),
        http('viewer-1', 'https://bmc.example/console/html5viewer.html', ['kvm-entry']),
      ],
      webSockets: [ws('ws-generic', 'wss://bmc.example/console-stream')],
      webSocketFrames: [frame('ws-generic', '0102030405060708')],
    };

    expect(scoreCapturedKvmFamily(blankProbe, network).primary).toBe('unknown-h5');
    expect(
      detectProductHints({
        traffic: {
          httpUrls: network.httpRequests.map(item => item.url),
          webSocketUrls: network.webSockets.map(item => item.url),
          frameHeads: network.webSocketFrames.map(item => item.headHex),
        },
      }),
    ).toEqual([]);
  });
});
