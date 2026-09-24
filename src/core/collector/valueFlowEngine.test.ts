/**
 * valueFlowEngine 反例测试（规范 §8.6 / §16）。
 *
 * 只记有字节级观察背书的边：cookie 传播链（Set-Cookie → storage → 后续
 * 请求 / WS 握手 Cookie 头）、storage 值链（响应正文 ⊇ storage 值 →
 * storage 节点 → 后续请求 / WS 握手头与查询参数，值逐字节相同）、
 * crypto 输出（原始字节 / hex / base64 编码形态）⊆ 请求正文、
 * crypto 输入 ⊆ 先前响应正文、WS 握手查询参数值 ⊆ 先前响应正文。
 * 字节不匹配 / 时间倒序 / 过短值 → 零边（空图是诚实形态）。
 */

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { scanStreamForNeedles } from './chunkedNeedleScan';
import type {
  PackV2BodyRef,
  PackV2ChannelRow,
  PackV2CryptoCallRow,
  PackV2HttpTiming,
  PackV2HttpTransactionRow,
  PackV2TargetRow,
} from '../capture-pack-v2/types';
import {
  deriveRelations,
  deriveValueFlow,
  type ValueFlowBodyReader,
  type ValueFlowFacts,
  type ValueFlowWsChannelFact,
} from './valueFlowEngine';

function bodyRef(path: string, bytes: number): PackV2BodyRef {
  return { path, sha256: 'a'.repeat(64), bytes };
}

interface TxInput {
  id: string;
  startedAt: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: PackV2BodyRef;
  responseHeaders?: Record<string, string>;
  responseBody?: PackV2BodyRef;
  targetId?: string;
  timing?: PackV2HttpTiming | null;
}

function tx(input: TxInput): PackV2HttpTransactionRow {
  return {
    id: input.id,
    targetId: input.targetId ?? 'target-root',
    startedAt: input.startedAt,
    method: input.method ?? 'GET',
    url: `https://kvm.example.test/${input.id}`,
    resourceType: 'document',
    requestHeaders: input.requestHeaders ?? {},
    requestBody: input.requestBody,
    status: 200,
    responseHeaders: input.responseHeaders ?? {},
    responseBody: input.responseBody,
    timing: input.timing,
  };
}

interface CryptoInput {
  id: string;
  occurredAt: string;
  inputRef?: PackV2BodyRef;
  outputRef?: PackV2BodyRef;
}

function cryptoCall(input: CryptoInput): PackV2CryptoCallRow {
  return {
    id: input.id,
    occurredAt: input.occurredAt,
    targetId: 'target-root',
    kind: 'digest',
    algorithm: 'SHA-256',
    ...(input.inputRef ? { inputRef: input.inputRef } : {}),
    ...(input.outputRef ? { outputRef: input.outputRef } : {}),
  };
}

function wsChannel(input: Partial<ValueFlowWsChannelFact> & { channelId: string }): ValueFlowWsChannelFact {
  return {
    channelId: input.channelId,
    url: input.url ?? 'wss://kvm.example.test/ws',
    createdAt: input.createdAt ?? '2026-09-21T02:00:03.000Z',
    requestHeaders: input.requestHeaders ?? {},
    metadataPath: input.metadataPath ?? `raw/websocket/${input.channelId}/metadata.json`,
  };
}

/**
 * 逐份读的注入正文源：path → bytes。干草堆侧（响应/请求正文）必须走
 * 分块扫描原语（与生产同一路径）；readBody 只服务 needle 侧（crypto
 * 输入/输出）。chunkBytes 指定干草堆切块大小（默认整块），用于跨块
 * 边界反例；scanCalls/readCalls 记录调用路径供间谍断言。
 */
function readerOf(
  bodies: Record<string, Buffer>,
  options: { chunkBytes?: number } = {},
): ValueFlowBodyReader & { scanCalls: string[]; readCalls: string[] } {
  const chunkBytes = options.chunkBytes;
  const scanCalls: string[] = [];
  const readCalls: string[] = [];
  const sourceOf = (body: Buffer): Readable => {
    if (chunkBytes === undefined || body.byteLength <= chunkBytes) return Readable.from([body]);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < body.byteLength; offset += chunkBytes) {
      chunks.push(body.subarray(offset, Math.min(body.byteLength, offset + chunkBytes)));
    }
    return Readable.from(chunks);
  };
  return {
    scanCalls,
    readCalls,
    readBody(ref) {
      readCalls.push(ref.path);
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(bodies, ref.path) ? bodies[ref.path] : null,
      );
    },
    scanBody(ref, needles) {
      scanCalls.push(ref.path);
      const body = bodies[ref.path];
      if (body === undefined) return Promise.resolve(null);
      if (needles.length === 0) return Promise.resolve(new Set<Buffer>());
      return scanStreamForNeedles(sourceOf(body), needles);
    },
  };
}

