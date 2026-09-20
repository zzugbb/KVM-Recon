import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createSampleCapturePackV2,
  type SampleArtifact,
} from './createSampleCapturePackV2';
import { validatePackV2Consistency } from './packV2Consistency';

/**
 * 阶段 0 负向一致性测试（审查要求）：删除正文、删除截图、制造悬空引用、
 * 篡改哈希、篡改帧偏移、状态不一致、Schema 违约、空 journal、重复路径、
 * 非法顶层条目都必须被独立验证器抓出，不允许「声明 COMPLETE 但原始资料缺失」。
 */

function codesOf(artifacts: SampleArtifact[]): string[] {
  return validatePackV2Consistency(artifacts).problems.map(problem => problem.code);
}

function withArtifact(
  artifacts: SampleArtifact[],
  path: string,
  content: string | Uint8Array,
): SampleArtifact[] {
  return artifacts.map(artifact => (artifact.path === path ? { path, content } : artifact));
}

/** 重算 checksums.sha256，让负向测试聚焦目标检查而非 checksum 副作用。 */
function withRecomputedChecksums(artifacts: SampleArtifact[]): SampleArtifact[] {
  const rest = artifacts.filter(artifact => artifact.path !== 'checksums.sha256');
  const lines = [...rest]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(artifact => {
      const bytes =
        typeof artifact.content === 'string'
          ? Buffer.from(artifact.content, 'utf8')
          : Buffer.from(artifact.content);
      return `${createHash('sha256').update(bytes).digest('hex')}  ${artifact.path}`;
    });
  return [...rest, { path: 'checksums.sha256', content: `${lines.join('\n')}\n` }];
}

