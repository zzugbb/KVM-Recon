import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { streamValidateRawJournals, type StreamedRawJournalInput } from './streamingRawJournalChecks';
import { createSampleCapturePackV2 } from '../capture-pack-v2/createSampleCapturePackV2';
import type { ZipArtifact } from './exportPackV2Zip';

/**
 * 流式 raw journal 校验：样例包正向零问题（与元数据校验
 * 双通道覆盖一致），以及每类领域反例必须在流式通道被独立抓出——
 * cdp seq 递增、空 journal、NetLog 字段/元素、帧偏移、BodyRef、通道关联。
 */

function bytesOf(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

async function sampleStreamerInput(): Promise<StreamedRawJournalInput> {
  const sample = await createSampleCapturePackV2();
  const artifacts: ZipArtifact[] = sample.artifacts
    .filter(artifact => artifact.path !== 'checksums.sha256')
    .map(artifact => ({
      path: artifact.path,
      source: { kind: 'bytes' as const, data: artifact.content },
    }));
  const sha256ByPath = new Map<string, string>();
  const bytesByPath = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.source.kind !== 'bytes') continue;
    const buffer = bytesOf(artifact.source.data);
    sha256ByPath.set(artifact.path, createHash('sha256').update(buffer).digest('hex'));
    bytesByPath.set(artifact.path, buffer.length);
  }
  return { artifacts, sha256ByPath, bytesByPath };
}

function withArtifact(input: StreamedRawJournalInput, path: string, content: string): StreamedRawJournalInput {
  const artifacts = input.artifacts.map(artifact =>
    artifact.path === path
      ? { path, source: { kind: 'bytes' as const, data: content } }
      : artifact,
  );
  const sha256ByPath = new Map(input.sha256ByPath);
  const bytesByPath = new Map(input.bytesByPath);
  const buffer = Buffer.from(content, 'utf8');
  sha256ByPath.set(path, createHash('sha256').update(buffer).digest('hex'));
  bytesByPath.set(path, buffer.length);
  return { artifacts, sha256ByPath, bytesByPath };
}

/** 替换 catalog/channels.json（追加通道用于闭包反例）。 */
function withChannels(
  input: StreamedRawJournalInput,
  append: ReadonlyArray<{ id: string; kind: string; url?: string }>,
): StreamedRawJournalInput {
  const channelsArtifact = input.artifacts.find(
    artifact => artifact.path === 'catalog/channels.json',
  )!;
  if (channelsArtifact.source.kind !== 'bytes') throw new Error('channels artifact must be bytes');
  const raw = String(channelsArtifact.source.data);
  const parsed = JSON.parse(raw) as { channels: unknown[] };
  const mutated = JSON.stringify({ ...parsed, channels: [...parsed.channels, ...append] });
  return withArtifact(input, 'catalog/channels.json', `${mutated}\n`);
}