function factsOf(parts: Partial<ValueFlowFacts>): ValueFlowFacts {
  return {
    transactions: parts.transactions ?? [],
    cryptoRows: parts.cryptoRows ?? [],
    wsChannels: parts.wsChannels ?? [],
    storageCookies: parts.storageCookies ?? [],
    storageValues: parts.storageValues ?? [],
    storageCapturedAt: parts.storageCapturedAt ?? '2026-09-21T02:00:04.000Z',
  };
}

const T0 = '2026-09-21T02:00:00.000Z';
const T1 = '2026-09-21T02:00:01.000Z';
const T2 = '2026-09-21T02:00:02.000Z';
const T3 = '2026-09-21T02:00:03.000Z';

describe('deriveValueFlow（字节级观察背书的值传播）', () => {
  it('Set-Cookie → storage cookie → 后续请求 Cookie 头必须传播成边', async () => {
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0001', 24),
            responseHeaders: { 'set-cookie': 'session=abc123; Path=/' },
          }),
          tx({
            id: 'http-0002',
            startedAt: T2,
            requestHeaders: { cookie: 'session=abc123' },
          }),
        ],
        storageCookies: [{ name: 'session', value: 'abc123' }],
      }),
      readerOf({}),
    );

    const edges = result.valueFlow.edges;
    expect(edges).toHaveLength(2);
    const propagated = edges.filter(edge => edge.relation === 'propagated-to');
    expect(propagated).toHaveLength(2);
    // 后续请求 Cookie 头的替换值必须在 replay 时可替换
    const headerEdge = propagated.find(edge => {
      const node = result.valueFlow.nodes.find(candidate => candidate.id === edge.to);
      return node?.kind === 'header';
    });
    expect(headerEdge?.replaySubstitution).toBe(true);
    const kinds = result.valueFlow.nodes.map(node => node.kind).sort();
    expect(kinds).toEqual(['cookie', 'header', 'http-response']);
  });

  it('storage 缺该 cookie 时退化为 Set-Cookie → 请求 Cookie 头直连边', async () => {
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0001', 24),
            responseHeaders: { 'set-cookie': 'session=abc123' },
          }),
          tx({
            id: 'http-0002',
            startedAt: T2,
            requestHeaders: { cookie: 'session=abc123' },
          }),
        ],
        storageCookies: [],
      }),
      readerOf({}),
    );

    expect(result.valueFlow.edges).toHaveLength(1);
    expect(result.valueFlow.edges[0]?.relation).toBe('propagated-to');
    expect(result.valueFlow.edges[0]?.replaySubstitution).toBe(true);
  });

  it('WS 握手 Cookie 头也是 cookie 传播的目的端', async () => {
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0001', 24),
            responseHeaders: { 'set-cookie': 'session=abc123' },
          }),
        ],
        storageCookies: [{ name: 'session', value: 'abc123' }],
        wsChannels: [
          wsChannel({
            channelId: 'ws-0001',
            createdAt: T3,
            requestHeaders: { cookie: 'session=abc123' },
          }),
        ],
      }),
      readerOf({}),
    );

    const wsHeaderNode = result.valueFlow.nodes.find(node => node.kind === 'header');
    expect(wsHeaderNode?.evidencePath).toBe('raw/websocket/ws-0001/metadata.json');
    expect(wsHeaderNode?.evidenceId).toBe('ws-0001');
    const wsEdge = result.valueFlow.edges.find(edge => edge.to === wsHeaderNode?.id);
    expect(wsEdge?.relation).toBe('propagated-to');
    expect(wsEdge?.replaySubstitution).toBe(true);
  });

  it('cookie 同名不同值 / 请求先于签发 → 零边', async () => {
    const mismatch = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T1,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0001', 24),
            responseHeaders: { 'set-cookie': 'session=abc123' },
          }),
          tx({ id: 'http-0002', startedAt: T2, requestHeaders: { cookie: 'session=other' } }),
        ],
      }),
      readerOf({}),
    );
    expect(mismatch.valueFlow.edges).toHaveLength(0);
    expect(mismatch.valueFlow.nodes).toHaveLength(0);

    const reversed = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T1,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0001', 24),
            responseHeaders: { 'set-cookie': 'session=abc123' },
          }),
          // Cookie 携带早于 Set-Cookie 签发（时间倒序）：不是传播
          tx({ id: 'http-0002', startedAt: T0, requestHeaders: { cookie: 'session=abc123' } }),
        ],
      }),
      readerOf({}),
    );
    expect(reversed.valueFlow.edges).toHaveLength(0);
  });

  it('digest 输出（hex 编码形态）出现在登录请求正文 → used-in 与 derived-from 边', async () => {
    const digest = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0002',
            startedAt: T2,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0002', 48),
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T1,
            outputRef: bodyRef('raw/runtime/bodies/0001', digest.byteLength),
          }),
        ],
      }),
      readerOf({
        'raw/runtime/bodies/0001': digest,
        'raw/http/bodies/0002': Buffer.from(`credential=${digest.toString('hex')}`, 'utf8'),
      }),
    );

    const relations = result.valueFlow.edges.map(edge => edge.relation).sort();
    expect(relations).toContain('used-in');
    expect(relations).toContain('derived-from');
    const kinds = result.valueFlow.nodes.map(node => node.kind).sort();
    expect(kinds).toEqual(['crypto-output', 'http-request-body']);
    for (const edge of result.valueFlow.edges) {
      expect(edge.replaySubstitution).toBe(true);
    }
  });

  it('digest 输出与全部请求正文都不匹配 → 零边（空图是诚实形态）', async () => {
    const digest = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0002',
            startedAt: T2,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0002', 12),
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T1,
            outputRef: bodyRef('raw/runtime/bodies/0001', digest.byteLength),
          }),
        ],
      }),
      readerOf({
        'raw/runtime/bodies/0001': digest,
        'raw/http/bodies/0002': Buffer.from('credential=other', 'utf8'),
      }),
    );

    expect(result.valueFlow.edges).toHaveLength(0);
    expect(result.valueFlow.nodes).toHaveLength(0);
  });

  it('crypto 输入 ⊆ 先前响应正文 → derived-from 边', async () => {
    const nonce = Buffer.from('nonce-value-0123456789', 'utf8');
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T1,
            inputRef: bodyRef('raw/runtime/bodies/0001', nonce.byteLength),
            outputRef: bodyRef('raw/runtime/bodies/0002', 32),
          }),
        ],
      }),
      readerOf({
        'raw/http/bodies/0001': Buffer.from(`<input value="${nonce.toString('utf8')}">`, 'utf8'),
        'raw/runtime/bodies/0001': nonce,
        'raw/runtime/bodies/0002': Buffer.alloc(32, 7),
      }),
    );

    const derivedFrom = result.valueFlow.edges.filter(edge => edge.relation === 'derived-from');
    // 输入来源边（响应 → crypto 输出）；输出未出现在任何请求正文，无 used-in 边
    expect(derivedFrom).toHaveLength(1);
    const responseNode = result.valueFlow.nodes.find(node => node.kind === 'http-response');
    const outputNode = result.valueFlow.nodes.find(node => node.kind === 'crypto-output');
    expect(derivedFrom[0]?.from).toBe(responseNode?.id);
    expect(derivedFrom[0]?.to).toBe(outputNode?.id);
  });

  // crypto 调用发生在请求开始与响应到达之间
  // （startedAt + max(receiveMs, sendMs + waitMs) 窗口内）时，页面尚不可能
  // 读到该响应正文，字节包含不构成「响应 → crypto 输入」的时间证据，不得成边。
  it('crypto 输入 ⊆ 响应正文但调用早于响应到达 → 零边', async () => {
    const nonce = Buffer.from('nonce-value-0123456789', 'utf8');
    const mkFacts = (cryptoAt: string) =>
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
            // CDP 真实形状：receiveMs 是 requestTime→响应头到达的累计偏移
            // （2600ms ≥ sendMs+waitMs=2500ms），响应头最早 T0+2.6s 到达
            timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 },
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: cryptoAt,
            inputRef: bodyRef('raw/runtime/bodies/0001', nonce.byteLength),
            outputRef: bodyRef('raw/runtime/bodies/0002', 32),
          }),
        ],
      });
    const reader = readerOf({
      'raw/http/bodies/0001': Buffer.from(`<input value="${nonce.toString('utf8')}">`, 'utf8'),
      'raw/runtime/bodies/0001': nonce,
      'raw/runtime/bodies/0002': Buffer.alloc(32, 7),
    });

    // T1 晚于请求开始但早于响应到达（T0+2.6s）：不是值传播证据
    const before = await deriveValueFlow(mkFacts(T1), reader);
    expect(before.valueFlow.edges).toHaveLength(0);
    expect(before.valueFlow.nodes).toHaveLength(0);

    // T3（T0+3s）晚于响应到达：边成立
    const after = await deriveValueFlow(mkFacts(T3), reader);
    expect(after.valueFlow.edges.some(edge => edge.relation === 'derived-from')).toBe(true);
  });

  // 响应正文的存在时刻是响应到达时刻（startedAt +
  // max(receiveMs, sendMs+waitMs)），不是请求开始时刻——关系行的
  // occurredAt 不得把「响应正文 → 消费者」边记成在请求开始时就已发生。
  it('响应正文 → crypto 输入的 derived-from 边：关系行 occurredAt 是响应到达时刻，不是请求开始', async () => {
    const nonce = Buffer.from('nonce-value-0123456789', 'utf8');
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
            timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 },
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T3,
            inputRef: bodyRef('raw/runtime/bodies/0001', nonce.byteLength),
            outputRef: bodyRef('raw/runtime/bodies/0002', 32),
          }),
        ],
      }),
      readerOf({
        'raw/http/bodies/0001': Buffer.from(`<input value="${nonce.toString('utf8')}">`, 'utf8'),
        'raw/runtime/bodies/0001': nonce,
        'raw/runtime/bodies/0002': Buffer.alloc(32, 7),
      }),
    );

    const derivedFromEdge = result.valueFlow.edges.find(edge => edge.relation === 'derived-from');
    expect(derivedFromEdge).toBeDefined();
    const relationRow = result.relations.find(row => row.from === derivedFromEdge?.from);
    // 响应头最早 T0+2.6s 到达：边的发生时刻是到达时刻，不是请求开始 T0
    expect(relationRow?.occurredAt).toBe('2026-09-21T02:00:02.600Z');
  });

  // sendMs+waitMs 漏掉建连段（sendEnd 前的连接建立），
  // 只有 receiveMs（累计偏移）覆盖完整 requestTime→响应头窗口。
  // 消费发生在 sendMs+waitMs 之后、receiveMs 之前时，页面仍不可能读到正文。
  it('crypto 调用晚于 startedAt+sendMs+waitMs 但早于 startedAt+receiveMs → 零边', async () => {
    const nonce = Buffer.from('nonce-value-0123456789', 'utf8');
    const mkFacts = (cryptoAt: string) =>
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
            timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 },
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: cryptoAt,
            inputRef: bodyRef('raw/runtime/bodies/0001', nonce.byteLength),
            outputRef: bodyRef('raw/runtime/bodies/0002', 32),
          }),
        ],
      });
    const reader = readerOf({
      'raw/http/bodies/0001': Buffer.from(`<input value="${nonce.toString('utf8')}">`, 'utf8'),
      'raw/runtime/bodies/0001': nonce,
      'raw/runtime/bodies/0002': Buffer.alloc(32, 7),
    });

    // T0+2550ms：晚于 sendMs+waitMs（2500ms）但早于响应头到达（2600ms）
    const before = await deriveValueFlow(mkFacts('2026-09-21T02:00:02.550Z'), reader);
    expect(before.valueFlow.edges).toHaveLength(0);
    expect(before.valueFlow.nodes).toHaveLength(0);

    // T0+2700ms：晚于响应头到达：边成立
    const after = await deriveValueFlow(mkFacts('2026-09-21T02:00:02.700Z'), reader);
    expect(after.valueFlow.edges.some(edge => edge.relation === 'derived-from')).toBe(true);
  });

  // WS 握手发生在请求开始与响应到达
  // 之间时，查询参数值不构成「响应正文 → 握手参数」的传播证据。
  it('WS 握手查询参数值 ⊆ 响应正文但通道建于响应到达之前 → 零边', async () => {
    const token = 'viewer-token-0123456789';
    const mkFacts = (createdAt: string) =>
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
            timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 },
          }),
        ],
        wsChannels: [
          wsChannel({
            channelId: 'ws-0001',
            url: `wss://kvm.example.test/ws?t=${token}`,
            createdAt,
          }),
        ],
      });
    const reader = readerOf({
      'raw/http/bodies/0001': Buffer.from(`{"token":"${token}"}`, 'utf8'),
    });

    const before = await deriveValueFlow(mkFacts(T1), reader);
    expect(before.valueFlow.edges).toHaveLength(0);
    expect(before.valueFlow.nodes).toHaveLength(0);

    const after = await deriveValueFlow(mkFacts(T3), reader);
    expect(after.valueFlow.edges).toHaveLength(1);
    expect(after.valueFlow.edges[0]?.relation).toBe('propagated-to');
  });

  // Set-Cookie 签发事务的响应未到达时，
  // 页面尚不可能持有该 cookie，更早开始的携带请求不构成传播证据。
  it('Set-Cookie 响应未到达时携带同 cookie 的请求 → 零边', async () => {
    const mkFacts = (carrierAt: string) =>
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0001', 24),
            responseHeaders: { 'set-cookie': 'session=abc123' },
            timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 },
          }),
          tx({
            id: 'http-0002',
            startedAt: carrierAt,
            requestHeaders: { cookie: 'session=abc123' },
          }),
        ],
        storageCookies: [],
      });
    const reader = readerOf({});

    const before = await deriveValueFlow(mkFacts(T1), reader);
    expect(before.valueFlow.edges).toHaveLength(0);
    expect(before.valueFlow.nodes).toHaveLength(0);

    const after = await deriveValueFlow(mkFacts(T3), reader);
    expect(after.valueFlow.edges).toHaveLength(1);
    expect(after.valueFlow.edges[0]?.relation).toBe('propagated-to');
  });

  it('WS 握手查询参数值 ⊆ 先前响应正文 → propagated-to 边', async () => {
    const token = 'viewer-token-0123456789';
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
          }),
        ],
        wsChannels: [
          wsChannel({
            channelId: 'ws-0001',
            url: `wss://kvm.example.test/ws?t=${token}`,
            createdAt: T3,
          }),
        ],
      }),
      readerOf({
        'raw/http/bodies/0001': Buffer.from(`{"token":"${token}"}`, 'utf8'),
      }),
    );

    expect(result.valueFlow.edges).toHaveLength(1);
    const edge = result.valueFlow.edges[0]!;
    expect(edge.relation).toBe('propagated-to');
    expect(edge.replaySubstitution).toBe(true);
    const paramNode = result.valueFlow.nodes.find(node => node.kind === 'url-param');
    const responseNode = result.valueFlow.nodes.find(node => node.kind === 'http-response');
    expect(edge.from).toBe(responseNode?.id);
    expect(edge.to).toBe(paramNode?.id);
    expect(paramNode?.evidenceId).toBe('ws-0001');
  });

  it('查询参数值与全部响应正文不匹配 → 零边；过短包含值不做匹配', async () => {
    const noMatch = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 16),
          }),
        ],
        wsChannels: [
          wsChannel({ channelId: 'ws-0001', url: 'wss://kvm.example.test/ws?t=not-in-anywhere', createdAt: T3 }),
        ],
      }),
      readerOf({ 'raw/http/bodies/0001': Buffer.from('{"other":"value"}', 'utf8') }),
    );
    expect(noMatch.valueFlow.edges).toHaveLength(0);

    // 短值（< 8 字节）在任何正文里都能子串命中，不构成值传播证据
    const tooShort = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 16),
          }),
        ],
        wsChannels: [wsChannel({ channelId: 'ws-0001', url: 'wss://kvm.example.test/ws?t=abc', createdAt: T3 })],
      }),
      readerOf({ 'raw/http/bodies/0001': Buffer.from('xxabcxx', 'utf8') }),
    );
    expect(tooShort.valueFlow.edges).toHaveLength(0);
  });

  it('crypto 输出在请求正文中但时间倒序（请求先于摘要）→ 零边', async () => {
    const digest = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0002',
            startedAt: T0,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0002', 48),
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T2,
            outputRef: bodyRef('raw/runtime/bodies/0001', digest.byteLength),
          }),
        ],
      }),
      readerOf({
        'raw/runtime/bodies/0001': digest,
        'raw/http/bodies/0002': Buffer.from(`credential=${digest.toString('hex')}`, 'utf8'),
      }),
    );

    expect(result.valueFlow.edges).toHaveLength(0);
  });

  it('正文缺失（读取返回 null）不产生边，也不抛出', async () => {
    const digest = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0002',
            startedAt: T2,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/missing', 48),
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T1,
            outputRef: bodyRef('raw/runtime/bodies/0001', digest.byteLength),
          }),
        ],
      }),
      readerOf({ 'raw/runtime/bodies/0001': digest }),
    );

    expect(result.valueFlow.edges).toHaveLength(0);
  });

  // ---- storage 值链（sessionStorage / localStorage，规范 §8.6）----

  it('响应正文 ⊇ storage 值 → storage 节点 → 后续请求头（逐字节相同）成两段传播边', async () => {
    const csrf = 'csrf-token-0123456789';
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
            timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 },
          }),
          tx({
            id: 'http-0002',
            startedAt: T3,
            requestHeaders: { 'x-csrf': csrf },
          }),
        ],
        storageValues: [{ key: 'csrf', value: csrf }],
      }),
      readerOf({ 'raw/http/bodies/0001': Buffer.from(`{"csrfToken":"${csrf}"}`, 'utf8') }),
    );

    expect(result.valueFlow.edges).toHaveLength(2);
    const storageNode = result.valueFlow.nodes.find(node => node.kind === 'storage');
    const headerNode = result.valueFlow.nodes.find(node => node.kind === 'header');
    const responseNode = result.valueFlow.nodes.find(node => node.kind === 'http-response');
    expect(storageNode?.evidencePath).toBe('raw/browser/storage.json');
    expect(headerNode?.evidenceId).toBe('http-0002');
    for (const edge of result.valueFlow.edges) {
      expect(edge.relation).toBe('propagated-to');
      expect(edge.replaySubstitution).toBe(true);
    }
    // 响应正文 → storage → 请求头 两段边方向正确
    const toStorage = result.valueFlow.edges.find(edge => edge.to === storageNode?.id);
    expect(toStorage?.from).toBe(responseNode?.id);
    const toHeader = result.valueFlow.edges.find(edge => edge.to === headerNode?.id);
    expect(toHeader?.from).toBe(storageNode?.id);
  });

  it('WS 握手头逐字节等于 storage 值 → storage → WS 头传播边（Cookie 头除外）', async () => {
    const token = 'viewer-token-0123456789';
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
          }),
        ],
        wsChannels: [
          wsChannel({
            channelId: 'ws-0001',
            createdAt: T3,
            requestHeaders: { cookie: `session=${token}`, 'x-viewer': token },
          }),
        ],
        storageValues: [{ key: 'viewerToken', value: token }],
      }),
      readerOf({ 'raw/http/bodies/0001': Buffer.from(`{"token":"${token}"}`, 'utf8') }),
    );

    const headerNodes = result.valueFlow.nodes.filter(node => node.kind === 'header');
    // Cookie 头由 cookie 链负责，storage 值链只认 x-viewer 头
    expect(headerNodes).toHaveLength(1);
    expect(headerNodes[0]?.evidenceId).toBe('ws-0001');
    expect(headerNodes[0]?.name).toContain('x-viewer');
    const toHeader = result.valueFlow.edges.find(edge => edge.to === headerNodes[0]?.id);
    expect(toHeader?.replaySubstitution).toBe(true);
    const storageNode = result.valueFlow.nodes.find(node => node.kind === 'storage');
    expect(toHeader?.from).toBe(storageNode?.id);
  });

  it('WS 握手查询参数逐字节等于 storage 值 → storage → 查询参数中继边', async () => {
    const token = 'viewer-token-0123456789';
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
          }),
        ],
        wsChannels: [
          wsChannel({
            channelId: 'ws-0001',
            url: `wss://kvm.example.test/ws?t=${token}`,
            createdAt: T3,
          }),
        ],
        storageValues: [{ key: 'viewerToken', value: token }],
      }),
      readerOf({ 'raw/http/bodies/0001': Buffer.from(`{"token":"${token}"}`, 'utf8') }),
    );

    const paramNode = result.valueFlow.nodes.find(node => node.kind === 'url-param');
    const storageNode = result.valueFlow.nodes.find(node => node.kind === 'storage');
    expect(paramNode).toBeDefined();
    expect(storageNode).toBeDefined();
    // 响应正文 → url-param 直连边 + 响应正文 → storage → url-param 中继边都在
    const toParam = result.valueFlow.edges.filter(edge => edge.to === paramNode?.id);
    expect(toParam.map(edge => edge.from)).toContain(storageNode?.id);
    for (const edge of toParam) {
      expect(edge.replaySubstitution).toBe(true);
    }
  });

  it('storage 值链反例：头值不匹配 / 头先于来源响应到达 / 过短值 / 无来源响应 → 零边或无中继边', async () => {
    const csrf = 'csrf-token-0123456789';
    const mkFacts = (headerValueAt: string, header: string) =>
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 64),
            timing: { sendMs: 500, waitMs: 2000, receiveMs: 2600 },
          }),
          tx({ id: 'http-0002', startedAt: headerValueAt, requestHeaders: { 'x-csrf': header } }),
        ],
        storageValues: [{ key: 'csrf', value: csrf }],
      });
    const reader = readerOf({ 'raw/http/bodies/0001': Buffer.from(`{"csrfToken":"${csrf}"}`, 'utf8') });

    // 头值与 storage 值逐字节不同：storage → 头边不成（只剩响应 → storage 一段）
    const mismatch = await deriveValueFlow(mkFacts(T3, 'other-token-0123456789'), reader);
    expect(mismatch.valueFlow.edges).toHaveLength(1);
    expect(mismatch.valueFlow.nodes.some(node => node.kind === 'header')).toBe(false);

    // 头发送早于来源响应到达（T0+2.6s）：时间倒序，中继边不成
    const reversed = await deriveValueFlow(mkFacts(T1, csrf), reader);
    expect(reversed.valueFlow.edges).toHaveLength(1);
    expect(reversed.valueFlow.nodes.some(node => node.kind === 'header')).toBe(false);

    // 短值（< 8 字节）不构成传播证据：storage 节点都不建
    const tooShort = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 8),
          }),
          tx({ id: 'http-0002', startedAt: T3, requestHeaders: { 'x-csrf': 'abc123' } }),
        ],
        storageValues: [{ key: 'csrf', value: 'abc123' }],
      }),
      readerOf({ 'raw/http/bodies/0001': Buffer.from('{"csrfToken":"abc123"}', 'utf8') }),
    );
    expect(tooShort.valueFlow.edges).toHaveLength(0);
    expect(tooShort.valueFlow.nodes).toHaveLength(0);

    // 值不在任何响应正文：无来源响应，storage 节点无出边（空图是诚实形态）
    const noSource = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', 16),
          }),
          tx({ id: 'http-0002', startedAt: T3, requestHeaders: { 'x-csrf': csrf } }),
        ],
        storageValues: [{ key: 'csrf', value: csrf }],
      }),
      readerOf({ 'raw/http/bodies/0001': Buffer.from('{"other":"value"}', 'utf8') }),
    );
    expect(noSource.valueFlow.edges).toHaveLength(0);
    expect(noSource.valueFlow.nodes).toHaveLength(0);
  });

  // 刀 1 反例：干草堆侧必须分块扫描——needle 跨块边界也要命中，
  // 且正文读取不得走 needle 侧的整读通道。
  it('反例：needle 跨块边界必须命中（4 字节分块扫描响应正文）', async () => {
    const nonce = Buffer.from('nonce-value-0123456789', 'utf8');
    const response = Buffer.from(`prefix..${nonce.toString('utf8')}..suffix`, 'utf8');
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', response.byteLength),
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T1,
            inputRef: bodyRef('raw/runtime/bodies/0001', nonce.byteLength),
            outputRef: bodyRef('raw/runtime/bodies/0002', 32),
          }),
        ],
      }),
      readerOf(
        {
          'raw/http/bodies/0001': response,
          'raw/runtime/bodies/0001': nonce,
          'raw/runtime/bodies/0002': Buffer.alloc(32, 7),
        },
        { chunkBytes: 4 },
      ),
    );
    const derivedFrom = result.valueFlow.edges.filter(edge => edge.relation === 'derived-from');
    expect(derivedFrom).toHaveLength(1);
    const responseNode = result.valueFlow.nodes.find(node => node.kind === 'http-response');
    const outputNode = result.valueFlow.nodes.find(node => node.kind === 'crypto-output');
    expect(derivedFrom[0]?.from).toBe(responseNode?.id);
    expect(derivedFrom[0]?.to).toBe(outputNode?.id);
  });

  it('反例：reader 间谍——干草堆正文只走 scanBody，readBody 只服务 crypto needle 侧', async () => {
    const nonce = Buffer.from('nonce-value-0123456789', 'utf8');
    const output = Buffer.alloc(32, 7);
    const request = Buffer.from(`{"token":"${output.toString('hex')}"}`, 'utf8');
    const response = Buffer.from(`<input value="${nonce.toString('utf8')}">`, 'utf8');
    const reader = readerOf({
      'raw/http/bodies/0001': response,
      'raw/http/bodies/0002': request,
      'raw/runtime/bodies/0001': nonce,
      'raw/runtime/bodies/0002': output,
    });
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', response.byteLength),
          }),
          tx({
            id: 'http-0002',
            startedAt: T2,
            method: 'POST',
            requestBody: bodyRef('raw/http/bodies/0002', request.byteLength),
          }),
        ],
        cryptoRows: [
          cryptoCall({
            id: 'crypto-0001',
            occurredAt: T1,
            inputRef: bodyRef('raw/runtime/bodies/0001', nonce.byteLength),
            outputRef: bodyRef('raw/runtime/bodies/0002', output.byteLength),
          }),
        ],
      }),
      reader,
    );
    // 两侧都要有边（crypto 输入 ⊆ 响应正文；输出 hex ⊆ 请求正文）
    expect(result.valueFlow.edges.length).toBeGreaterThan(0);
    expect(reader.readCalls).toEqual([
      'raw/runtime/bodies/0001',
      'raw/runtime/bodies/0002',
    ]);
    expect(reader.scanCalls).toEqual(['raw/http/bodies/0001', 'raw/http/bodies/0002']);
  });

  it('反例：needle 长于正文总字节数（诚实预筛）与无候选 needle 时不得读取正文', async () => {
    const nonce = Buffer.from('nonce-value-0123456789', 'utf8');
    const shortResponse = Buffer.from('short', 'utf8');
    // needle 长于响应正文字节数：scanBody 预筛跳过读取（由 reader 实现层
    // 保证；此处引擎侧断言无候选 needle 时不发起扫描）
    const reader = readerOf({
      'raw/http/bodies/0001': shortResponse,
      'raw/runtime/bodies/0001': nonce,
    });
    const result = await deriveValueFlow(
      factsOf({
        transactions: [
          // 无 crypto / WS 参数 / storage 值候选：不得扫描任何正文
          tx({
            id: 'http-0001',
            startedAt: T0,
            responseBody: bodyRef('raw/http/bodies/0001', shortResponse.byteLength),
          }),
        ],
      }),
      reader,
    );
    expect(result.valueFlow.edges).toHaveLength(0);
    expect(reader.scanCalls).toEqual([]);
    expect(reader.readCalls).toEqual([]);
  });
});

