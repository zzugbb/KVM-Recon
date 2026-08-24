import type { CapturePackArtifact } from '../capture-pack/types';
import type {
  HttpRequestRecord,
  WebSocketFrameRecord,
  WebSocketRecord,
} from '../network/createNetworkRecorder';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';

interface NetworkSnapshot {
  httpRequests: HttpRequestRecord[];
  webSockets: WebSocketRecord[];
  webSocketFrames: WebSocketFrameRecord[];
}

interface BuildOemProfileArtifactsInput {
  probe: ProbeBmcTargetResult;
  network: NetworkSnapshot;
}

type KnownKvmFamily = 'ami-megarac' | 'huawei-ibmc' | 'openbmc-h5';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? '443' : '80');
  } catch {
    return '';
  }
}

function headerNames(requests: HttpRequestRecord[]): string[] {
  return unique(
    requests.flatMap(request => [
      ...Object.keys(request.requestHeaders),
      ...Object.keys(request.responseHeaders),
    ]),
  );
}

function cookieNames(requests: HttpRequestRecord[]): string[] {
  const cookieCandidates = requests.flatMap(request => {
    const headers = { ...request.requestHeaders, ...request.responseHeaders };
    return Object.entries(headers)
      .filter(([name]) => /cookie/i.test(name))
      .flatMap(([, value]) => {
        const first = value.split(/[=;]/)[0]?.trim();
        return first ? [first] : [];
      });
  });
  return unique(cookieCandidates);
}

function redactedFieldNames(requests: HttpRequestRecord[]): string[] {
  return unique(
    requests.flatMap(request => [
      ...request.requestBodySummary.redactedFields,
      ...request.responseBodySummary.redactedFields,
    ]),
  );
}

function csrfNames(requests: HttpRequestRecord[]): string[] {
  return unique([
    ...headerNames(requests).filter(name => /csrf/i.test(name)),
    ...redactedFieldNames(requests).filter(name => /csrf/i.test(name)),
  ]);
}

function permissionFields(requests: HttpRequestRecord[]): string[] {
  return redactedFieldNames(requests).filter(name => /privilege|permission|role|auth/i.test(name));
}

function requestPathByPattern(requests: HttpRequestRecord[], pattern: RegExp): string {
  const found = requests.find(request => pattern.test(request.url));
  return found ? pathOf(found.url) : '';
}

function wsPaths(sockets: WebSocketRecord[]): string[] {
  return unique(sockets.map(socket => pathOf(socket.url)));
}

function wsProtocols(sockets: WebSocketRecord[]): string[] {
  return unique(sockets.flatMap(socket => socket.subProtocols));
}

function frameHeadSamples(frames: WebSocketFrameRecord[]): string[] {
  return unique(frames.map(frame => frame.headHex)).slice(0, 8);
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return value || 'unknown';
}

function yamlList(values: string[], indent = '  '): string[] {
  if (values.length === 0) return [`${indent}[]`];
  return values.map(value => `${indent}- ${value}`);
}

function baseYaml(input: BuildOemProfileArtifactsInput, family: KnownKvmFamily): string[] {
  return [
    'schemaVersion: 1',
    'kind: oem-profile-draft',
    `kvmFamily: ${family}`,
    `confidence: ${yamlScalar(input.probe.familySignatures.confidence)}`,
    'reviewRequired: true',
    'source:',
    `  vendor: ${yamlScalar(input.probe.basic.vendor)}`,
    `  product: ${yamlScalar(input.probe.basic.product)}`,
    `  firmwareVersion: ${yamlScalar(input.probe.basic.firmwareVersion)}`,
  ];
}

function amiProfile(input: BuildOemProfileArtifactsInput): string {
  const requests = input.network.httpRequests;
  const sockets = input.network.webSockets;

  return [
    ...baseYaml(input, 'ami-megarac'),
    'amiMegaRac:',
    '  cookieNames:',
    ...yamlList(cookieNames(requests), '    '),
    '  csrfNames:',
    ...yamlList(csrfNames(requests), '    '),
    `  tokenApi: ${yamlScalar(requestPathByPattern(requests, /\/api\/kvm\/token/i))}`,
    '  wsPaths:',
    ...yamlList(wsPaths(sockets), '    '),
    '  subProtocols:',
    ...yamlList(wsProtocols(sockets), '    '),
    '  permissionFields:',
    ...yamlList(permissionFields(requests), '    '),
    '  loginFingerprint:',
    ...yamlList(input.probe.familySignatures.candidates[0]?.evidence || [], '    '),
  ].join('\n');
}

