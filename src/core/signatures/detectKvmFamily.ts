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

function pushCandidate(
  candidates: KvmFamilyCandidate[],
  candidate: KvmFamilyCandidate | null,
) {
  if (candidate) {
    candidates.push(candidate);
  }
}

function detectAmi(paths: ProbeSignatureInput['paths']): KvmFamilyCandidate | null {
  const evidence = [
    paths?.apiRandomtag ? '/api/randomtag' : '',
    paths?.apiSession ? '/api/session' : '',
    paths?.apiKvmToken ? '/api/kvm/token' : '',
  ].filter(Boolean);

  if (evidence.length === 0) return null;

  return {
    kvmFamily: 'ami-megarac',
    confidence: evidence.length >= 2 ? 0.9 : 0.72,
    evidence,
  };
}

function detectOpenBmc(paths: ProbeSignatureInput['paths']): KvmFamilyCandidate | null {
  const hasAmiApi = !!(paths?.apiRandomtag || paths?.apiSession || paths?.apiKvmToken);
  if (hasAmiApi) return null;

  const evidence = [
    paths?.randomtag ? '/randomtag' : '',
    paths?.kvmVideo ? '/kvm/video' : '',
    paths?.sessionService ? '/redfish/v1/SessionService' : '',
  ].filter(Boolean);

  if (!paths?.kvmVideo && evidence.length < 2) return null;

  return {
    kvmFamily: 'openbmc-h5',
    confidence: paths?.kvmVideo && evidence.length >= 2 ? 0.82 : 0.65,
    evidence,
  };
}

function detectHuawei(input: ProbeSignatureInput): KvmFamilyCandidate | null {
  const vendor = input.redfish?.vendor || '';
  const evidence = [
    /huawei|华为/i.test(vendor) ? `redfish.vendor=${vendor}` : '',
    input.paths?.kvmService ? 'KvmService' : '',
    input.paths?.setKvmKey ? 'SetKvmKey' : '',
  ].filter(Boolean);

  if (evidence.length === 0) return null;

  return {
    kvmFamily: 'huawei-ibmc',
    confidence: evidence.length >= 2 ? 0.88 : 0.68,
    evidence,
  };
}

export function detectKvmFamily(input: ProbeSignatureInput): KvmFamilyDetectionResult {
  const candidates: KvmFamilyCandidate[] = [];

  pushCandidate(candidates, detectHuawei(input));
  pushCandidate(candidates, detectAmi(input.paths));
  pushCandidate(candidates, detectOpenBmc(input.paths));

  candidates.sort((left, right) => right.confidence - left.confidence);

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
  ].some(Boolean);

  return {
    primary: h5Signals ? 'unknown-h5' : 'not-h5',
    confidence: 0,
    candidates: [],
  };
}
