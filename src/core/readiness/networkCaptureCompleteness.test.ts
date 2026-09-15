import { describe, expect, it } from 'vitest';

import type { HttpRequestRecord } from '../network/createNetworkRecorder';
import {
  materialInFlightRequestIds,
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

  it('ignores a duplicate in-flight poll when a complete twin already exists', () => {
    const completed = request('kvm-1', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService');
    const poll = request('kvm-poll', 'https://10.128.6.235/redfish/v1/Managers/bmc/KvmService', {
      status: null,
      responseBodyCaptured: false,
      responseBodySummary: { bytes: 0, redactedFields: [] },
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
});
