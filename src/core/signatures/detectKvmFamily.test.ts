import { describe, expect, it } from 'vitest';

import { detectKvmFamily, scoreCapturedKvmFamily, trafficEvidenceFromNetwork } from './detectKvmFamily';

describe('detectKvmFamily', () => {
  it('keeps AMI path-only evidence below known-family confidence without matching HTTP traffic', () => {
    const result = detectKvmFamily({
      paths: {
        apiRandomtag: true,
        apiSession: true,
        apiKvmToken: true,
        kvmVideo: true,
      },
    });

    expect(result.primary).toBe('ami-megarac');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.candidates[0]).toMatchObject({
      kvmFamily: 'ami-megarac',
      evidence: ['/api/randomtag', '/api/session', '/api/kvm/token'],
    });
  });

  it('raises AMI confidence when captured HTTP hits /api/session and /api/kvm/token', () => {
    const result = detectKvmFamily({
      paths: {
        apiRandomtag: true,
        apiSession: true,
        apiKvmToken: true,
      },
      traffic: {
        httpUrls: ['https://bmc.example/api/session', 'https://bmc.example/api/kvm/token'],
      },
    });

    expect(result.primary).toBe('ami-megarac');
    expect(result.confidence).toBe(0.9);
  });

  it('detects OpenBMC H5 when /kvm/video exists without AMI /api evidence', () => {
    const result = detectKvmFamily({
      paths: {
        randomtag: true,
        kvmVideo: true,
      },
    });

    expect(result.primary).toBe('openbmc-h5');
    expect(result.candidates[0].evidence).toEqual(['/kvm/video', '/randomtag']);
  });

  it('does not drop OpenBMC just because AMI /api path bits are set', () => {
    const result = detectKvmFamily({
      paths: {
        apiRandomtag: true,
        apiSession: true,
        randomtag: true,
        kvmVideo: true,
        sessionService: true,
      },
    });

    expect(result.candidates.map(item => item.kvmFamily)).toContain('openbmc-h5');
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

  it('classifies OpenBMC-based H5 with Huawei-style KvmService traffic as openbmc-h5, not AMI', () => {
    const result = detectKvmFamily({
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
        organization: 'OpenBMC',
      },
      traffic: {
        httpUrls: [
          'https://bmc.example/redfish/v1/SessionService/Sessions',
          'https://bmc.example/redfish/v1/Managers/1/KvmService',
        ],
        webSocketUrls: ['wss://bmc.example/subscribe', 'wss://bmc.example/kvm/video'],
        frameHeads: ['{"paths":["/xyz/openbmc_project/'],
      },
    });

    expect(result.primary).toBe('openbmc-h5');
    expect(result.candidates.map(item => item.kvmFamily)).not.toContain('huawei-ibmc');
    expect(result.candidates.map(item => item.kvmFamily)).not.toContain('ami-megarac');
    expect(result.candidates[0].evidence).toEqual(
      expect.arrayContaining(['tls.O=OpenBMC', 'ws:/xyz/openbmc_project', 'ws:/kvm/video']),
    );
  });

  it('ignores document navigations when collecting AMI HTTP traffic', () => {
    const traffic = trafficEvidenceFromNetwork({
      httpRequests: [
        { url: 'https://bmc.example/api/session', resourceType: 'document' },
        { url: 'https://bmc.example/api/kvm/token', resourceType: 'xhr' },
      ],
    });

    expect(traffic.httpUrls).toEqual(['https://bmc.example/api/kvm/token']);
  });

  it('lets authenticated false overlay stale AMI paths when scoring a capture', () => {
    const result = scoreCapturedKvmFamily(
      {
        basic: { vendor: '', product: '' },
        paths: {
          apiRandomtag: true,
          apiSession: true,
          apiKvmToken: true,
        },
        tls: {
          certificate: { subject: { O: 'OpenBMC' } },
        },
        authenticated: {
          paths: {
            apiRandomtag: false,
            apiSession: false,
            apiKvmToken: false,
            randomtag: true,
            sessionService: true,
            kvmService: true,
          },
        },
      },
      {
        httpRequests: [{ url: 'https://bmc.example/redfish/v1/Managers/1/KvmService', resourceType: 'xhr' }],
        webSockets: [
          { url: 'wss://bmc.example/subscribe' },
          { url: 'wss://bmc.example/kvm/video' },
        ],
        webSocketFrames: [
          { headHex: Buffer.from('{"paths":["/xyz/openbmc_project/', 'utf8').toString('hex') },
        ],
      },
    );

    expect(result.primary).toBe('openbmc-h5');
    expect(result.candidates.map(item => item.kvmFamily)).not.toContain('ami-megarac');
  });
});
