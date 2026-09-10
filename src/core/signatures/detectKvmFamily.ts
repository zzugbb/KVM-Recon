export interface ProbeSignatureInput {
  redfish?: {
    vendor?: string;
    product?: string;
  };
  paths?: {
    apiRandomtag?: boolean;
    apiSession?: boolean;
    apiKvmToken?: boolean;
    randomtag?: boolean;
    kvmVideo?: boolean;
    sessionService?: boolean;
    kvmService?: boolean;
    setKvmKey?: boolean;
  };
  tls?: {
    organization?: string;
    commonName?: string;
  };
  traffic?: {
    httpUrls?: string[];
    webSocketUrls?: string[];
    frameHeads?: string[];
    frameHeadHexes?: string[];
  };
}

export interface KvmFamilyCandidate {
  kvmFamily: 'ami-megarac' | 'openbmc-h5' | 'huawei-ibmc';
  confidence: number;
  evidence: string[];
}

export interface KvmFamilyDetectionResult {
  primary: KvmFamilyCandidate['kvmFamily'] | 'unknown-h5' | 'not-h5';
  confidence: number;
  candidates: KvmFamilyCandidate[];
}

function roundConfidence(value: number) {
  return Math.min(0.93, Math.round(value * 100) / 100);
}

function pushCandidate(candidates: KvmFamilyCandidate[], candidate: KvmFamilyCandidate | null) {
  if (candidate) {
    candidates.push(candidate);
  }
}

function urls(input: ProbeSignatureInput): string[] {
  return input.traffic?.httpUrls || [];
}

function wsUrls(input: ProbeSignatureInput): string[] {
  return input.traffic?.webSocketUrls || [];
}

function frameHeads(input: ProbeSignatureInput): string[] {
  return input.traffic?.frameHeads || [];
}

function frameHeadHexes(input: ProbeSignatureInput): string[] {
  return input.traffic?.frameHeadHexes || [];
}

function urlMatches(list: string[], pattern: RegExp) {
  return list.some(item => pattern.test(item));
}

function hasHdm2Traffic(input: ProbeSignatureInput) {
  return (
    urlMatches(urls(input), /SessionService\.CreateSession/i) ||
    urlMatches(urls(input), /KvmService\.StartH5Kvm|\/h5Kvm|chunk-h5/i)
  );
}

function hasDellTraffic(input: ProbeSignatureInput) {
  const vendor = `${input.redfish?.vendor || ''} ${input.redfish?.product || ''}`;
  return /dell|idrac|poweredge/i.test(vendor) || urlMatches(
    [...urls(input), ...wsUrls(input)],
    /\/sysmgmt\/2015\/bmc\/session|\/vnc\/vconsole|:5900\/(?:$|\?|vkvm\/?)|\/restgui\/html5viewer|idrac/i,
  );
}

function hasHpeTraffic(input: ProbeSignatureInput) {
  const vendor = `${input.redfish?.vendor || ''} ${input.redfish?.product || ''}`;
  return /hpe?\b|proliant|ilo/i.test(vendor) || urlMatches(
    [...urls(input), ...wsUrls(input)],
    /\/json\/login_session|\/js\/irc(?:KeyboardMouse)?\.js|\/html\/irc_common\.html|\/wss\/ircport/i,
  );
}

