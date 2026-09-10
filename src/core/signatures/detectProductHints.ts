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
    candidate('h3c-hdm2', 0.54, [
      /h3c|hdm/i.test(text) ? 'vendor/product:H3C HDM' : '',
      hasUrl(input, /\/redfish\/v1\/SessionService\/Actions\/Oem\/Public\/SessionService\.CreateSession/i)
        ? 'http:SessionService.CreateSession'
        : '',
      hasUrl(input, /\/KvmService\/Actions\/Oem\/Public\/KvmService\.StartH5Kvm/i)
        ? 'http:KvmService.StartH5Kvm'
        : '',
      hasUrl(input, /\/(?:css|js)\/(?:chunk-)?h5|h5Kvm/i) ? 'asset:h5Kvm' : '',
      hasUrl(input, /\/kvm(?:\?|$)/i) ? 'ws:/kvm' : '',
    ]),
    candidate('huawei-ibmc-legacy', 0.57, [
      /huawei|华为|xfusion/i.test(text) ? 'vendor/product:Huawei iBMC' : '',
      hasUrl(input, /:2198\/(?:$|\?)/i) ? 'ws:2198/' : '',
      hasUrl(input, /\/bmc\/pages\/remote\/kvm_by_html5\.html/i)
        ? 'http:/bmc/pages/remote/kvm_by_html5.html'
        : '',
      hasUrl(input, /\/bmc\/resources\/js\/module\/remote\/html5\/kvmclient\.js/i)
        ? 'asset:kvmclient.js'
        : '',
      hasFrameHex(input, /^fef6/i) ? 'frame:FEF6' : '',
    ]),
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
