import { describe, expect, it } from 'vitest';

import type { HttpRequestRecord } from '../network/createNetworkRecorder';
import {
  materialInFlightRequestIds,
  materialPendingTaskIds,
  normalizeHttpRequestIdentity,
} from './networkCaptureCompleteness';

function request(
  id: string,
  url: string,
  extra: Partial<HttpRequestRecord> = {},
): HttpRequestRecord {
  return {
    id,
    timestamp: '2026-09-15T07:00:00.000+08:00',
    method: 'POST',
    url,
    resourceType: 'xhr',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBodySummary: { bytes: 8, redactedFields: [] },
    responseBodySummary: { bytes: 32, redactedFields: [] },
    responseBodyCaptured: true,
    tags: ['kvm-token'],
    ...extra,
  };
}

describe('networkCaptureCompleteness', () => {
  it('normalizes method and URL identity without the hash', () => {
    expect(
      normalizeHttpRequestIdentity('post', 'https://BMC.example/KvmService#frag'),
    ).toBe('POST https://bmc.example/KvmService');
  });

  it('ignores a duplicate in-flight KvmService poll in the same window when a complete twin exists', () => {
    const completed = request('kvm-1', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService', {
      captureWindowId: 'win-main',
      tags: ['kvm-token'],
    });
    const poll = request('kvm-poll', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService', {
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
      captureWindowId: 'win-main',
      tags: ['kvm-token'],
    });
    expect(materialInFlightRequestIds(['kvm-poll'], [completed, poll])).toEqual([]);
  });

  it('keeps a unique in-flight KVM launch request material', () => {
    const token = request('token-1', 'https://10.128.4.88/api/kvm/token', {
      method: 'GET',
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
    });
    expect(materialInFlightRequestIds(['token-1'], [token])).toEqual(['token-1']);
  });

  it('does not let a completed login hide a later in-flight login', () => {
    const completed = request('login-1', 'https://10.0.0.10/api/session', {
      tags: ['login'],
      captureWindowId: 'win-main',
    });
    const retry = request('login-2', 'https://10.0.0.10/api/session', {
      tags: ['login'],
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
      captureWindowId: 'win-main',
    });
    expect(materialInFlightRequestIds(['login-2'], [completed, retry])).toEqual(['login-2']);
  });

  it('does not let a completed token or h5viewercfg hide a later in-flight launch request', () => {
    const token = request('token-1', 'https://10.128.4.88/api/kvm/token', {
      method: 'GET',
      captureWindowId: 'win-main',
    });
    const tokenRetry = request('token-2', 'https://10.128.4.88/api/kvm/token', {
      method: 'GET',
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
      captureWindowId: 'win-main',
    });
    const cfg = request('cfg-1', 'https://10.130.34.1/api/settings/media/h5viewercfg', {
      method: 'GET',
      captureWindowId: 'win-main',
    });
    const cfgRetry = request('cfg-2', 'https://10.130.34.1/api/settings/media/h5viewercfg', {
      method: 'GET',
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
      captureWindowId: 'win-main',
    });
    expect(materialInFlightRequestIds(['token-2'], [token, tokenRetry])).toEqual(['token-2']);
    expect(materialInFlightRequestIds(['cfg-2'], [cfg, cfgRetry])).toEqual(['cfg-2']);
  });

  it('does not treat a Worker in another window as a complete twin', () => {
    const workerA = request('worker-a', 'https://10.128.4.88/libs/kvm/ast/decode_worker.js', {
      method: 'GET',
      resourceType: 'script',
      tags: [],
      captureWindowId: 'popup-a',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
    });
    const workerB = request('worker-b', 'https://10.128.4.88/libs/kvm/ast/decode_worker.js', {
      method: 'GET',
      resourceType: 'script',
      tags: [],
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
      captureWindowId: 'popup-b',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
    });
    expect(materialInFlightRequestIds(['worker-b'], [workerA, workerB])).toEqual(['worker-b']);
  });

  it('keeps a KvmService poll material when the only complete twin is in a sibling window', () => {
    const completed = request('kvm-a', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService', {
      captureWindowId: 'popup-a',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      tags: ['kvm-token'],
    });
    const poll = request('kvm-b', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService', {
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
      captureWindowId: 'popup-b',
      openerCaptureWindowId: 'win-main',
      ancestorCaptureWindowIds: ['win-main'],
      tags: ['kvm-token'],
    });
    expect(materialInFlightRequestIds(['kvm-b'], [completed, poll])).toEqual(['kvm-b']);
  });

  it('only treats pending body reads as material when the request itself is material', () => {
    const heartbeat = request('hb-1', 'https://10.0.0.10/api/heartbeat', {
      method: 'GET',
      tags: [],
    });
    const token = request('token-1', 'https://10.0.0.10/api/kvm/token', { method: 'GET' });
    expect(
      materialPendingTaskIds([{ kind: 'response-body', requestId: 'hb-1' }], [heartbeat, token]),
    ).toEqual([]);
    expect(
      materialPendingTaskIds([{ kind: 'response-body', requestId: 'token-1' }], [heartbeat, token]),
    ).toEqual(['token-1']);
    expect(materialPendingTaskIds([{ kind: 'target-attach', requestId: 'worker-session' }], [])).toEqual(
      ['target-attach:worker-session'],
    );
  });

  it('does not treat a KvmService JSON poll as Viewer/Worker source', () => {
    const poll = request('kvm-1', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService', {
      tags: ['kvm-token'],
    });
    expect(materialInFlightRequestIds(['kvm-1'], [poll])).toEqual(['kvm-1']);
    const twin = request('kvm-2', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService', {
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
      tags: ['kvm-token'],
    });
    expect(materialInFlightRequestIds(['kvm-2'], [poll, twin])).toEqual([]);
  });
});
