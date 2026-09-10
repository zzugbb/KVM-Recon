import type { ProbeSignatureInput } from './detectKvmFamily';

export interface ProductHintInput {
  redfish?: ProbeSignatureInput['redfish'];
  observed?: {
    vendor?: string;
    product?: string;
    firmware?: string;
  } | null;
  traffic?: ProbeSignatureInput['traffic'];
}

export interface ProductHint {
  productFamily:
    | 'h3c-hdm2'
    | 'dell-idrac-h5'
    | 'hpe-ilo-h5'
    | 'huawei-ibmc-legacy'
    | 'unknown-h5';
  confidence: number;
  evidence: string[];
}

function haystack(input: ProductHintInput): string {
  return [
    input.redfish?.vendor,
    input.redfish?.product,
    input.observed?.vendor,
    input.observed?.product,
    input.observed?.firmware,
    ...(input.traffic?.httpUrls || []),
    ...(input.traffic?.webSocketUrls || []),
    ...(input.traffic?.frameHeads || []),
  ]
    .filter(Boolean)
    .join('\n');
}

function hasUrl(input: ProductHintInput, pattern: RegExp) {
  return [...(input.traffic?.httpUrls || []), ...(input.traffic?.webSocketUrls || [])].some(url =>
    pattern.test(url),
  );
}

function hasFrame(input: ProductHintInput, pattern: RegExp) {
  return (input.traffic?.frameHeads || []).some(head => pattern.test(head));
}

function hasFrameHex(input: ProductHintInput, pattern: RegExp) {
  return (input.traffic?.frameHeadHexes || []).some(head => pattern.test(head));
}

function candidate(
  productFamily: ProductHint['productFamily'],
  confidence: number,
  evidence: string[],
): ProductHint | null {
  const compact = evidence.filter(Boolean);
  if (compact.length === 0) return null;
  return {
    productFamily,
    confidence: Math.min(0.95, Math.round(confidence * 100) / 100),
    evidence: compact,
  };
}

export function detectProductHints(input: ProductHintInput): ProductHint[] {
  const text = haystack(input);
  const h3cIdentity = /h3c|hdm/i.test(text);
  const h3cCreateSession = hasUrl(
    input,
    /\/redfish\/v1\/SessionService\/Actions\/Oem\/Public\/SessionService\.CreateSession/i,
  );
  const h3cStartH5Kvm = hasUrl(
    input,
    /\/KvmService\/Actions\/Oem\/Public\/KvmService\.StartH5Kvm/i,
  );
  const h3cH5Asset = hasUrl(input, /\/(?:css|js)\/(?:chunk-)?h5|h5Kvm/i);
  const h3cWsKvm = hasUrl(input, /\/kvm(?:\?|$)/i);
  const h3cHdm2Evidence = h3cCreateSession || h3cStartH5Kvm || h3cH5Asset;

  const huaweiLegacyPhp = hasUrl(input, /\/bmc\/php\/(?:setpropertybymethod|getmultiproperty|processparameter|editcookie|gettoken)\.php/i);
  const huaweiLegacyPage = hasUrl(input, /\/bmc\/pages\/remote\/kvm_by_html5\.html/i);
  const huaweiLegacyAsset = hasUrl(
    input,
    /\/bmc\/resources\/js\/module\/remote\/html5\/kvmclient\.js/i,
  );
  const huaweiLegacyWs = hasUrl(input, /:2198\/(?:$|\?)/i);
  const huaweiLegacyFrame = hasFrameHex(input, /^fef6/i);
  const huaweiLegacyEvidence =
    huaweiLegacyPhp || huaweiLegacyPage || huaweiLegacyAsset || huaweiLegacyWs || huaweiLegacyFrame;

  const hints = [
    candidate('dell-idrac-h5', 0.55, [
      /dell|idrac|poweredge/i.test(text) ? 'vendor/product:Dell iDRAC' : '',
      hasUrl(input, /\/sysmgmt\/2015\/bmc\/session/i) ? 'http:/sysmgmt/2015/bmc/session' : '',
      hasUrl(input, /\/vnc\/vconsole/i) ? 'ws:/vnc/vconsole' : '',
      hasUrl(input, /:5900\/(?:$|\?|vkvm\/?)/i) ? 'ws:5900' : '',
      hasUrl(input, /\/restgui\/(?:html5viewer|views\/configuration\/vconsole)/i)
        ? 'http:/restgui/html5viewer'
        : '',
      hasFrame(input, /^RFB 003\.008/) ? 'frame:RFB 003.008' : '',
      hasFrame(input, /^APCP/) ? 'frame:APCP' : '',
    ]),
    candidate('hpe-ilo-h5', 0.54, [
      /\bhpe?\b|proliant|ilo/i.test(text) ? 'vendor/product:HPE iLO' : '',
      hasUrl(input, /\/json\/login_session/i) ? 'http:/json/login_session' : '',
      hasUrl(input, /\/js\/irc(?:KeyboardMouse)?\.js/i) ? 'http:/js/irc.js' : '',
      hasUrl(input, /\/html\/irc_common\.html/i) ? 'http:/html/irc_common.html' : '',
      hasUrl(input, /\/wss\/ircport/i) ? 'ws:/wss/ircport' : '',
    ]),
    h3cHdm2Evidence
      ? candidate('h3c-hdm2', h3cIdentity ? 0.62 : 0.54, [
          h3cIdentity ? 'vendor/product:H3C HDM' : '',
          h3cCreateSession ? 'http:SessionService.CreateSession' : '',
          h3cStartH5Kvm ? 'http:KvmService.StartH5Kvm' : '',
          h3cH5Asset ? 'asset:h5Kvm' : '',
          h3cWsKvm ? 'ws:/kvm' : '',
        ])
      : null,
    huaweiLegacyEvidence
      ? candidate('huawei-ibmc-legacy', /huawei|华为|xfusion/i.test(text) ? 0.65 : 0.57, [
      /huawei|华为|xfusion/i.test(text) ? 'vendor/product:Huawei iBMC' : '',
          huaweiLegacyPhp ? 'http:/bmc/php/*.php' : '',
          huaweiLegacyWs ? 'ws:2198/' : '',
          huaweiLegacyPage ? 'http:/bmc/pages/remote/kvm_by_html5.html' : '',
          huaweiLegacyAsset ? 'asset:kvmclient.js' : '',
          huaweiLegacyFrame ? 'frame:FEF6' : '',
        ])
      : null,
  ].filter((item): item is ProductHint => Boolean(item));

  hints.sort((left, right) => {
    const score = right.evidence.length - left.evidence.length;
    return score !== 0 ? score : right.confidence - left.confidence;
  });

  if (hints.length === 0 && /h5|html5|kvm|console|viewer|vnc|irc/i.test(text)) {
    hints.push({
      productFamily: 'unknown-h5',
      confidence: 0.35,
      evidence: ['generic:h5-kvm'],
    });
  }

  return hints;
}