describe('deriveRelations（catalog/relations.jsonl 结构关系）', () => {
  const targets: PackV2TargetRow[] = [
    { id: 'target-root', type: 'page', attached: true, url: 'https://kvm.example.test/', attachedAt: T0 },
    {
      id: 'target-popup-1',
      type: 'popup',
      attached: true,
      url: 'https://kvm.example.test/viewer',
      openerTargetId: 'target-root',
      attachedAt: T2,
    },
  ];
  const transactions = [
    tx({ id: 'http-0001', startedAt: T0, method: 'POST', targetId: 'target-root' }),
    tx({ id: 'http-0002', startedAt: T2, targetId: 'target-popup-1' }),
  ];
  const channels: PackV2ChannelRow[] = [
    {
      id: 'ws-0001',
      kind: 'websocket',
      url: 'wss://kvm.example.test/ws',
      targetId: 'target-popup-1',
      createdAt: T3,
      closedAt: null,
      frameCounts: { up: 1, down: 2 },
      payloadPath: 'raw/websocket/ws-0001/frames.bin',
    },
  ];

  it('initiated / created / opened / value-flow 四类关系行齐全且引用稳定 ID', () => {
    const valueFlowEdges = [
      {
        from: 'value-0001',
        to: 'value-0002',
        relation: 'propagated-to' as const,
        evidencePath: 'raw/browser/storage.json',
        occurredAt: T2,
      },
    ];
    const rows = deriveRelations({ transactions, targets, channels }, valueFlowEdges);

    const initiated = rows.filter(row => row.relation === 'initiated');
    expect(initiated).toHaveLength(2);
    expect(initiated[0]).toEqual({
      from: 'target-root',
      to: 'http-0001',
      relation: 'initiated',
      occurredAt: T0,
      evidencePath: 'raw/http/transactions.jsonl',
    });

    const created = rows.filter(row => row.relation === 'created');
    expect(created).toEqual([
      {
        from: 'target-root',
        to: 'target-popup-1',
        relation: 'created',
        occurredAt: T2,
        evidencePath: 'catalog/targets.json',
      },
    ]);

    const opened = rows.filter(row => row.relation === 'opened');
    expect(opened).toEqual([
      {
        from: 'target-popup-1',
        to: 'ws-0001',
        relation: 'opened',
        occurredAt: T3,
        evidencePath: 'catalog/channels.json',
      },
    ]);

    const valueFlow = rows.filter(row => row.relation === 'value-flow');
    expect(valueFlow).toEqual([
      {
        from: 'value-0001',
        to: 'value-0002',
        relation: 'value-flow',
        occurredAt: T2,
        evidencePath: 'ai/value-flow.json',
      },
    ]);
  });

  it('无 opener 血缘的 target 不产生 created 行；空事实 → 空数组', () => {
    const loneTargets: PackV2TargetRow[] = [
      { id: 'target-root', type: 'page', attached: true, url: null },
    ];
    const rows = deriveRelations(
      { transactions: [], targets: loneTargets, channels: [] },
      [],
    );
    expect(rows).toEqual([]);
  });
});