function detectAmi(input: ProbeSignatureInput): KvmFamilyCandidate | null {
  const pathEvidence = [
    input.paths?.apiRandomtag ? '/api/randomtag' : '',
    input.paths?.apiSession ? '/api/session' : '',
    input.paths?.apiKvmToken ? '/api/kvm/token' : '',
  ].filter(Boolean);
  const trafficEvidence = [
    urlMatches(urls(input), /\/api\/randomtag(\/|\?|$)/i) ? 'http:/api/randomtag' : '',
    urlMatches(urls(input), /\/api\/(?:secure_session|session|session_encrypted)(\/|\?|$)/i)
      ? 'http:/api/session'
      : '',
    urlMatches(urls(input), /\/api\/kvm\/token(\/|\?|$)/i) ? 'http:/api/kvm/token' : '',
  ].filter(Boolean);
  const strongTraffic =
    trafficEvidence.includes('http:/api/kvm/token') &&
    trafficEvidence.some(item => item === 'http:/api/session' || item === 'http:/api/randomtag');
  if (
    trafficEvidence.length === 0 &&
    (hasHdm2Traffic(input) || hasDellTraffic(input) || hasHpeTraffic(input))
  ) {
    return null;
  }

  const evidence = [...(trafficEvidence.length ? pathEvidence : []), ...trafficEvidence];
  if (evidence.length === 0) {
    if (pathEvidence.length >= 2) {
      return {
        kvmFamily: 'ami-megarac',
        confidence: 0.49,
        evidence: pathEvidence,
      };
    }
    return null;
  }

  let confidence = 0.5 + 0.05 * Math.min(pathEvidence.length, 3);
  if (strongTraffic) {
    confidence = 0.9;
  } else if (trafficEvidence.length === 1) {
    confidence = 0.58;
  }

  return {
    kvmFamily: 'ami-megarac',
    confidence: roundConfidence(confidence),
    evidence,
  };
}