describe('validatePackV2Consistency（独立一致性验证器）', () => {
  it('正向：样例包整体一致（生成器终检之外的独立复核）', async () => {
    const sample = await createSampleCapturePackV2();
    const result = validatePackV2Consistency(sample.artifacts);
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
    expect(sample.manifest.captureIntegrity).toBe('COMPLETE');
  }, 30000);

  it('删除正文文件 → 悬空引用 + checksum 余项', async () => {
    const sample = await createSampleCapturePackV2();
    const victim = sample.artifacts.find(artifact => artifact.path.startsWith('raw/http/bodies/'))!;
    const mutated = sample.artifacts.filter(artifact => artifact.path !== victim.path);
    const codes = codesOf(mutated);
    expect(codes).toContain('DANGLING_BODY_REF');
    expect(codes).toContain('CHECKSUM_EXTRA_ENTRY');
    expect(validatePackV2Consistency(mutated).valid).toBe(false);
  }, 30000);

  it('删除全部截图 → MISSING_SCREENSHOT', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = sample.artifacts.filter(
      artifact => !artifact.path.startsWith('raw/browser/screenshots/'),
    );
    const codes = codesOf(mutated);
    expect(codes).toContain('MISSING_SCREENSHOT');
  }, 30000);

  it('篡改正文内容哈希 → BODY_HASH_MISMATCH + CHECKSUM_MISMATCH', async () => {
    const sample = await createSampleCapturePackV2();
    const victim = sample.artifacts.find(artifact => artifact.path.startsWith('raw/http/bodies/'))!;
    const tampered = withArtifact(sample.artifacts, victim.path, 'tampered-body-content');
    const codes = codesOf(tampered);
    expect(codes).toContain('BODY_HASH_MISMATCH');
    expect(codes).toContain('CHECKSUM_MISMATCH');
  }, 30000);

  it('制造悬空 relations 引用 → UNKNOWN_EVIDENCE_ID', async () => {
    const sample = await createSampleCapturePackV2();
    const relations = sample.artifacts.find(artifact => artifact.path === 'catalog/relations.jsonl')!;
    const text = String(relations.content).replace(
      /"to":"http-000002"/,
      '"to":"http-999999"',
    );
    expect(text).not.toEqual(String(relations.content));
    const mutated = withArtifact(sample.artifacts, 'catalog/relations.jsonl', text);
    expect(codesOf(mutated)).toContain('UNKNOWN_EVIDENCE_ID');
  }, 30000);

  it('篡改 WS 帧偏移 → FRAME_OFFSET_MISMATCH', async () => {
    const sample = await createSampleCapturePackV2();
    const frames = sample.artifacts.find(
      artifact => artifact.path === 'raw/websocket/ws-0001/frames.index.jsonl',
    )!;
    const text = String(frames.content).replace('"payloadOffset":32', '"payloadOffset":99');
    expect(text).not.toEqual(String(frames.content));
    const mutated = withArtifact(
      sample.artifacts,
      'raw/websocket/ws-0001/frames.index.jsonl',
      text,
    );
    expect(codesOf(mutated)).toContain('FRAME_OFFSET_MISMATCH');
  }, 30000);

  it('manifest 与 integrity 状态不一致 → STATUS_MISMATCH', async () => {
    const sample = await createSampleCapturePackV2();
    const manifestText = String(
      sample.artifacts.find(artifact => artifact.path === 'manifest.json')!.content,
    ).replace('"captureIntegrity": "COMPLETE"', '"captureIntegrity": "INCOMPLETE"');
    const mutated = withArtifact(sample.artifacts, 'manifest.json', manifestText);
    expect(codesOf(mutated)).toContain('STATUS_MISMATCH');
  }, 30000);

  it('非法状态组合（manifest COMPLETE + TARGET_OPENED）→ STATUS_ILLEGAL', async () => {
    const sample = await createSampleCapturePackV2();
    const manifestText = String(
      sample.artifacts.find(artifact => artifact.path === 'manifest.json')!.content,
    ).replace('"workflowStatus": "KVM_REACHED"', '"workflowStatus": "TARGET_OPENED"');
    const mutated = withArtifact(sample.artifacts, 'manifest.json', manifestText);
    expect(codesOf(mutated)).toContain('STATUS_ILLEGAL');
  }, 30000);

  it('integrity COMPLETE + 失败门禁 → GATE_FAILED_WITH_COMPLETE + STATUS_ILLEGAL', async () => {
    const sample = await createSampleCapturePackV2();
    const integrityText = String(
      sample.artifacts.find(artifact => artifact.path === 'integrity.json')!.content,
    ).replace('"id": "targets-attached",\n      "passed": true', '"id": "targets-attached",\n      "passed": false');
    expect(integrityText).not.toEqual(
      String(sample.artifacts.find(artifact => artifact.path === 'integrity.json')!.content),
    );
    const mutated = withArtifact(sample.artifacts, 'integrity.json', integrityText);
    expect(codesOf(mutated)).toContain('GATE_FAILED_WITH_COMPLETE');
  }, 30000);

  it('门禁数量不是 10 → GATE_COUNT_INVALID', async () => {
    const sample = await createSampleCapturePackV2();
    const integrity = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === 'integrity.json')!.content),
    ) as { gates: unknown[] };
    const trimmed = {
      ...integrity,
      gates: integrity.gates.slice(0, 9),
    };
    const mutated = withArtifact(
      sample.artifacts,
      'integrity.json',
      `${JSON.stringify(trimmed, null, 2)}\n`,
    );
    expect(codesOf(mutated)).toContain('GATE_COUNT_INVALID');
  }, 30000);

  it('删除 DOM 快照 → MISSING_DOM_SNAPSHOT', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = sample.artifacts.filter(
      artifact => !artifact.path.startsWith('raw/browser/dom-snapshots/'),
    );
    expect(codesOf(mutated)).toContain('MISSING_DOM_SNAPSHOT');
  }, 30000);

  it('删除 integrity.json → REQUIRED_FILE_MISSING', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = sample.artifacts.filter(artifact => artifact.path !== 'integrity.json');
    expect(codesOf(mutated)).toContain('REQUIRED_FILE_MISSING');
  }, 30000);

  it('Schema 违约（manifest 非法 workflowStatus）→ SCHEMA_VIOLATION', async () => {
    const sample = await createSampleCapturePackV2();
    const manifestText = String(
      sample.artifacts.find(artifact => artifact.path === 'manifest.json')!.content,
    ).replace('"workflowStatus": "KVM_REACHED"', '"workflowStatus": "KVM-REACHED"');
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'manifest.json', manifestText),
    );
    expect(codesOf(mutated)).toContain('SCHEMA_VIOLATION');
  }, 30000);

  it('重算 checksum 后 Schema 非法的包仍被拒绝（Schema 自校验不受 checksum 修复影响）', async () => {
    const sample = await createSampleCapturePackV2();
    const transactions = sample.artifacts.find(
      artifact => artifact.path === 'raw/http/transactions.jsonl',
    )!;
    const tampered = String(transactions.content).replace('"status":200', '"status":"200"');
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'raw/http/transactions.jsonl', tampered),
    );
    const codes = codesOf(mutated);
    expect(codes).not.toContain('CHECKSUM_MISMATCH');
    expect(codes).toContain('SCHEMA_VIOLATION');
    expect(validatePackV2Consistency(mutated).valid).toBe(false);
  }, 30000);

  it('空 CDP journal（有 HTTP 事务）→ RAW_JOURNAL_EMPTY', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'raw/cdp/events.jsonl', ''),
    );
    expect(codesOf(mutated)).toContain('RAW_JOURNAL_EMPTY');
  }, 30000);

  it('空 NetLog（有 HTTP 事务）→ RAW_JOURNAL_EMPTY', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'raw/netlog/netlog.json', '{"schemaVersion":"2.0.0","captureMode":"IncludeSensitive","events":[]}'),
    );
    expect(codesOf(mutated)).toContain('RAW_JOURNAL_EMPTY');
  }, 30000);

  it('重复包内路径 → DUPLICATE_PATH', async () => {
    const sample = await createSampleCapturePackV2();
    const victim = sample.artifacts.find(artifact => artifact.path === 'manifest.json')!;
    const mutated = [...sample.artifacts, { ...victim }];
    expect(codesOf(mutated)).toContain('DUPLICATE_PATH');
  }, 30000);

  it('契约外顶层条目 → UNEXPECTED_TOP_LEVEL_ENTRY', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums([
      ...sample.artifacts,
      { path: 'ads/campaign.json', content: '{"goal":"marketing"}' },
    ]);
    expect(codesOf(mutated)).toContain('UNEXPECTED_TOP_LEVEL_ENTRY');
  }, 30000);

  it('00_START_HERE.md 缺信任边界 → START_HERE_INVALID', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, '00_START_HERE.md', '# 只有标题的空文档'),
    );
    expect(codesOf(mutated)).toContain('START_HERE_INVALID');
  }, 30000);

  it('COMPLETE 包只有一张截图 → MISSING_VIEWER_SCREENSHOTS', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums(
      sample.artifacts.filter(artifact => artifact.path !== 'raw/browser/screenshots/viewer-stable.png'),
    );
    expect(codesOf(mutated)).toContain('MISSING_VIEWER_SCREENSHOTS');
  }, 30000);

  it('WebSocket 通道缺 payloadPath → CHANNEL_FILE_MISSING', async () => {
    const sample = await createSampleCapturePackV2();
    const channelsText = String(
      sample.artifacts.find(artifact => artifact.path === 'catalog/channels.json')!.content,
    ).replace('"payloadPath": "raw/websocket/ws-0001/frames.bin"', '"payloadPath": null');
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'catalog/channels.json', channelsText),
    );
    expect(codesOf(mutated)).toContain('CHANNEL_FILE_MISSING');
  }, 30000);

  it('未知门禁 ID → GATE_ID_INVALID', async () => {
    const sample = await createSampleCapturePackV2();
    const integrityText = String(
      sample.artifacts.find(artifact => artifact.path === 'integrity.json')!.content,
    ).replace('"id": "targets-attached"', '"id": "targets-attached-v2"');
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'integrity.json', integrityText),
    );
    const codes = codesOf(mutated);
    expect(codes).toContain('GATE_ID_INVALID');
    expect(codes).toContain('SCHEMA_VIOLATION');
  }, 30000);

  it('删除单个 Schema 副本并重算 checksum → PACK_SCHEMA_MISSING，不再静默跳过', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums(
      sample.artifacts.filter(artifact => artifact.path !== 'schema/manifest.schema.json'),
    );
    const codes = codesOf(mutated);
    expect(codes).toContain('PACK_SCHEMA_MISSING');
    expect(validatePackV2Consistency(mutated).valid).toBe(false);
  }, 30000);

  it('Schema 文件在场但 $id 缺失或篡改，重算 checksum 后仍拒绝（不允许静默绕过自校验）', async () => {
    const sample = await createSampleCapturePackV2();
    const schemaPath = 'schema/manifest.schema.json';
    const schemaJson = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === schemaPath)!.content),
    ) as Record<string, unknown>;

    // 篡改 $id：编译能成功，但 $id 与文件名不对应 → 必须报 SCHEMA_VIOLATION。
    const tamperedId = withRecomputedChecksums(
      withArtifact(
        sample.artifacts,
        schemaPath,
        `${JSON.stringify(
          { ...schemaJson, $id: 'https://kvm-recon.local/schema/2.0/other-name.schema.json' },
          null,
          2,
        )}\n`,
      ),
    );
    expect(codesOf(tamperedId)).toContain('SCHEMA_VIOLATION');
    expect(validatePackV2Consistency(tamperedId).valid).toBe(false);

    // 删除 $id：同样必须拒绝，且 manifest.json 不因缺验证函数被静默放行。
    const { $id: _removed, ...withoutId } = schemaJson;
    const tamperedNoId = withRecomputedChecksums(
      withArtifact(sample.artifacts, schemaPath, `${JSON.stringify(withoutId, null, 2)}\n`),
    );
    const codes = codesOf(tamperedNoId);
    expect(codes).toContain('SCHEMA_VIOLATION');
    expect(validatePackV2Consistency(tamperedNoId).valid).toBe(false);
  }, 30000);

  it('catalog 存在 WebRTC 通道但 webrtc.jsonl 无对应记录 → CHANNEL_EVENT_MISSING', async () => {
    const sample = await createSampleCapturePackV2();
    const channels = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === 'catalog/channels.json')!.content),
    ) as { channels: unknown[] };
    const mutated = withRecomputedChecksums(
      withArtifact(
        sample.artifacts,
        'catalog/channels.json',
        `${JSON.stringify(
          {
            ...channels,
            channels: [
              ...channels.channels,
              { id: 'pc-0001', kind: 'webrtc', url: null, targetId: 'target-page-0001', createdAt: '2026-09-18T14:35:22+08:00', closedAt: null, frameCounts: null, payloadPath: null },
            ],
          },
          null,
          2,
        )}\n`,
      ),
    );
    expect(codesOf(mutated)).toContain('CHANNEL_EVENT_MISSING');
  }, 30000);

  it('relations.evidencePath 指向缺失文件 → DANGLING_EVIDENCE_PATH', async () => {
    const sample = await createSampleCapturePackV2();
    const relationsText = String(
      sample.artifacts.find(artifact => artifact.path === 'catalog/relations.jsonl')!.content,
    ).replace('"evidencePath":"raw/http/transactions.jsonl"', '"evidencePath":"raw/http/missing.jsonl"');
    expect(relationsText).not.toEqual(
      String(sample.artifacts.find(artifact => artifact.path === 'catalog/relations.jsonl')!.content),
    );
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'catalog/relations.jsonl', relationsText),
    );
    expect(codesOf(mutated)).toContain('DANGLING_EVIDENCE_PATH');
  }, 30000);

  it('value-flow 节点引用缺失证据文件与未知证据 ID → DANGLING_EVIDENCE_PATH / UNKNOWN_EVIDENCE_ID', async () => {
    const sample = await createSampleCapturePackV2();
    const valueFlowText = String(
      sample.artifacts.find(artifact => artifact.path === 'ai/value-flow.json')!.content,
    )
      .replace('"evidencePath": "raw/http/transactions.jsonl"', '"evidencePath": "raw/http/missing.jsonl"')
      .replace('"evidenceId": "http-000002"', '"evidenceId": "http-999999"');
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'ai/value-flow.json', valueFlowText),
    );
    const codes = codesOf(mutated);
    expect(codes).toContain('DANGLING_EVIDENCE_PATH');
    expect(codes).toContain('UNKNOWN_EVIDENCE_ID');
  }, 30000);

  it('replay 引用未知动态值节点 → REPLAY_UNKNOWN_ID', async () => {
    const sample = await createSampleCapturePackV2();
    const replayText = String(
      sample.artifacts.find(artifact => artifact.path === 'replay/manifest.json')!.content,
    ).replace('"requiresDynamicValueIds": [\n        "value-0007",\n        "value-0008"\n      ]', '"requiresDynamicValueIds": [\n        "value-9999"\n      ]');
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'replay/manifest.json', replayText),
    );
    expect(codesOf(mutated)).toContain('REPLAY_UNKNOWN_ID');
  }, 30000);

  it('replay/http.jsonl 引用未知请求与缺失正文 → REPLAY_UNKNOWN_ID / DANGLING_EVIDENCE_PATH', async () => {
    const sample = await createSampleCapturePackV2();
    const replayHttpText = String(
      sample.artifacts.find(artifact => artifact.path === 'replay/http.jsonl')!.content,
    )
      .replace('"requestId":"http-000002"', '"requestId":"http-999999"')
      .replace('"requestBodyPath":null', '"requestBodyPath":"raw/http/bodies/missing"');
    expect(replayHttpText).not.toEqual(
      String(sample.artifacts.find(artifact => artifact.path === 'replay/http.jsonl')!.content),
    );
    const mutated = withRecomputedChecksums(
      withArtifact(sample.artifacts, 'replay/http.jsonl', replayHttpText),
    );
    const codes = codesOf(mutated);
    expect(codes).toContain('REPLAY_UNKNOWN_ID');
    expect(codes).toContain('DANGLING_EVIDENCE_PATH');
  }, 30000);

  it('删除全部 replay/http.jsonl 行 → REPLAY_MISMATCH（manifest 声明的请求必须逐项在场）', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums(withArtifact(sample.artifacts, 'replay/http.jsonl', ''));
    const codes = codesOf(mutated);
    expect(codes).toContain('REPLAY_MISMATCH');
    expect(validatePackV2Consistency(mutated).valid).toBe(false);
  }, 30000);

  it('清空 replay/channels.json → REPLAY_MISMATCH（不允许 manifest 声明而通道文件为空）', async () => {
    const sample = await createSampleCapturePackV2();
    const mutated = withRecomputedChecksums(
      withArtifact(
        sample.artifacts,
        'replay/channels.json',
        `${JSON.stringify({ schemaVersion: '2.0.0', channels: [] }, null, 2)}\n`,
      ),
    );
    const codes = codesOf(mutated);
    expect(codes).toContain('REPLAY_MISMATCH');
    expect(validatePackV2Consistency(mutated).valid).toBe(false);
  }, 30000);

  it('replay 请求 URL 与 replay/http.jsonl / catalog 不一致 → REPLAY_MISMATCH', async () => {
    const sample = await createSampleCapturePackV2();
    const replayManifest = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === 'replay/manifest.json')!.content),
    ) as { requests: Array<{ requestId: string; url: string }> };
    const login = replayManifest.requests.find(request => request.requestId === 'http-000002')!;
    login.url = 'http://127.0.0.1:48080/other/url';
    const mutated = withRecomputedChecksums(
      withArtifact(
        sample.artifacts,
        'replay/manifest.json',
        `${JSON.stringify(replayManifest, null, 2)}\n`,
      ),
    );
    expect(codesOf(mutated)).toContain('REPLAY_MISMATCH');
  }, 30000);

  it('replay 通道引用未知动态值节点 → REPLAY_UNKNOWN_ID', async () => {
    const sample = await createSampleCapturePackV2();
    const replayChannels = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === 'replay/channels.json')!.content),
    ) as { channels: Array<{ channelId: string; requiresDynamicValueIds?: string[] }> };
    replayChannels.channels[0].requiresDynamicValueIds = ['value-9999'];
    const mutated = withRecomputedChecksums(
      withArtifact(
        sample.artifacts,
        'replay/channels.json',
        `${JSON.stringify(replayChannels, null, 2)}\n`,
      ),
    );
    expect(codesOf(mutated)).toContain('REPLAY_UNKNOWN_ID');
  }, 30000);

  it('replay 各文件中重复 ID → REPLAY_MISMATCH（不允许 Map/Set 静默合并重复定义）', async () => {
    const sample = await createSampleCapturePackV2();
    const replayManifest = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === 'replay/manifest.json')!.content),
    ) as {
      requests: Array<{ requestId: string }>;
      channels: Array<{ channelId: string }>;
    };
    replayManifest.requests.push({ ...replayManifest.requests[0] });
    replayManifest.channels.push({ ...replayManifest.channels[0] });
    const httpLines = String(
      sample.artifacts.find(artifact => artifact.path === 'replay/http.jsonl')!.content,
    )
      .trimEnd()
      .split('\n');
    const replayChannels = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === 'replay/channels.json')!.content),
    ) as { channels: Array<{ channelId: string }> };
    replayChannels.channels.push({ ...replayChannels.channels[0] });
    let mutated = withArtifact(
      sample.artifacts,
      'replay/manifest.json',
      `${JSON.stringify(replayManifest, null, 2)}\n`,
    );
    mutated = withArtifact(
      mutated,
      'replay/http.jsonl',
      `${httpLines.join('\n')}\n${httpLines[0]}\n`,
    );
    mutated = withArtifact(
      mutated,
      'replay/channels.json',
      `${JSON.stringify(replayChannels, null, 2)}\n`,
    );
    mutated = withRecomputedChecksums(mutated);
    const result = validatePackV2Consistency(mutated);
    expect(result.valid).toBe(false);
    // 四处重复定义（manifest 请求 / manifest 通道 / http 行 / channels 通道）逐一报错。
    expect(result.problems.filter(problem => problem.code === 'REPLAY_MISMATCH').length).toBe(4);
  }, 30000);

  it('通道 requiresDynamicValueIds 与 manifest 集合不相等 → REPLAY_MISMATCH（全为合法 ID 也必须报错）', async () => {
    const sample = await createSampleCapturePackV2();
    const replayChannels = JSON.parse(
      String(sample.artifacts.find(artifact => artifact.path === 'replay/channels.json')!.content),
    ) as { channels: Array<{ channelId: string; requiresDynamicValueIds?: string[] }> };
    const ws = replayChannels.channels.find(channel => channel.channelId === 'ws-0001')!;
    // value-0010 是真实存在的动态值节点：仅靠“引用存在”检查无法发现，必须集合比较。
    ws.requiresDynamicValueIds = ['value-0002', 'value-0010'];
    const mutated = withRecomputedChecksums(
      withArtifact(
        sample.artifacts,
        'replay/channels.json',
        `${JSON.stringify(replayChannels, null, 2)}\n`,
      ),
    );
    const result = validatePackV2Consistency(mutated);
    expect(result.valid).toBe(false);
    expect(result.problems.map(problem => problem.code)).toContain('REPLAY_MISMATCH');
  }, 30000);

  it('replay/http.jsonl 正文指向另一个现存正文 → REPLAY_MISMATCH（存在性检查不足以发现）', async () => {
    const sample = await createSampleCapturePackV2();
    const rows = String(
      sample.artifacts.find(artifact => artifact.path === 'replay/http.jsonl')!.content,
    )
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line)) as Array<{
      requestId: string;
      requestBodyPath: string | null;
      responseBodyPath: string | null;
    }>;
    const login = rows.find(row => row.requestId === 'http-000002')!;
    expect(login.requestBodyPath).toBeTruthy();
    expect(login.responseBodyPath).toBeTruthy();
    expect(login.requestBodyPath).not.toEqual(login.responseBodyPath);
    // 响应正文改指包内另一个真实存在的正文文件（登录请求正文）：
    // DANGLING_EVIDENCE_PATH 不会触发，只有 catalog BodyRef 对齐能发现。
    login.responseBodyPath = login.requestBodyPath;
    const mutated = withRecomputedChecksums(
      withArtifact(
        sample.artifacts,
        'replay/http.jsonl',
        `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
      ),
    );
    const codes = codesOf(mutated);
    expect(codes).toContain('REPLAY_MISMATCH');
    expect(codes).not.toContain('DANGLING_EVIDENCE_PATH');
    expect(validatePackV2Consistency(mutated).valid).toBe(false);
  }, 30000);

  it('文件背书的预计算 sha256/bytes 与逐字节校验完全等价（大正文不载入内存）', async () => {
    const sample = await createSampleCapturePackV2();
    const bytesOfContent = (content: string | Uint8Array) =>
      (typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)).length;
    const isStructured = (path: string) =>
      /\.(json|jsonl|md|html)$/.test(path) || path === 'checksums.sha256';
    const fileBacked = sample.artifacts.map(artifact => ({
      path: artifact.path,
      // 二进制（正文/截图/frames.bin/har/脚本文件）内容置空，只保留流式预计算值。
      content: isStructured(artifact.path) ? artifact.content : new Uint8Array(0),
      sha256: createHash('sha256').update(Buffer.from(artifact.content as Uint8Array)).digest('hex'),
      bytes: bytesOfContent(artifact.content),
    }));
    const result = validatePackV2Consistency(fileBacked);
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
  }, 30000);

  it('预计算 sha256 与 BodyRef 不符 → BODY_HASH_MISMATCH（错误背书不能蒙混）', async () => {
    const sample = await createSampleCapturePackV2();
    const bodyPath = sample.artifacts.find(
      artifact => artifact.path.startsWith('raw/http/bodies/'),
    )!.path;
    const forged = sample.artifacts.map(artifact =>
      artifact.path === bodyPath
        ? {
            path: artifact.path,
            content: new Uint8Array(0),
            sha256: '0'.repeat(64),
            bytes: Buffer.from(artifact.content as Uint8Array).length,
          }
        : artifact,
    );
    expect(codesOf(forged)).toContain('BODY_HASH_MISMATCH');
  }, 30000);

  it('预计算 bytes 与 BodyRef 不符 → BODY_HASH_MISMATCH', async () => {
    const sample = await createSampleCapturePackV2();
    const bodyPath = sample.artifacts.find(
      artifact => artifact.path.startsWith('raw/http/bodies/'),
    )!.path;
    const forged = sample.artifacts.map(artifact =>
      artifact.path === bodyPath
        ? {
            path: artifact.path,
            content: new Uint8Array(0),
            sha256: createHash('sha256').update(Buffer.from(artifact.content as Uint8Array)).digest('hex'),
            bytes: Buffer.from(artifact.content as Uint8Array).length + 1,
          }
        : artifact,
    );
    expect(codesOf(forged)).toContain('BODY_HASH_MISMATCH');
  }, 30000);
});
