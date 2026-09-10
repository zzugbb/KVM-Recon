import { describe, expect, it } from 'vitest';

import { buildReadinessChecklist } from '../readiness/buildReadinessChecklist';
import { scoreCapturedKvmFamily } from './detectKvmFamily';
import { detectProductHints } from './detectProductHints';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import type { HttpRequestRecord, WebSocketFrameRecord, WebSocketRecord } from '../network/createNetworkRecorder';

const baseProbe: ProbeBmcTargetResult = {
  basic: {
    host: 'field.example',
    port: 443,
    scheme: 'https',
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
  tls: {
    reachable: true,
    authorized: false,
    authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
    protocol: 'TLSv1.2',
    cipher: null,
    certificate: null,
  },
};

function http(id: string, url: string, tags: HttpRequestRecord['tags'] = []): HttpRequestRecord {
  return {
    id,
    timestamp: `2026-09-07T00:00:${id.replace(/\D/g, '').padStart(2, '0')}.000+08:00`,
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

function ws(id: string, url: string, options: Partial<WebSocketRecord> = {}): WebSocketRecord {
  return {
    id,
    createdAt: '2026-09-07T00:01:00.000+08:00',
    url,
    subProtocols: [],
    requestHeaders: {},
    binaryFrameCount: 1,
    textFrameCount: 0,
    tags: ['unknown'],
    windowRole: 'popup',
    ...options,
  };
}

function frame(socketId: string, headHex: string, magic = ''): WebSocketFrameRecord {
  return {
    socketId,
    timestamp: '2026-09-07T00:01:01.000+08:00',
    direction: 'down',
    opcode: 'binary',
    bytes: Math.max(1, headHex.length / 2),
    headHex,
    sampled: true,
    ...(magic ? { magic } : {}),
  };
}

describe('field capture regressions from existing on-site packs', () => {
  it('reclassifies H3C G6 HDM2 traffic as unknown-h5 instead of Huawei', () => {
    const probe = {
      ...baseProbe,
      basic: {
        ...baseProbe.basic,
        vendor: '',
        product: '',
      },
      paths: {
        apiRandomtag: true,
        apiSession: true,
        apiKvmToken: true,
        sessionService: true,
        kvmService: true,
        setKvmKey: true,
      },
    };
    const network = {
      httpRequests: [
        http(
          'login-1',
          'https://10.10.8.129/redfish/v1/SessionService/Actions/Oem/Public/SessionService.CreateSession',
          ['login'],
        ),
        http(
          'kvm-1',
          'https://10.10.8.129/redfish/v1/Managers/1/KvmService/Actions/Oem/Public/KvmService.StartH5Kvm',
          ['kvm-token'],
        ),
        http('asset-1', 'https://10.10.8.129/js/h5Kvm.a833a2a0.js', ['kvm-entry']),
      ],
      webSockets: [ws('ws-1', 'wss://10.10.8.129/kvm', { tags: ['kvm-video'], subProtocols: ['binary', 'base64'] })],
      webSocketFrames: [frame('ws-1', '530000000000000017000000')],
    };

    const family = scoreCapturedKvmFamily(probe, network);
    const hints = detectProductHints({
      observed: { vendor: 'H3C', product: 'H3C UniServer R4900 G6' },
      traffic: {
        httpUrls: network.httpRequests.map(item => item.url),
        webSocketUrls: network.webSockets.map(item => item.url),
        frameHeadHexes: network.webSocketFrames.map(item => item.headHex),
      },
    });

    expect(family.primary).toBe('unknown-h5');
    expect(family.candidates.map(item => item.kvmFamily)).not.toContain('huawei-ibmc');
    expect(hints[0]?.productFamily).toBe('h3c-hdm2');
  });

  it('does not suggest H3C HDM2 for H3C G3/G5 style AMI traffic with only shared /kvm evidence', () => {
    const hints = detectProductHints({
      observed: { vendor: 'H3C', product: 'H3C UniServer R4900 G5' },
      traffic: {
        httpUrls: ['https://10.10.8.10/api/session', 'https://10.10.8.10/api/kvm/token'],
        webSocketUrls: ['wss://10.10.8.10/kvm'],
      },
    });

    expect(hints.map(item => item.productFamily)).not.toContain('h3c-hdm2');
  });

  it('does not suggest Huawei legacy for modern Huawei identity without legacy protocol evidence', () => {
    const hints = detectProductHints({
      observed: { vendor: 'Huawei', product: 'iBMC V5' },
      traffic: {
        httpUrls: [
          'https://10.10.8.20/redfish/v1/SessionService/Sessions',
          'https://10.10.8.20/UI/Rest/Services/KVM/Start',
        ],
        webSocketUrls: ['wss://10.10.8.20/kvm/websocket'],
      },
    });

    expect(hints.map(item => item.productFamily)).not.toContain('huawei-ibmc-legacy');
  });

  it.each([
    ['Dell /vnc/vconsole', 'wss://10.10.8.101/vnc/vconsole', '524642203030332e3030380a', 'RFB 003.008'],
    ['Dell :5900/', 'wss://10.10.8.80:5900/', '415043500000004401000104', 'DELL_APCP'],
    ['Dell :5900/vkvm/', 'wss://10.10.8.88:5900/vkvm/', '415043500000004401000104', 'DELL_APCP'],
  ])('keeps %s as unknown-h5 with reliable KVM WS evidence', (_name, wsUrl, headHex, magic) => {
    const probe = {
      ...baseProbe,
      basic: {
        ...baseProbe.basic,
        vendor: 'Dell',
        product: 'Integrated Dell Remote Access Controller',
      },
      paths: {
        apiRandomtag: true,
        apiSession: true,
        apiKvmToken: true,
        kvmService: true,
        setKvmKey: true,
      },
    };
    const network = {
      httpRequests: [
        http('login-1', 'https://10.10.8.101/sysmgmt/2015/bmc/session', ['login']),
        http('kvm-1', 'https://10.10.8.101/sysmgmt/2015/server/vconsole', ['kvm-entry']),
      ],
      webSockets: [ws('ws-dell', wsUrl)],
      webSocketFrames: [frame('ws-dell', headHex, magic)],
    };
    const checklist = buildReadinessChecklist({
      probe,
      page: {
        jobId: 'field-dell',
        events: [{ type: 'screenshot', path: 'page/screenshots/viewer.png', role: 'viewer' }],
      },
      network,
      redaction: { status: 'pass', redactedFields: 1 },
    });
    const family = scoreCapturedKvmFamily(probe, network);

    expect(family.primary).toBe('unknown-h5');
    expect(checklist.items.find(item => item.id === 'ws.kvm.established')?.status).toBe('pass');
  });

  it('recognizes HPE iLO4 HTML5 IRC as unknown-h5 and waits for /wss/ircport frames', () => {
    const network = {
      httpRequests: [
        http('login-1', 'https://10.10.8.94/json/login_session', ['login']),
        http('irc-1', 'https://10.10.8.94/js/irc.js', ['kvm-entry']),
      ],
      webSockets: [ws('ws-ilo', 'wss://10.10.8.94/wss/ircport', { tags: ['kvm-video'] })],
      webSocketFrames: [frame('ws-ilo', '42454546010200d90f363034')],
    };
    const family = scoreCapturedKvmFamily(baseProbe, network);
    const hints = detectProductHints({
      observed: { vendor: 'HP', product: 'ProLiant XL450 Gen9 Server' },
      traffic: {
        httpUrls: network.httpRequests.map(item => item.url),
        webSocketUrls: network.webSockets.map(item => item.url),
      },
    });

    expect(family.primary).toBe('unknown-h5');
    expect(hints[0]?.productFamily).toBe('hpe-ilo-h5');
  });

  it('reclassifies Huawei legacy :2198/ traffic as Huawei and readiness can pass', () => {
    const network = {
      httpRequests: [
        http('login-1', 'https://10.10.8.107/UI/Rest/Login', ['login']),
        http('token-1', 'https://10.10.8.107/bmc/php/gettoken.php', ['kvm-token']),
        http('kvm-1', 'https://10.10.8.107/bmc/pages/remote/kvm_by_html5.html', ['kvm-entry']),
        http('asset-1', 'https://10.10.8.107/bmc/resources/js/module/remote/html5/kvmclient.js', [
          'kvm-entry',
        ]),
      ],
      webSockets: [ws('ws-hw', 'wss://10.10.8.107:2198/')],
      webSocketFrames: [frame('ws-hw', 'fef6000429e16aaf00004200', 'HUAWEI_KVM_FEF6')],
    };
    const family = scoreCapturedKvmFamily(baseProbe, network);
    const checklist = buildReadinessChecklist({
      probe: baseProbe,
      page: {
        jobId: 'field-huawei-legacy',
        events: [{ type: 'screenshot', path: 'page/screenshots/viewer.png', role: 'viewer' }],
      },
      network,
      redaction: { status: 'pass', redactedFields: 1 },
    });

    expect(family.primary).toBe('huawei-ibmc');
    expect(checklist.readiness).toBe('YES');
  });

  it('keeps generic HTML5 KVM traffic in unknown-h5 instead of not-h5', () => {
    const network = {
      httpRequests: [
        http('login-1', 'https://bmc.example/login', ['login']),
        http('viewer-1', 'https://bmc.example/console/html5viewer.html', ['kvm-entry']),
      ],
      webSockets: [ws('ws-generic', 'wss://bmc.example/console-stream', { tags: ['unknown'] })],
      webSocketFrames: [frame('ws-generic', '0102030405060708')],
    };

    expect(scoreCapturedKvmFamily(baseProbe, network).primary).toBe('unknown-h5');
  });
});
