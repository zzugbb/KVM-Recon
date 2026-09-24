import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Ajv, { type ErrorObject } from 'ajv';
import { describe, expect, it } from 'vitest';

import { createSampleCapturePackV2 } from './createSampleCapturePackV2';

interface JsonSchema {
  $id: string;
  [key: string]: unknown;
}

function jsonLines(content: string): unknown[] {
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function formatErrors(errors: ErrorObject[] | null | undefined) {
  return (errors || [])
    .map(error => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
    .join('; ');
}

describe('Capture Pack 2.0 JSON Schema（规范 §22：Schema 与类型同步）', () => {
  it('样例包的每个结构化文件都能通过 schema/2.0 校验', async () => {
    const schemaRoot = join(process.cwd(), 'schema/2.0');
    const schemas = readdirSync(schemaRoot)
      .filter(name => name.endsWith('.schema.json'))
      .map(name => JSON.parse(readFileSync(join(schemaRoot, name), 'utf8')) as JsonSchema);
    expect(schemas.length).toBeGreaterThanOrEqual(20);
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, allowUnionTypes: true });
    for (const schema of schemas) ajv.addSchema(schema);

    const sample = await createSampleCapturePackV2();
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact.content]));
    const jsonOf = (path: string): unknown => JSON.parse(String(artifacts.get(path)));

    const cases: Array<{ schema: string; path: string; values: unknown[] }> = [
      { schema: 'manifest.schema.json', path: 'manifest.json', values: [sample.manifest] },
      { schema: 'integrity.schema.json', path: 'integrity.json', values: [sample.integrity] },
      { schema: 'ai-index.schema.json', path: 'ai/index.json', values: [sample.aiIndex] },
      {
        schema: 'ai-adapter-dossier.schema.json',
        path: 'ai/adapter-dossier.json',
        values: [jsonOf('ai/adapter-dossier.json')],
      },
      { schema: 'ai-value-flow.schema.json', path: 'ai/value-flow.json', values: [jsonOf('ai/value-flow.json')] },
      {
        schema: 'ai-missing-evidence.schema.json',
        path: 'ai/missing-evidence.json',
        values: [jsonOf('ai/missing-evidence.json')],
      },
      {
        schema: 'catalog-resource.schema.json',
        path: 'catalog/resources.jsonl',
        values: jsonLines(String(artifacts.get('catalog/resources.jsonl'))),
      },
      { schema: 'targets.schema.json', path: 'catalog/targets.json', values: [jsonOf('catalog/targets.json')] },
      { schema: 'targets.schema.json', path: 'raw/browser/targets.json', values: [jsonOf('raw/browser/targets.json')] },
      {
        schema: 'catalog-channels.schema.json',
        path: 'catalog/channels.json',
        values: [jsonOf('catalog/channels.json')],
      },
      {
        schema: 'catalog-relation.schema.json',
        path: 'catalog/relations.jsonl',
        values: jsonLines(String(artifacts.get('catalog/relations.jsonl'))),
      },
      {
        schema: 'http-transaction.schema.json',
        path: 'raw/http/transactions.jsonl',
        values: jsonLines(String(artifacts.get('raw/http/transactions.jsonl'))),
      },
      {
        schema: 'cdp-event.schema.json',
        path: 'raw/cdp/events.jsonl',
        values: jsonLines(String(artifacts.get('raw/cdp/events.jsonl'))),
      },
      {
        schema: 'cdp-command.schema.json',
        path: 'raw/cdp/commands.jsonl',
        values: jsonLines(String(artifacts.get('raw/cdp/commands.jsonl'))),
      },
      { schema: 'netlog.schema.json', path: 'raw/netlog/netlog.json', values: [jsonOf('raw/netlog/netlog.json')] },
      {
        schema: 'ws-metadata.schema.json',
        path: 'raw/websocket/ws-0001/metadata.json',
        values: [jsonOf('raw/websocket/ws-0001/metadata.json')],
      },
      {
        schema: 'ws-frame-index.schema.json',
        path: 'raw/websocket/ws-0001/frames.index.jsonl',
        values: jsonLines(String(artifacts.get('raw/websocket/ws-0001/frames.index.jsonl'))),
      },
      {
        schema: 'browser-timeline-event.schema.json',
        path: 'raw/browser/timeline.jsonl',
        values: jsonLines(String(artifacts.get('raw/browser/timeline.jsonl'))),
      },
      {
        schema: 'browser-action.schema.json',
        path: 'raw/browser/actions.jsonl',
        values: jsonLines(String(artifacts.get('raw/browser/actions.jsonl'))),
      },
      {
        schema: 'browser-render-surface.schema.json',
        path: 'raw/browser/render-surfaces.jsonl',
        values: jsonLines(String(artifacts.get('raw/browser/render-surfaces.jsonl'))),
      },
      {
        schema: 'browser-storage.schema.json',
        path: 'raw/browser/storage.json',
        values: [jsonOf('raw/browser/storage.json')],
      },
      {
        schema: 'browser-console-entry.schema.json',
        path: 'raw/browser/console.jsonl',
        values: jsonLines(String(artifacts.get('raw/browser/console.jsonl'))),
      },
      {
        schema: 'scripts-index.schema.json',
        path: 'raw/scripts/index.json',
        values: [jsonOf('raw/scripts/index.json')],
      },
      {
        schema: 'replay-manifest.schema.json',
        path: 'replay/manifest.json',
        values: [jsonOf('replay/manifest.json')],
      },
      {
        schema: 'replay-request.schema.json',
        path: 'replay/http.jsonl',
        values: jsonLines(String(artifacts.get('replay/http.jsonl'))),
      },
      {
        schema: 'replay-channels.schema.json',
        path: 'replay/channels.json',
        values: [jsonOf('replay/channels.json')],
      },
      { schema: 'probe-index.schema.json', path: 'raw/probe/index.json', values: [jsonOf('raw/probe/index.json')] },
      {
        schema: 'runtime-crypto.schema.json',
        path: 'raw/runtime/crypto.jsonl',
        values: jsonLines(String(artifacts.get('raw/runtime/crypto.jsonl'))),
      },
    ];

    for (const testCase of cases) {
      const schema = schemas.find(candidate => candidate.$id.endsWith(`/${testCase.schema}`));
      expect(schema, `missing schema file ${testCase.schema}`).toBeDefined();
      const validate = ajv.getSchema(schema!.$id);
      expect(validate, `missing validator for ${testCase.schema}`).toBeTypeOf('function');
      for (const value of testCase.values) {
        const valid = validate?.(value);
        expect(valid, `${testCase.path}: ${formatErrors(validate?.errors)}`).toBe(true);
      }
    }
  }, 30000);

  it('包内 schema/ 副本与仓库 schema/2.0 一致', async () => {
    const sample = await createSampleCapturePackV2();
    const schemaRoot = join(process.cwd(), 'schema/2.0');
    const repoSchemas = new Map(
      readdirSync(schemaRoot)
        .filter(name => name.endsWith('.schema.json'))
        .map(name => [name, readFileSync(join(schemaRoot, name), 'utf8')]),
    );
    const packedSchemas = sample.artifacts.filter(artifact => artifact.path.startsWith('schema/'));
    expect(packedSchemas.length).toBe(repoSchemas.size);
    for (const packed of packedSchemas) {
      const name = packed.path.slice('schema/'.length);
      expect(repoSchemas.has(name), name).toBe(true);
      expect(String(packed.content)).toBe(repoSchemas.get(name));
    }
  }, 30000);

  it('拒绝契约明确禁止的状态组合（负向 Schema 测试）', async () => {
    const schemaRoot = join(process.cwd(), 'schema/2.0');
    const schemas = readdirSync(schemaRoot)
      .filter(name => name.endsWith('.schema.json'))
      .map(name => JSON.parse(readFileSync(join(schemaRoot, name), 'utf8')) as JsonSchema);
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, allowUnionTypes: true });
    for (const schema of schemas) ajv.addSchema(schema);
    const validateManifest = ajv.getSchema(
      'https://kvm-recon.local/schema/2.0/manifest.schema.json',
    );
    const validateIntegrity = ajv.getSchema(
      'https://kvm-recon.local/schema/2.0/integrity.schema.json',
    );

    const sample = await createSampleCapturePackV2();

    // 合法样例必须通过。
    expect(validateManifest?.(sample.manifest)).toBe(true);
    expect(validateIntegrity?.(sample.integrity)).toBe(true);

    // COMPLETE 只能与 KVM_REACHED 组合。
    for (const workflowStatus of ['LOGIN_REACHED', 'TARGET_OPENED'] as const) {
      const invalid = { ...sample.manifest, workflowStatus };
      expect(validateManifest?.(invalid), `COMPLETE + ${workflowStatus}`).toBe(false);
    }

    // COMPLETE 不允许携带原因代码。
    expect(
      validateIntegrity?.({
        ...sample.integrity,
        reasons: ['INCOMPLETE_BODY_MISSING'],
      }),
    ).toBe(false);

    // COMPLETE 不允许存在失败门禁。
    expect(
      validateIntegrity?.({
        ...sample.integrity,
        gates: sample.integrity.gates.map(gate =>
          gate.id === 'targets-attached' ? { ...gate, passed: false } : gate,
        ),
      }),
    ).toBe(false);

    // INCOMPLETE 必须至少携带一个原因代码。
    expect(
      validateIntegrity?.({
        ...sample.integrity,
        captureIntegrity: 'INCOMPLETE',
        reasons: [],
      }),
    ).toBe(false);

    // gates 必须恰好覆盖十个唯一门禁。
    expect(validateIntegrity?.({ ...sample.integrity, gates: sample.integrity.gates.slice(0, 9) })).toBe(
      false,
    );
    expect(
      validateIntegrity?.({
        ...sample.integrity,
        gates: [...sample.integrity.gates.slice(0, 9), sample.integrity.gates[0]],
      }),
    ).toBe(false);

    // INCOMPLETE 的原因代码必须在稳定代码表内。
    expect(
      validateIntegrity?.({
        ...sample.integrity,
        captureIntegrity: 'INCOMPLETE',
        reasons: ['INCOMPLETE_SOMETHING_NEW'],
      }),
    ).toBe(false);

    // replay 通道必须声明 requiresDynamicValueIds（缺字段或非数组都拒绝）。
    const artifacts = new Map(sample.artifacts.map(artifact => [artifact.path, artifact]));
    const replayManifestFile = JSON.parse(
      String(artifacts.get('replay/manifest.json')!.content),
    ) as { channels: Array<Record<string, unknown>> };
    const replayChannelsFile = JSON.parse(
      String(artifacts.get('replay/channels.json')!.content),
    ) as { channels: Array<Record<string, unknown>> };
    const validateReplayManifest = ajv.getSchema(
      'https://kvm-recon.local/schema/2.0/replay-manifest.schema.json',
    );
    const validateReplayChannels = ajv.getSchema(
      'https://kvm-recon.local/schema/2.0/replay-channels.schema.json',
    );
    const channelWithoutValues = (channel: Record<string, unknown>) => {
      const copy = { ...channel };
      delete copy.requiresDynamicValueIds;
      return copy;
    };
    expect(
      validateReplayManifest?.({
        ...replayManifestFile,
        channels: replayManifestFile.channels.map(channelWithoutValues),
      }),
    ).toBe(false);
    expect(
      validateReplayManifest?.({
        ...replayManifestFile,
        channels: replayManifestFile.channels.map((channel: Record<string, unknown>) => ({
          ...channel,
          requiresDynamicValueIds: 'value-0002',
        })),
      }),
    ).toBe(false);
    expect(
      validateReplayChannels?.({
        ...replayChannelsFile,
        channels: replayChannelsFile.channels.map(channelWithoutValues),
      }),
    ).toBe(false);

    // replayable=false 必须携带非空 notReplayableReasons（缺失证据逐条显式，规范 §16）。
    expect(validateReplayManifest?.({ ...replayManifestFile, replayable: false })).toBe(false);
    expect(
      validateReplayManifest?.({
        ...replayManifestFile,
        replayable: false,
        notReplayableReasons: [],
      }),
    ).toBe(false);
    expect(
      validateReplayManifest?.({
        ...replayManifestFile,
        replayable: false,
        notReplayableReasons: ['未观察到登录交互：没有 Set-Cookie 签发（带正文的 POST + 2xx/3xx 响应），也没有凭据头形态请求（Authorization 类）'],
      }),
    ).toBe(true);
  }, 30000);

  it('WebRTC / WebTransport 行 Schema 校验合法行并通过负向检查', async () => {
    const schemaRoot = join(process.cwd(), 'schema/2.0');
    const schemas = readdirSync(schemaRoot)
      .filter(name => name.endsWith('.schema.json'))
      .map(name => JSON.parse(readFileSync(join(schemaRoot, name), 'utf8')) as JsonSchema);
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, allowUnionTypes: true });
    for (const schema of schemas) ajv.addSchema(schema);
    const validateWebRtc = ajv.getSchema(
      'https://kvm-recon.local/schema/2.0/realtime-webrtc.schema.json',
    );
    const validateWebTransport = ajv.getSchema(
      'https://kvm-recon.local/schema/2.0/realtime-webtransport.schema.json',
    );

    const validWebRtcRow = {
      occurredAt: '2026-09-18T14:35:23+08:00',
      targetId: 'target-page-0001',
      peerConnectionId: 'pc-0001',
      kind: 'offer',
      detail: { sdp: 'v=0\r\n', preserveVerbatim: true },
    };
    expect(validateWebRtc?.(validWebRtcRow)).toBe(true);
    expect(validateWebRtc?.({ ...validWebRtcRow, kind: 'not-a-webrtc-kind' })).toBe(false);
    const { peerConnectionId, ...webRtcWithoutPeer } = validWebRtcRow;
    expect(validateWebRtc?.(webRtcWithoutPeer)).toBe(false);

    const validWebTransportRow = {
      occurredAt: '2026-09-18T14:35:23+08:00',
      targetId: 'target-page-0001',
      transportId: 'wt-0001',
      kind: 'datagram',
      direction: 'down',
      messageIndex: 0,
      fin: true,
      messageRef: {
        sha256: '2'.repeat(64),
        bytes: 32,
        path: 'raw/realtime/bodies/' + '2'.repeat(64),
      },
    };
    expect(validateWebTransport?.(validWebTransportRow)).toBe(true);
    expect(validateWebTransport?.({ ...validWebTransportRow, kind: 'unknown' })).toBe(false);
    expect(
      validateWebTransport?.({ occurredAt: 'x', targetId: 't', kind: 'datagram' }),
    ).toBe(false);

    // SSE 行：生命周期 kind 必填（connected/event/error/closed）。
    const validateSse = ajv.getSchema('https://kvm-recon.local/schema/2.0/realtime-sse.schema.json');
    const validSseRow = {
      id: 'sse-0001',
      occurredAt: '2026-09-18T14:35:23+08:00',
      targetId: 'target-page-0001',
      url: 'http://127.0.0.1:48080/stream',
      kind: 'event',
      event: 'message',
      dataRef: {
        sha256: 'a'.repeat(64),
        bytes: 12,
        path: 'raw/realtime/bodies/' + 'a'.repeat(64),
      },
    };
    expect(validateSse?.(validSseRow)).toBe(true);
    const { id: sseId, ...sseWithoutId } = validSseRow;
    void sseId;
    expect(validateSse?.(sseWithoutId)).toBe(false);
    const { kind: sseKind, ...sseWithoutKind } = validSseRow;
    void sseKind;
    expect(validateSse?.(sseWithoutKind)).toBe(false);
    expect(validateSse?.({ ...validSseRow, kind: 'connected' })).toBe(true);
    expect(validateSse?.({ ...validSseRow, url: '' })).toBe(false);

    // WebRTC datachannel-message：消息字段（方向/通道/序号/FIN/正文引用）全部必填。
    const validDatachannelMessage = {
      occurredAt: '2026-09-18T14:35:23+08:00',
      targetId: 'target-page-0001',
      peerConnectionId: 'pc-0001',
      kind: 'datachannel-message',
      direction: 'down',
      dataChannelId: 'dc-0001',
      messageIndex: 0,
      fin: true,
      messageRef: {
        sha256: 'e'.repeat(64),
        bytes: 64,
        path: 'raw/realtime/bodies/' + 'e'.repeat(64),
      },
    };
    expect(validateWebRtc?.(validDatachannelMessage)).toBe(true);
    const { direction: dcDirection, ...messageWithoutDirection } = validDatachannelMessage;
    void dcDirection;
    expect(validateWebRtc?.(messageWithoutDirection)).toBe(false);
    const { messageRef: dcRef, ...messageWithoutPayload } = validDatachannelMessage;
    void dcRef;
    expect(validateWebRtc?.(messageWithoutPayload)).toBe(false);

    // WebTransport stream-message：正文引用与 stream 标识必填。
    const validStreamMessage = {
      occurredAt: '2026-09-18T14:35:23+08:00',
      targetId: 'target-page-0001',
      transportId: 'wt-0001',
      kind: 'stream-message',
      direction: 'up',
      streamId: 's-0001',
      messageIndex: 3,
      fin: false,
      messageRef: {
        sha256: '1'.repeat(64),
        bytes: 16,
        path: 'raw/realtime/bodies/' + '1'.repeat(64),
      },
    };
    expect(validateWebTransport?.(validStreamMessage)).toBe(true);
    const { messageRef: streamRef, ...streamMessageWithoutPayload } = validStreamMessage;
    void streamRef;
    expect(validateWebTransport?.(streamMessageWithoutPayload)).toBe(false);

    // 下载：completed=true 必须携带文件引用。
    const validateDownload = ajv.getSchema(
      'https://kvm-recon.local/schema/2.0/realtime-download.schema.json',
    );
    const validDownloadRow = {
      id: 'download-0001',
      occurredAt: '2026-09-18T14:35:23+08:00',
      targetId: 'target-page-0001',
      url: 'http://127.0.0.1:48080/kvm.jnlp',
      suggestedFileName: 'viewer.jnlp',
      fileRef: {
        sha256: 'b'.repeat(64),
        bytes: 4096,
        path: 'raw/realtime/downloads/' + 'b'.repeat(64),
      },
      completed: true,
    };
    expect(validateDownload?.(validDownloadRow)).toBe(true);
    const completedWithoutFile = { ...validDownloadRow };
    delete (completedWithoutFile as Partial<typeof validDownloadRow>).fileRef;
    expect(validateDownload?.(completedWithoutFile)).toBe(false);
    // 未完成的下载（completed=false）允许暂无文件引用。
    const incompleteDownload = { ...completedWithoutFile, completed: false };
    expect(validateDownload?.(incompleteDownload)).toBe(true);

    // crypto 行：合法行通过，负向（缺算法 / 非法 kind）拒绝。
    const validateCrypto = ajv.getSchema('https://kvm-recon.local/schema/2.0/runtime-crypto.schema.json');
    const validCryptoRow = {
      id: 'crypto-0002',
      occurredAt: '2026-09-18T14:35:23+08:00',
      targetId: 'target-page-0001',
      kind: 'encrypt',
      algorithm: 'RSA-OAEP',
      algorithmParams: { modulusLength: 2048 },
      scriptUrl: 'http://127.0.0.1:48080/login',
      lineNumber: 42,
      inputRef: {
        sha256: 'c'.repeat(64),
        bytes: 32,
        path: 'raw/runtime/bodies/' + 'c'.repeat(64),
      },
      outputRef: {
        sha256: 'd'.repeat(64),
        bytes: 256,
        path: 'raw/runtime/bodies/' + 'd'.repeat(64),
      },
    };
    expect(validateCrypto?.(validCryptoRow)).toBe(true);
    const { algorithm, ...cryptoWithoutAlgorithm } = validCryptoRow;
    void algorithm;
    expect(validateCrypto?.(cryptoWithoutAlgorithm)).toBe(false);
    expect(validateCrypto?.({ ...validCryptoRow, kind: 'hash' })).toBe(false);
    // 成功调用必须至少有输入、输出或异常之一，不允许三者全无。
    const cryptoWithoutInputOutput: Record<string, unknown> = { ...validCryptoRow };
    delete cryptoWithoutInputOutput.inputRef;
    delete cryptoWithoutInputOutput.outputRef;
    expect(validateCrypto?.(cryptoWithoutInputOutput)).toBe(false);
    expect(
      validateCrypto?.({ ...cryptoWithoutInputOutput, error: 'OperationError' }),
    ).toBe(true);
  });
});