describe('streamValidateRawJournals（流式无界日志校验）', () => {
  it('正向：样例包原始日志流式校验零问题，且收集到行内稳定 ID', async () => {
    const input = await sampleStreamerInput();
    const result = await streamValidateRawJournals(input);
    expect(result.problems).toEqual([]);
    // 样例含 crypto / sse / downloads 行 ID（至少收集到一些）。
    expect(result.rawJournalIds.size).toBeGreaterThan(0);
  }, 60000);

  it('CDP journal seq 不严格递增 → RAW_JOURNAL_INVALID', async () => {
    const input = await sampleStreamerInput();
    const cdp = input.artifacts.find(artifact => artifact.path === 'raw/cdp/events.jsonl')!;
    if (cdp.source.kind !== 'bytes') throw new Error('cdp artifact must be bytes');
    const lines = String(cdp.source.data).trimEnd().split('\n');
    // 整体追加一份最后一行：seq 出现两次，第二次必然不严格递增。
    const mutated = [...lines, lines[lines.length - 1]].join('\n');
    const result = await streamValidateRawJournals(withArtifact(input, 'raw/cdp/events.jsonl', `${mutated}\n`));
    expect(result.problems.some(problem => problem.code === 'RAW_JOURNAL_INVALID')).toBe(true);
  }, 60000);

  it('CDP journal 为空但有 HTTP 事务 → RAW_JOURNAL_EMPTY', async () => {
    const input = await sampleStreamerInput();
    const result = await streamValidateRawJournals(
      withArtifact(input, 'raw/cdp/events.jsonl', ''),
    );
    expect(result.problems.some(problem => problem.code === 'RAW_JOURNAL_EMPTY')).toBe(true);
  }, 60000);

  it('NetLog schemaVersion 错误 / events 含非对象元素 → SCHEMA_VIOLATION', async () => {
    const input = await sampleStreamerInput();
    const brokenSchema = await streamValidateRawJournals(
      withArtifact(
        input,
        'raw/netlog/netlog.json',
        `${JSON.stringify({ schemaVersion: '1.0.0', captureMode: 'X', events: [{ type: 'A' }] })}\n`,
      ),
    );
    expect(brokenSchema.problems.some(problem => problem.code === 'SCHEMA_VIOLATION')).toBe(true);
    const brokenItems = await streamValidateRawJournals(
      withArtifact(
        input,
        'raw/netlog/netlog.json',
        `${JSON.stringify({ schemaVersion: '2.0.0', captureMode: 'X', events: ['not-object'] })}\n`,
      ),
    );
    expect(brokenItems.problems.some(problem => problem.code === 'SCHEMA_VIOLATION')).toBe(true);
  }, 60000);

  it('NetLog 事件为空但有 HTTP 事务 → RAW_JOURNAL_EMPTY', async () => {
    const input = await sampleStreamerInput();
    const result = await streamValidateRawJournals(
      withArtifact(
        input,
        'raw/netlog/netlog.json',
        `${JSON.stringify({ schemaVersion: '2.0.0', captureMode: 'X', events: [] })}\n`,
      ),
    );
    expect(result.problems.some(problem => problem.code === 'RAW_JOURNAL_EMPTY')).toBe(true);
  }, 60000);

  it('NetLog 非完整 JSON（尾部垃圾）→ PARSE_ERROR（严格单根对象校验）', async () => {
    const input = await sampleStreamerInput();
    const result = await streamValidateRawJournals(
      withArtifact(
        input,
        'raw/netlog/netlog.json',
        '{"schemaVersion":"2.0.0","captureMode":"X","events":[{}]} trailing-junk',
      ),
    );
    expect(result.problems.some(problem => problem.code === 'PARSE_ERROR')).toBe(true);
  }, 60000);

  it('NetLog 第二个根对象 → PARSE_ERROR', async () => {
    const input = await sampleStreamerInput();
    const result = await streamValidateRawJournals(
      withArtifact(
        input,
        'raw/netlog/netlog.json',
        '{"schemaVersion":"2.0.0","captureMode":"X","events":[]} {"a":1}',
      ),
    );
    expect(result.problems.some(problem => problem.code === 'PARSE_ERROR')).toBe(true);
  }, 60000);

  it('问题列表有上限（超过 200 项截断并标记），不会无限驻留', async () => {
    const input = await sampleStreamerInput();
    // 300 行 `{}` 均违反 http-transaction schema（required 字段缺失），
    // 每行产生一个 SCHEMA_VIOLATION；上限与截断标记必须生效。
    const rows = `${Array.from({ length: 300 }, () => '{}').join('\n')}\n`;
    const result = await streamValidateRawJournals(
      withArtifact(input, 'raw/http/transactions.jsonl', rows),
    );
    expect(result.problems.length).toBeLessThanOrEqual(201);
    expect(result.problems.some(problem => problem.code === 'PROBLEM_LIST_TRUNCATED')).toBe(true);
  }, 60000);

  it('WS 帧索引 payloadOffset 篡改 → FRAME_OFFSET_MISMATCH', async () => {
    const input = await sampleStreamerInput();
    const frames = input.artifacts.find(
      artifact => artifact.path === 'raw/websocket/ws-0001/frames.index.jsonl',
    )!;
    if (frames.source.kind !== 'bytes') throw new Error('frames artifact must be bytes');
    const lines = String(frames.source.data).trimEnd().split('\n');
    // 篡改第二帧的 payloadOffset。
    const mutated = lines.map((line, index) =>
      index === 1 ? line.replace(/"payloadOffset":(\d+)/, '"payloadOffset":999999') : line,
    );
    expect(mutated).not.toEqual(lines);
    const result = await streamValidateRawJournals(
      withArtifact(input, frames.path, `${mutated.join('\n')}\n`),
    );
    expect(result.problems.some(problem => problem.code === 'FRAME_OFFSET_MISMATCH')).toBe(true);
  }, 60000);

  it('transactions 正文引用缺失 → DANGLING_BODY_REF', async () => {
    const input = await sampleStreamerInput();
    const rows = input.artifacts.find(
      artifact => artifact.path === 'raw/http/transactions.jsonl',
    )!;
    if (rows.source.kind !== 'bytes') throw new Error('transactions artifact must be bytes');
    const text = String(rows.source.data).replace(
      /"bodyRef":"[^"]+"|"path":"raw\/http\/bodies\/[^"]+"/,
      '"path":"raw/http/bodies/missing-body"',
    );
    const result = await streamValidateRawJournals(
      withArtifact(input, rows.path, text),
    );
    expect(result.problems.some(problem => problem.code === 'DANGLING_BODY_REF')).toBe(true);
  }, 60000);

  it('WebRTC 通道无对应事件行 → CHANNEL_EVENT_MISSING', async () => {
    const input = await sampleStreamerInput();
    const webrtc = input.artifacts.find(
      artifact => artifact.path === 'raw/realtime/webrtc.jsonl',
    )!;
    const result = await streamValidateRawJournals(
      withChannels(withArtifact(input, webrtc.path, ''), [{ id: 'webrtc-0001', kind: 'webrtc' }]),
    );
    expect(result.problems.some(problem => problem.code === 'CHANNEL_EVENT_MISSING')).toBe(true);
  }, 60000);
});
