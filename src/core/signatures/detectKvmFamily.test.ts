import { describe, expect, it } from 'vitest';

import { detectKvmFamily } from './detectKvmFamily';

describe('detectKvmFamily', () => {
  it('detects AMI MegaRAC from /api paths and keeps it ahead of generic video paths', () => {
    const result = detectKvmFamily({
      paths: {
        apiRandomtag: true,
        apiSession: true,
        apiKvmToken: true,
        kvmVideo: true,
      },
    });

    expect(result.primary).toBe('ami-megarac');
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.candidates[0]).toMatchObject({
      kvmFamily: 'ami-megarac',
      evidence: ['/api/randomtag', '/api/session', '/api/kvm/token'],
    });
  });

  it('detects OpenBMC H5 when /kvm/video exists without AMI /api evidence', () => {
    const result = detectKvmFamily({
      paths: {
        randomtag: true,
        kvmVideo: true,
      },
    });

    expect(result.primary).toBe('openbmc-h5');
    expect(result.candidates[0].evidence).toEqual(['/randomtag', '/kvm/video']);
  });

  it('detects Huawei iBMC from Redfish vendor and KvmService evidence', () => {
    const result = detectKvmFamily({
      redfish: {
        vendor: 'Huawei',
        product: 'iBMC',
      },
      paths: {
        kvmService: true,
        setKvmKey: true,
      },
    });

    expect(result.primary).toBe('huawei-ibmc');
    expect(result.candidates[0].evidence).toEqual([
      'redfish.vendor=Huawei',
      'KvmService',
      'SetKvmKey',
    ]);
  });

  it('returns not-h5 when there is no HTML5 KVM path evidence', () => {
    const result = detectKvmFamily({
      redfish: {
        vendor: 'Unknown Vendor',
      },
      paths: {},
    });

    expect(result.primary).toBe('not-h5');
    expect(result.confidence).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it('returns unknown-h5 when HTML5 paths exist but no known family matches', () => {
    const result = detectKvmFamily({
      paths: {
        randomtag: true,
      },
    });

    expect(result.primary).toBe('unknown-h5');
    expect(result.candidates).toEqual([]);
  });
});
