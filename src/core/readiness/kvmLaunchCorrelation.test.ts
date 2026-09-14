import { describe, expect, it } from 'vitest';

import {
  correlatedKvmLaunchHttpIds,
  correlatedLoginHttpIds,
  isCriticalResponseBodyMissing,
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
});