function detectOpenBmc(input: ProbeSignatureInput): KvmFamilyCandidate | null {
  const organization = input.tls?.organization || '';
  const tlsOpenBmc = /openbmc/i.test(organization);
  const xyzSubscribe = frameHeads(input).some(head => /\/xyz\/openbmc_project\//i.test(head));
  const wsKvmVideo = urlMatches(wsUrls(input), /\/kvm\/video(\/|\?|$)/i);
  const wsSubscribe = urlMatches(wsUrls(input), /\/subscribe(\/|\?|$)/i);

  const evidence = [
    tlsOpenBmc ? `tls.O=${organization}` : '',
    xyzSubscribe ? 'ws:/xyz/openbmc_project' : '',
    wsKvmVideo ? 'ws:/kvm/video' : '',
    wsSubscribe ? 'ws:/subscribe' : '',
    input.paths?.kvmVideo ? '/kvm/video' : '',
    input.paths?.randomtag ? '/randomtag' : '',
    input.paths?.sessionService ? '/redfish/v1/SessionService' : '',
  ].filter(Boolean);

  const strong = tlsOpenBmc || xyzSubscribe || wsKvmVideo;
  const pathPair =
    Boolean(input.paths?.kvmVideo && (input.paths.randomtag || input.paths.sessionService)) ||
    Boolean(input.paths?.randomtag && input.paths?.sessionService);
  if (!strong && !pathPair) return null;

  let score = 0;
  if (tlsOpenBmc) score += 0.22;
  if (xyzSubscribe) score += 0.24;
  if (wsKvmVideo) score += 0.22;
  if (wsSubscribe) score += 0.08;
  if (input.paths?.kvmVideo) score += 0.42;
  if (input.paths?.randomtag) score += 0.28;
  if (input.paths?.sessionService) score += 0.18;

  return {
    kvmFamily: 'openbmc-h5',
    confidence: roundConfidence(score),
    evidence,
  };
}

function detectHuawei(input: ProbeSignatureInput): KvmFamilyCandidate | null {
  const vendor = input.redfish?.vendor || '';
  const vendorHit = /huawei|华为/i.test(vendor);
  const organization = `${input.tls?.organization || ''} ${input.tls?.commonName || ''}`;
  const tlsHit = /huawei/i.test(organization);
  const huaweiUiHttp = urlMatches(urls(input), /\/UI\/Rest\/Services\/KVM(?:\/GenerateStartupFile)?(?:\?|$)/i);
  const legacyHttp = urlMatches(urls(input), /\/bmc\/pages\/remote\/kvm_by_html5\.html|\/bmc\/resources\/js\/module\/remote\/html5\/kvmclient\.js/i);
  const kvmServiceHttp = urlMatches(urls(input), /\/kvmservice(\/|\?|$)/i);
  const setKvmKeyHttp = urlMatches(urls(input), /setkvmkey|kvmservice\.setkvmkey/i);
  const startH5KvmHttp = urlMatches(urls(input), /kvmservice\.starth5kvm/i);
  const huaweiWs = urlMatches(wsUrls(input), /:(?:2198|2199|8208)\/(?:websocket)?(?:\?|$)/i);
  const huaweiFrame = frameHeadHexes(input).some(head => /^fef6/i.test(head));
  const kvmServicePath = Boolean(input.paths?.kvmService);
  const setKvmKeyPath = Boolean(input.paths?.setKvmKey);

  const evidence = [
    vendorHit ? `redfish.vendor=${vendor}` : '',
    tlsHit ? `tls=${organization.trim()}` : '',
    kvmServicePath ? 'KvmService' : '',
    setKvmKeyPath ? 'SetKvmKey' : '',
    huaweiUiHttp ? 'http:/UI/Rest/Services/KVM' : '',
    legacyHttp ? 'http:huawei-legacy-kvm' : '',
    kvmServiceHttp ? 'http:KvmService' : '',
    setKvmKeyHttp ? 'http:SetKvmKey' : '',
    huaweiWs ? 'ws:2198/websocket' : '',
    huaweiFrame ? 'frame:FEF6' : '',
  ].filter(Boolean);

  if (startH5KvmHttp && !vendorHit && !tlsHit && !huaweiUiHttp && !huaweiWs && !huaweiFrame) {
    return null;
  }
  const strongIdentity = vendorHit || tlsHit || huaweiUiHttp || legacyHttp || huaweiWs || huaweiFrame;
  if (!strongIdentity) return null;

  if ((vendorHit || tlsHit) && kvmServicePath && setKvmKeyPath) {
    return {
      kvmFamily: 'huawei-ibmc',
      confidence: 0.88,
      evidence,
    };
  }
  if (setKvmKeyHttp || (huaweiUiHttp && huaweiWs) || (legacyHttp && huaweiFrame)) {
    return {
      kvmFamily: 'huawei-ibmc',
      confidence: 0.88,
      evidence,
    };
  }

  let score = 0.5;
  if (vendorHit) score += 0.14;
  if (tlsHit) score += 0.12;
  if (huaweiUiHttp) score += 0.18;
  if (legacyHttp) score += 0.12;
  if (huaweiWs) score += 0.16;
  if (huaweiFrame) score += 0.18;
  if (strongIdentity && kvmServicePath) score += 0.04;
  if (strongIdentity && setKvmKeyPath) score += 0.04;
  if (strongIdentity && kvmServiceHttp) score += 0.06;
  if (setKvmKeyHttp) score += 0.14;

  return {
    kvmFamily: 'huawei-ibmc',
    confidence: roundConfidence(Math.min(0.86, score)),
    evidence,
  };
}

export function detectKvmFamily(input: ProbeSignatureInput): KvmFamilyDetectionResult {
  const candidates: KvmFamilyCandidate[] = [];

  pushCandidate(candidates, detectHuawei(input));
  pushCandidate(candidates, detectAmi(input));
  pushCandidate(candidates, detectOpenBmc(input));

  candidates.sort((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.evidence.length - left.evidence.length;
  });

  const primary = candidates[0];
  if (primary) {
    return {
      primary: primary.kvmFamily,
      confidence: primary.confidence,
      candidates,
    };
  }

  const h5Signals = [
    input.paths?.apiRandomtag,
    input.paths?.apiKvmToken,
    input.paths?.randomtag,
    input.paths?.kvmVideo,
    input.paths?.kvmService,
    input.paths?.setKvmKey,
    hasHdm2Traffic(input),
    hasDellTraffic(input),
    hasHpeTraffic(input),
    urlMatches(urls(input), /\/api\/kvm\/token|\/kvmservice|\/kvm\/video|\/html5viewer|\/vconsole|\/irc/i),
    urlMatches(wsUrls(input), /\/kvm(?:\/|\?|$)|\/vnc\/vconsole|:5900\/|\/wss\/ircport|:2198\//i),
  ].some(Boolean);

  return {
    primary: h5Signals ? 'unknown-h5' : 'not-h5',
    confidence: 0,
    candidates: [],
  };
}

function partyOrganization(party?: Record<string, unknown>): string {
  if (!party) return '';
  const value = party.O;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(',');
  return typeof value === 'string' ? value : '';
}

export function tlsOrganizationFromCertificate(
  certificate?: {
    subject?: Record<string, unknown>;
    issuer?: Record<string, unknown>;
  } | null,
): string {
  return partyOrganization(certificate?.subject) || partyOrganization(certificate?.issuer);
}

function partyCommonName(party?: Record<string, unknown>): string {
  if (!party) return '';
  const value = party.CN;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(',');
  return typeof value === 'string' ? value : '';
}

export function tlsCommonNameFromCertificate(
  certificate?: {
    subject?: Record<string, unknown>;
    issuer?: Record<string, unknown>;
  } | null,
): string {
  return partyCommonName(certificate?.subject) || partyCommonName(certificate?.issuer);
}

function decodeHeadHex(headHex: string): string {
  const hex = headHex.replace(/[^0-9a-f]/gi, '');
  if (hex.length < 2 || hex.length % 2 !== 0) return '';
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch (error) {
    // 捕获采样帧 hex 无法解码：现场帧可能被截断
    // 策略：当作无文本证据，不影响 URL 等其它信号
    void error;
    return '';
  }
}

function isDocumentNavigation(resourceType?: string) {
  const type = String(resourceType || '').toLowerCase();
  return type === 'document' || type === 'main_frame' || type === 'sub_frame';
}

export function overlayPathEvidence(
  base: NonNullable<ProbeSignatureInput['paths']> = {},
  extra: NonNullable<ProbeSignatureInput['paths']> = {},
): NonNullable<ProbeSignatureInput['paths']> {
  const merged: NonNullable<ProbeSignatureInput['paths']> = { ...base };
  for (const [key, value] of Object.entries(extra) as Array<
    [keyof NonNullable<ProbeSignatureInput['paths']>, boolean | undefined]
  >) {
    if (typeof value === 'boolean') {
      merged[key] = value;
    }
  }
  return merged;
}

export function trafficEvidenceFromNetwork(network?: {
  httpRequests?: Array<{ url?: string; resourceType?: string }>;
  webSockets?: Array<{ url?: string }>;
  webSocketFrames?: Array<{ headHex?: string }>;
}): NonNullable<ProbeSignatureInput['traffic']> {
  return {
    httpUrls: (network?.httpRequests || [])
      .filter(item => item.url && !isDocumentNavigation(item.resourceType))
      .map(item => item.url || ''),
    webSocketUrls: (network?.webSockets || []).map(item => item.url || '').filter(Boolean),
    frameHeads: (network?.webSocketFrames || [])
      .map(item => decodeHeadHex(item.headHex || ''))
      .filter(Boolean),
    frameHeadHexes: (network?.webSocketFrames || [])
      .map(item => item.headHex || '')
      .filter(Boolean),
  };
}

export function scoreCapturedKvmFamily(
  probe?: {
    basic?: { vendor?: string; product?: string };
    paths?: ProbeSignatureInput['paths'];
    tls?: {
      certificate?: {
        subject?: Record<string, unknown>;
        issuer?: Record<string, unknown>;
      } | null;
    };
    authenticated?: { paths?: ProbeSignatureInput['paths'] };
  } | null,
  network?: {
    httpRequests?: Array<{ url?: string; resourceType?: string }>;
    webSockets?: Array<{ url?: string }>;
    webSocketFrames?: Array<{ headHex?: string }>;
  } | null,
): KvmFamilyDetectionResult {
  if (!probe) {
    return { primary: 'not-h5', confidence: 0, candidates: [] };
  }
  return detectKvmFamily({
    redfish: {
      vendor: probe.basic?.vendor,
      product: probe.basic?.product,
    },
    paths: overlayPathEvidence(probe.paths, probe.authenticated?.paths),
    tls: {
      organization: tlsOrganizationFromCertificate(probe.tls?.certificate),
      commonName: tlsCommonNameFromCertificate(probe.tls?.certificate),
    },
    traffic: trafficEvidenceFromNetwork(network || undefined),
  });
}
