import { describe, expect, it } from 'vitest';

import {
  detectKvmFamily,
  scoreCapturedKvmFamily,
  tlsCommonNameFromCertificate,
  tlsOrganizationFromCertificate,
  trafficEvidenceFromNetwork,
} from './detectKvmFamily';

describe('detectKvmFamily', () => {
  it('treats a validated AMI randomtag as a strong standalone fingerprint', () => {
    const result = detectKvmFamily({
      paths: {
        apiRandomtag: true,
        apiSession: true,
        apiKvmToken: true,
        kvmVideo: true,
      },
    });

    expect(result.primary).toBe('ami-megarac');
    expect(result.confidence).toBe(0.9);
    expect(result.candidates[0]).toMatchObject({
      kvmFamily: 'ami-megarac',
      evidence: ['/api/randomtag'],
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

  it('uses the production AMI then OpenBMC priority when strong signals conflict', () => {
    const result = detectKvmFamily({
      paths: {
        apiRandomtag: true,
        apiSession: true,
        randomtag: true,
        kvmVideo: true,
        sessionService: true,
      },
    });

    expect(result.primary).toBe('ami-megarac');
    expect(result.candidates.map(item => item.kvmFamily)).toEqual([
      'ami-megarac',
      'openbmc-h5',
    ]);
  });

  it('does not let an unvalidated AMI-looking URL outrank a strong OpenBMC fingerprint', () => {
    const result = detectKvmFamily({
      paths: { randomtag: true },
      traffic: { httpUrls: ['https://bmc.example/api/session'] },
    });

    expect(result.primary).toBe('openbmc-h5');
    expect(result.candidates.map(item => item.kvmFamily)).not.toContain('ami-megarac');
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

  it('treats a validated OpenBMC randomtag as a known family', () => {
    const result = detectKvmFamily({
      paths: {
        randomtag: true,
      },
    });

    expect(result.primary).toBe('openbmc-h5');
    expect(result.confidence).toBe(0.9);
  });

  it('detects AMI from the original vendor certificate', () => {
    const result = detectKvmFamily({
      tls: { organization: 'American Megatrends Inc', commonName: 'AMI' },
    });

    expect(result.primary).toBe('ami-megarac');
    expect(result.confidence).toBe(0.9);
  });

  it('uses only the certificate subject when extracting protocol-family identity', () => {
    const issuerOnlyCertificate = {
      issuer: { O: 'OpenBMC', CN: 'Huawei iBMC' },
    };
    const subjectCertificate = {
      subject: { O: 'Independent BMC', CN: 'bmc.local' },
      issuer: { O: 'OpenBMC', CN: 'Huawei iBMC' },
    };

    expect(tlsOrganizationFromCertificate(issuerOnlyCertificate)).toBe('');
    expect(tlsCommonNameFromCertificate(issuerOnlyCertificate)).toBe('');
    expect(tlsOrganizationFromCertificate(subjectCertificate)).toBe('Independent BMC');
    expect(tlsCommonNameFromCertificate(subjectCertificate)).toBe('bmc.local');
  });

  it('does not classify Huawei from subject organization alone', () => {
    const result = detectKvmFamily({
      tls: { organization: 'Huawei Technologies', commonName: 'bmc.local' },
    });

    expect(result.primary).toBe('not-h5');
  });

  it('classifies Huawei from the certificate subject common name', () => {
    const result = detectKvmFamily({
      tls: { organization: 'Independent CA', commonName: 'Huawei iBMC' },
    });

    expect(result.primary).toBe('huawei-ibmc');
    expect(result.candidates[0]?.evidence).toContain('tls.CN=Huawei iBMC');
  });

  it('detects Huawei from Redfish Oem.Huawei SoftwareName', () => {
    const result = detectKvmFamily({
      redfish: {
        oemKeys: ['Huawei'],
        oemSoftwareName: 'iBMC V3',
      },
    });

    expect(result.primary).toBe('huawei-ibmc');
    expect(result.candidates[0]?.evidence).toEqual(
      expect.arrayContaining(['redfish.Oem.Huawei', 'redfish.Oem.SoftwareName=iBMC V3']),
    );
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

  it('does not treat Huawei virtual media port 8208 as KVM WebSocket evidence', () => {
    const result = detectKvmFamily({
      traffic: {
        webSocketUrls: ['wss://10.10.8.107:8208/websocket'],
      },
    });

    expect(result.primary).not.toBe('huawei-ibmc');
    expect(result.candidates.flatMap(item => item.evidence).join(' ')).not.toMatch(/8208/);
  });
});