function huaweiProfile(input: BuildOemProfileArtifactsInput): string {
  const requests = input.network.httpRequests;
  const sockets = input.network.webSockets;
  const firstSocket = sockets[0];

  return [
    ...baseYaml(input, 'huawei-ibmc'),
    'huaweiIbmc:',
    `  redfishLogin: ${yamlScalar(input.probe.paths.sessionService ? '/redfish/v1/SessionService' : requestPathByPattern(requests, /sessionservice/i))}`,
    `  kvmService: ${yamlScalar(input.probe.paths.kvmService ? '/redfish/v1/Managers/1/KvmService' : requestPathByPattern(requests, /kvmservice$/i))}`,
    `  setKvmKey: ${yamlScalar(input.probe.paths.setKvmKey ? '/redfish/v1/Managers/1/KvmService/Actions/KvmService.SetKvmKey' : requestPathByPattern(requests, /setkvmkey/i))}`,
    `  kvmPort: ${yamlScalar(firstSocket ? portOf(firstSocket.url) : input.probe.basic.port)}`,
    '  encryption:',
    `    observed: ${requests.some(request => /setkvmkey/i.test(request.url))}`,
    '    evidence:',
    ...yamlList(requests.filter(request => /setkvmkey|kvmservice/i.test(request.url)).map(request => pathOf(request.url)), '      '),
    '  wsMagic:',
    ...yamlList(frameHeadSamples(input.network.webSocketFrames), '    '),
  ].join('\n');
}

function openBmcProfile(input: BuildOemProfileArtifactsInput): string {
  const requests = input.network.httpRequests;
  const sockets = input.network.webSockets;

  return [
    ...baseYaml(input, 'openbmc-h5'),
    'openBmcH5:',
    `  sessionService: ${yamlScalar(input.probe.paths.sessionService ? '/redfish/v1/SessionService' : requestPathByPattern(requests, /sessionservice/i))}`,
    '  tokenHeaders:',
    ...yamlList(headerNames(requests).filter(name => /x-auth-token/i.test(name)), '    '),
    '  uniqueIdFields:',
    ...yamlList(redactedFieldNames(requests).filter(name => /uniqueid/i.test(name)), '    '),
    `  videoPath: ${yamlScalar(input.probe.paths.kvmVideo ? '/kvm/video' : wsPaths(sockets).find(path => /\/kvm\/video/i.test(path)) || '')}`,
    '  subProtocols:',
    ...yamlList(wsProtocols(sockets), '    '),
  ].join('\n');
}

function unknownNotes(input: BuildOemProfileArtifactsInput): string {
  return [
    '# OEM Profile 分析备注',
    '',
    '当前采集结果属于未知协议族，工具不会生成空壳 Adapter/Profile。',
    '',
    `primary=${input.probe.familySignatures.primary}`,
    `confidence=${input.probe.familySignatures.confidence}`,
    '',
    '建议：补充登录链路、KVM 入口、HTTP 关键 API、WebSocket 帧元数据和截图后再进行人工分析。',
  ].join('\n');
}

export function buildOemProfileArtifacts(input: BuildOemProfileArtifactsInput): CapturePackArtifact[] {
  const family = input.probe.familySignatures.primary;
  if (family === 'unknown-h5' || family === 'not-h5') {
    return [
      {
        path: 'artifacts/notes.md',
        content: unknownNotes(input),
      },
    ];
  }

  const profile =
    family === 'ami-megarac'
      ? amiProfile(input)
      : family === 'huawei-ibmc'
        ? huaweiProfile(input)
        : openBmcProfile(input);

  return [
    {
      path: 'artifacts/oem-profile.yaml',
      content: `${profile}\n`,
    },
  ];
}
