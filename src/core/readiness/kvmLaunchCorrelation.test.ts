import { describe, expect, it } from 'vitest';

import {
  criticalPayloadGaps,
  correlatedKvmLaunchHttpIds,
  correlatedLoginHttpIds,
  isCriticalRequestBodyMissing,
  isCriticalResponseBodyMissing,
  isExplicitKvmLaunchRequest,
  sameCaptureContext,
} from './kvmLaunchCorrelation';
import type { HttpRequestRecord, WebSocketRecord } from '../network/createNetworkRecorder';

function http(
  id: string,
  url: string,
  extra: Partial<HttpRequestRecord> = {},
): HttpRequestRecord {
  return {
    id,
    timestamp: '2026-09-14T10:00:00.000+08:00',
    method: 'GET',
    url,
    resourceType: 'xhr',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBodySummary: { bytes: 0, redactedFields: [] },
    responseBodySummary: { bytes: 32, redactedFields: [] },
    tags: ['kvm-token'],
    ...extra,
  };
}

function socket(extra: Partial<WebSocketRecord> = {}): WebSocketRecord {
  return {
    id: 'ws-1',
    createdAt: '2026-09-14T10:00:02.000+08:00',
    url: 'wss://10.0.0.10/websocket',
    subProtocols: [],
    requestHeaders: {},
    binaryFrameCount: 1,
    textFrameCount: 0,
    tags: ['unknown'],
    ...extra,
  };
}

describe('kvmLaunchCorrelation', () => {
  it('treats a main-window token and child-window WebSocket as the same capture context', () => {
    const token = http('token-1', 'https://10.0.0.10/api/kvm/token', {
      captureWindowId: 'win-main',
      windowRole: 'main',
    });
    const child = socket({
      captureWindowId: 'popup-kvm',
      openerCaptureWindowId: 'win-main',
      windowRole: 'popup',
    });

    expect(sameCaptureContext(token, child)).toBe(true);
    expect(correlatedKvmLaunchHttpIds([token], child)).toEqual(['token-1']);
    expect(
      correlatedLoginHttpIds(
        [
          http('login-1', 'https://10.0.0.10/api/session', {
            tags: ['login'],
            method: 'POST',
            captureWindowId: 'win-main',
            windowRole: 'main',
          }),
        ],
        child,
      ),
    ).toEqual(['login-1']);
  });

  it('does not treat sibling popups as the same capture context', () => {
    const token = http('token-1', 'https://10.0.0.10/api/kvm/token', {
      captureWindowId: 'popup-kvm',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      windowRole: 'popup',
    });
    const help = socket({
      captureWindowId: 'popup-help',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      windowRole: 'popup',
    });

    expect(sameCaptureContext(token, help)).toBe(false);
    expect(correlatedKvmLaunchHttpIds([token], help)).toEqual([]);
  });

  it('correlates a main-window token through an intermediate launcher to a nested Viewer WebSocket', () => {
    const token = http('token-1', 'https://10.0.0.10/api/kvm/token', {
      captureWindowId: 'win-main',
      windowRole: 'main',
    });
    const viewer = socket({
      captureWindowId: 'popup-viewer',
      openerCaptureWindowId: 'popup-launch',
      ancestorCaptureWindowIds: ['popup-launch', 'win-main'],
      windowRole: 'popup',
    });

    expect(sameCaptureContext(token, viewer)).toBe(true);
    expect(correlatedKvmLaunchHttpIds([token], viewer)).toEqual(['token-1']);
  });

  it('treats loading-failed and oversized KVM responses as missing critical payloads', () => {
    expect(
      isCriticalResponseBodyMissing(
        http('token-1', 'https://10.0.0.10/api/kvm/token', {
          responseBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySkippedReason: 'loading-failed',
        }),
      ),
    ).toBe(true);
    expect(
      isCriticalResponseBodyMissing(
        http('token-2', 'https://10.0.0.10/api/kvm/token', {
          responseBodySummary: { bytes: 0, redactedFields: [] },
          responseBodySkippedReason: 'response-too-large:2000000',
        }),
      ),
    ).toBe(true);
  });

  it('treats AMI h5viewercfg as an explicit KVM launch API', () => {
    const cfg = http('cfg-1', 'https://10.130.34.1/api/settings/media/h5viewercfg', {
      tags: ['kvm-token'],
      captureWindowId: 'win-main',
      windowRole: 'main',
      responseBodySummary: {
        bytes: 96,
        redactedFields: ['token'],
        jsonKeys: ['token', 'session', 'server_ip', 'kvm_service_status'],
      },
    });
    const viewer = socket({
      url: 'wss://10.130.34.1/kvm',
      tags: ['kvm-video'],
      captureWindowId: 'popup-viewer',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      windowRole: 'popup',
    });

    expect(isExplicitKvmLaunchRequest(cfg)).toBe(true);
    expect(isExplicitKvmLaunchRequest({ ...cfg, tags: ['kvm-entry'] })).toBe(true);
    expect(correlatedKvmLaunchHttpIds([cfg], viewer)).toEqual(['cfg-1']);
  });

  it('accepts Dell iDRAC header credentials without inventing a POST body', () => {
    const login = http('login-dell', 'https://10.10.8.109/sysmgmt/2015/bmc/session', {
      method: 'POST',
      status: 201,
      tags: ['login'],
      requestHeaders: {
        user: '<redacted:sha256:user>',
        password: '<redacted:sha256:password>',
      },
      requestBodySummary: { bytes: 0, redactedFields: [] },
    });

    expect(isCriticalRequestBodyMissing(login)).toBe(false);
    expect(criticalPayloadGaps([login])).toEqual([]);
    expect(
      isCriticalRequestBodyMissing({
        ...login,
        requestHeaders: { user: '<redacted:sha256:user>' },
      }),
    ).toBe(true);
  });

  it('associates two concurrent Viewers by capture window lineage instead of request count', () => {
    const cfgA = http('cfg-a', 'https://10.130.34.1/api/settings/media/h5viewercfg', {
      captureWindowId: 'popup-a',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      windowRole: 'popup',
    });
    const cfgB = http('cfg-b', 'https://10.130.34.1/api/settings/media/h5viewercfg', {
      timestamp: '2026-09-14T10:00:01.000+08:00',
      captureWindowId: 'popup-b',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      windowRole: 'popup',
    });
    const wsA = socket({
      id: 'ws-a',
      url: 'wss://10.130.34.1/kvm',
      tags: ['kvm-video'],
      captureWindowId: 'popup-a',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      windowRole: 'popup',
    });
    const wsB = socket({
      id: 'ws-b',
      createdAt: '2026-09-14T10:00:03.000+08:00',
      url: 'wss://10.130.34.1/kvm',
      tags: ['kvm-video'],
      captureWindowId: 'popup-b',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      windowRole: 'popup',
    });

    expect(sameCaptureContext(cfgA, wsB)).toBe(false);
    expect(sameCaptureContext(cfgB, wsA)).toBe(false);
    expect(correlatedKvmLaunchHttpIds([cfgA, cfgB], wsA)).toEqual(['cfg-a']);
    expect(correlatedKvmLaunchHttpIds([cfgA, cfgB], wsB)).toEqual(['cfg-b']);
  });
});
