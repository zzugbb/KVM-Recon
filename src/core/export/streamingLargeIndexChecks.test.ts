import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { streamValidateLargeIndexes } from './streamingLargeIndexChecks';
import { streamValidateRawJournals } from './streamingRawJournalChecks';
import { PACK_V2_CHECKSUMS_PATH, type ZipArtifact } from './exportPackV2Zip';
import {
  isLargeIndexPath,
  isRawJournalPath,
  validatePackV2Consistency,
  type PackV2ConsistencyProblem,
  type PackV2ConsistencyResult,
} from '../capture-pack-v2/packV2Consistency';
import type { PackV2ArtifactLike } from '../capture-pack-v2/packV2Consistency';
import { createSampleCapturePackV2 } from '../capture-pack-v2/createSampleCapturePackV2';

/**
 * 大索引文件流式校验通道（导出门禁）测试：
 * - 契约：样例包零问题，行数据与文件逐项相等；哈希背书 + 注入事实的
 *   委托模式与内存整读模式对同一包同判（跨文件闭包检查单一实现）。
 * - 反例：行 Schema 违反 / 坏行、value-flow 与 storage 结构违反（逐 token
 *   走查）、注入事实驱动的悬空引用闭包检查。
 * - Schema/走查钉住：走查硬编码的键集合必须与包内 Schema 副本声明一致。
 */

async function sampleArtifacts(): Promise<ZipArtifact[]> {
  const sample = await createSampleCapturePackV2();
  return sample.artifacts
    .filter(artifact => artifact.path !== PACK_V2_CHECKSUMS_PATH)
    .map(artifact => ({
      path: artifact.path,
      source: { kind: 'bytes' as const, data: artifact.content },
    }));
}

function bytesOf(artifact: ZipArtifact): Buffer {
  if (artifact.source.kind !== 'bytes') throw new Error('测试只使用 bytes 源');
  return typeof artifact.source.data === 'string'
    ? Buffer.from(artifact.source.data, 'utf8')
    : Buffer.from(artifact.source.data);
}

function textOf(artifacts: ReadonlyArray<ZipArtifact>, path: string): string {
  const artifact = artifacts.find(candidate => candidate.path === path);
  if (!artifact) throw new Error(`样例包缺少 ${path}`);
  return bytesOf(artifact).toString('utf8');
}

function withText(
  artifacts: ReadonlyArray<ZipArtifact>,
  path: string,
  content: string,
): ZipArtifact[] {
  return artifacts.map(artifact =>
    artifact.path === path
      ? { path, source: { kind: 'bytes' as const, data: content } }
      : artifact,
  );
}

/** 内存整读模式：全部工件带真实内容（raw journal 与大索引都整读）。 */
function fullContentArtifacts(artifacts: ReadonlyArray<ZipArtifact>): PackV2ArtifactLike[] {
  return artifacts.map(artifact => ({
    path: artifact.path,
    content: bytesOf(artifact),
  }));
}

/** 委托模式：raw journal 与大索引哈希背书（与导出器 buildConsistencyArtifact 同形）。 */
function stubbedArtifacts(artifacts: ReadonlyArray<ZipArtifact>): PackV2ArtifactLike[] {
  return artifacts.map(artifact => {
    const buffer = bytesOf(artifact);
    if (isRawJournalPath(artifact.path) || isLargeIndexPath(artifact.path)) {
      return {
        path: artifact.path,
        content: new Uint8Array(0),
        sha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.byteLength,
      };
    }
    return { path: artifact.path, content: buffer };
  });
}

/** 导出器同款接线：双流式通道 + 委托选项的内存一致性检查。 */
async function delegatedCheck(
  artifacts: ReadonlyArray<ZipArtifact>,
): Promise<{
  streamedLarge: Awaited<ReturnType<typeof streamValidateLargeIndexes>>;
  check: PackV2ConsistencyResult;
  problems: PackV2ConsistencyProblem[];
}> {
  const streamedLarge = await streamValidateLargeIndexes(artifacts);
  const sha256ByPath = new Map(
    artifacts.map(artifact => [artifact.path, createHash('sha256').update(bytesOf(artifact)).digest('hex')]),
  );
  const bytesByPath = new Map(artifacts.map(artifact => [artifact.path, bytesOf(artifact).byteLength]));
  const streamed = await streamValidateRawJournals({ artifacts, sha256ByPath, bytesByPath });
  const check = validatePackV2Consistency(stubbedArtifacts(artifacts), {
    requireChecksumFile: false,
    skipRawJournalContentChecks: true,
    rawJournalIds: streamed.rawJournalIds,
    skipLargeIndexContentChecks: true,
    largeIndexFacts: streamedLarge.facts,
  });
  return {
    streamedLarge,
    check,
    problems: [...streamedLarge.problems, ...streamed.problems, ...check.problems].map(
      (problem: { code: string; detail: string; path?: string }) => problem,
    ) as PackV2ConsistencyProblem[],
  };
}

describe('streamValidateLargeIndexes（大索引流式校验通道）', () => {
  it('契约：样例包零问题，行事实与文件逐项相等', async () => {
    const artifacts = await sampleArtifacts();
    const result = await streamValidateLargeIndexes(artifacts);
    expect(result.problems).toEqual([]);

    const resourceLines = textOf(artifacts, 'catalog/resources.jsonl')
      .split('\n')
      .filter(line => line.trim()).length;
    const relationLines = textOf(artifacts, 'catalog/relations.jsonl')
      .split('\n')
      .filter(line => line.trim()).length;
    const replayLines = textOf(artifacts, 'replay/http.jsonl')
      .split('\n')
      .filter(line => line.trim()).length;
    const valueFlow = JSON.parse(textOf(artifacts, 'ai/value-flow.json')) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(result.facts.resources).toHaveLength(resourceLines);
    expect(result.facts.relations).toHaveLength(relationLines);
    expect(result.facts.replayHttpRows).toHaveLength(replayLines);
    expect(result.facts.valueFlowNodes).toHaveLength(valueFlow.nodes.length);
    expect(result.facts.valueFlowEdges).toHaveLength(valueFlow.edges.length);
    // 样例包 storage 无 cacheStorage / additionalContexts：不注入空壳
    expect(result.facts.storageCacheRefs).toBeUndefined();
  });

  it('契约：委托模式与内存整读模式对样例包同判（闭包检查单一实现）', async () => {
    const artifacts = await sampleArtifacts();
    const inMemory = validatePackV2Consistency(fullContentArtifacts(artifacts), {
      requireChecksumFile: false,
    });
    expect(inMemory.valid).toBe(true);
    const delegated = await delegatedCheck(artifacts);
    expect(delegated.problems).toEqual([]);
    expect(delegated.check.valid).toBe(true);
  });

  it('契约：relations 引用未知 ID 时两种模式报同一问题（注入事实驱动同一闭包检查）', async () => {
    const artifacts = await sampleArtifacts();
    const lines = textOf(artifacts, 'catalog/relations.jsonl')
      .split('\n')
      .filter(line => line.trim());
    const badRow = JSON.parse(lines[0]) as Record<string, unknown>;
    badRow.from = 'target-nonexistent';
    lines.push(JSON.stringify(badRow));
    const mutated = withText(artifacts, 'catalog/relations.jsonl', `${lines.join('\n')}\n`);

    // 行本身 Schema 合法（闭包是跨文件检查），流式通道不报问题、只收集行
    const streamed = await streamValidateLargeIndexes(mutated);
    expect(streamed.problems).toEqual([]);
    expect(streamed.facts.relations).toHaveLength(lines.length);

    const inMemory = validatePackV2Consistency(fullContentArtifacts(mutated), {
      requireChecksumFile: false,
    });
    const delegated = await delegatedCheck(mutated);
    const inMemoryHit = inMemory.problems.filter(
      problem => problem.code === 'UNKNOWN_EVIDENCE_ID' && problem.path === 'catalog/relations.jsonl',
    );
    const delegatedHit = delegated.problems.filter(
      problem => problem.code === 'UNKNOWN_EVIDENCE_ID' && problem.path === 'catalog/relations.jsonl',
    );
    expect(inMemoryHit.length).toBeGreaterThan(0);
    // 两种模式在同一行上各报一次（from / to 各一条时同量）
    expect(delegatedHit.map(problem => problem.detail).sort()).toEqual(
      inMemoryHit.map(problem => problem.detail).sort(),
    );
  });

  it('反例：resources 行缺必填字段 → SCHEMA_VIOLATION；坏行 → PARSE_ERROR 且不收集', async () => {
    const artifacts = await sampleArtifacts();
    const lines = textOf(artifacts, 'catalog/resources.jsonl')
      .split('\n')
      .filter(line => line.trim());
    const firstRow = JSON.parse(lines[0]) as Record<string, unknown>;
    delete firstRow.url;
    lines[0] = JSON.stringify(firstRow);
    lines.push('{broken json');
    const mutated = withText(artifacts, 'catalog/resources.jsonl', `${lines.join('\n')}\n`);

    const result = await streamValidateLargeIndexes(mutated);
    const codes = result.problems.map(problem => problem.code);
    expect(codes).toContain('SCHEMA_VIOLATION');
    expect(codes).toContain('PARSE_ERROR');
    // 坏行不收集；Schema 违反行仍收集（与内存 jsonlOf 行为一致）
    expect(result.facts.resources).toHaveLength(lines.length - 1);
  });

  it('反例：replay/http 行缺必填字段 → SCHEMA_VIOLATION', async () => {
    const artifacts = await sampleArtifacts();
    const lines = textOf(artifacts, 'replay/http.jsonl')
      .split('\n')
      .filter(line => line.trim());
    const firstRow = JSON.parse(lines[0]) as Record<string, unknown>;
    delete firstRow.requestId;
    lines[0] = JSON.stringify(firstRow);
    const mutated = withText(artifacts, 'replay/http.jsonl', `${lines.join('\n')}\n`);
    const result = await streamValidateLargeIndexes(mutated);
    expect(
      result.problems.some(
        problem =>
          problem.code === 'SCHEMA_VIOLATION' &&
          problem.path === 'replay/http.jsonl' &&
          problem.detail.includes('requestId'),
      ),
    ).toBe(true);
  });
});

describe('value-flow 逐 token 走查', () => {
  const base = {
    schemaVersion: '2.0.0',
    nodes: [
      {
        id: 'node-resp-0001',
        kind: 'http-response',
        name: 'https://kvm.test/login',
        evidencePath: 'raw/http/bodies/0001',
      },
    ],
    edges: [],
  };

  it('契约：合法文件零问题，节点/边收集', async () => {
    const artifacts = await sampleArtifacts();
    const mutated = withText(artifacts, 'ai/value-flow.json', JSON.stringify(base));
    const result = await streamValidateLargeIndexes(mutated);
    expect(result.problems).toEqual([]);
    expect(result.facts.valueFlowNodes).toEqual([
      { id: 'node-resp-0001', evidencePath: 'raw/http/bodies/0001' },
    ]);
    expect(result.facts.valueFlowEdges).toEqual([]);
  });

  it('反例：缺必填键 / nodes 非数组 / 未知顶层键 / 节点缺字段', async () => {
    const artifacts = await sampleArtifacts();
    const cases: ReadonlyArray<{ content: string; expectDetail: string }> = [
      {
        content: JSON.stringify({ schemaVersion: '2.0.0', edges: [] }),
        expectDetail: '缺少 nodes',
      },
      {
        content: JSON.stringify({ ...base, nodes: {} }),
        expectDetail: 'nodes 必须是数组',
      },
      {
        content: JSON.stringify({ ...base, extra: 1 }),
        expectDetail: '契约外顶层键：extra',
      },
      {
        content: JSON.stringify({ ...base, nodes: [{ id: 'n1' }] }),
        expectDetail: 'nodes 元素不符合 ai-value-flow.schema.json',
      },
      {
        content: JSON.stringify({ ...base, schemaVersion: '1.0.0' }),
        expectDetail: 'schemaVersion 必须是 2.0.0',
      },
    ];
    for (const { content, expectDetail } of cases) {
      const mutated = withText(artifacts, 'ai/value-flow.json', content);
      const result = await streamValidateLargeIndexes(mutated);
      expect(
        result.problems.some(
          problem => problem.code === 'SCHEMA_VIOLATION' && problem.detail.includes(expectDetail),
        ),
        expectDetail,
      ).toBe(true);
    }
  });

  it('反例：空文件 / 根不是对象 / 尾部垃圾', async () => {
    const artifacts = await sampleArtifacts();
    for (const [content, code] of [
      ['', 'SCHEMA_VIOLATION'],
      ['[]', 'SCHEMA_VIOLATION'],
      [`${JSON.stringify(base)}{"second":"root"}`, 'PARSE_ERROR'],
    ] as ReadonlyArray<[string, string]>) {
      const mutated = withText(artifacts, 'ai/value-flow.json', content);
      const result = await streamValidateLargeIndexes(mutated);
      expect(result.problems.some(problem => problem.code === code)).toBe(true);
    }
  });
});

describe('storage 逐 token 走查', () => {
  const RESPONSE_REF = {
    sha256: 'a'.repeat(64),
    bytes: 12,
    path: 'raw/browser/cache/missing-body',
  };

  function storageFile(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      schemaVersion: '2.0.0',
      targetId: 'target-page-0001',
      capturedAt: '2026-09-21T10:00:10.000Z',
      cookies: [{ name: 'session', value: 'abc', domain: 'kvm.test', path: '/' }],
      localStorage: {},
      sessionStorage: { csrf: 'token' },
      indexedDb: [
        { database: 'db1', objectStore: 'store1', record: { key: 'k', value: 'v' } },
      ],
      cacheStorage: [],
      ...overrides,
    });
  }

  it('契约：cacheStorage 引用收集并驱动闭包检查（含 additionalContexts 归属）', async () => {
    const artifacts = await sampleArtifacts();
    const mutated = withText(
      artifacts,
      'raw/browser/storage.json',
      storageFile({
        cacheStorage: [
          {
            origin: 'https://kvm.test',
            cacheName: 'cache1',
            requestUrl: 'https://kvm.test/app.js',
            responseRef: RESPONSE_REF,
          },
        ],
        additionalContexts: [
          {
            targetId: 'target-iframe-0001',
            capturedAt: '2026-09-21T10:00:11.000Z',
            localStorage: {},
            sessionStorage: {},
            indexedDb: [],
            cacheStorage: [
              {
                origin: 'https://kvm.test',
                cacheName: 'cache2',
                requestUrl: 'https://kvm.test/viewer.js',
                responseRef: RESPONSE_REF,
              },
            ],
          },
        ],
      }),
    );
    // 行 Schema 合法：流式通道零问题，只收集引用
    const streamed = await streamValidateLargeIndexes(mutated);
    expect(streamed.problems).toEqual([]);
    expect(streamed.facts.storageCacheRefs).toEqual({
      cacheStorage: [{ requestUrl: 'https://kvm.test/app.js', responseRef: RESPONSE_REF }],
      additionalContexts: [
        {
          targetId: 'target-iframe-0001',
          cacheStorage: [{ requestUrl: 'https://kvm.test/viewer.js', responseRef: RESPONSE_REF }],
        },
      ],
    });
    // 引用文件不在包内 → 内存侧闭包检查报 DANGLING_BODY_REF（单一实现）
    const delegated = await delegatedCheck(mutated);
    const dangling = delegated.problems.filter(problem => problem.code === 'DANGLING_BODY_REF');
    expect(dangling.some(problem => problem.detail.includes('https://kvm.test/app.js'))).toBe(true);
    expect(
      dangling.some(problem => problem.detail.includes('target-iframe-0001')),
    ).toBe(true);
  });

  it('反例：localStorage 值非字符串 / 缺必填键 / 未知顶层键 / cacheStorage 元素缺字段', async () => {
    const artifacts = await sampleArtifacts();
    const cases: ReadonlyArray<{ content: string; expectDetail: string }> = [
      {
        content: storageFile({ localStorage: { key: 1 } }),
        expectDetail: 'localStorage/sessionStorage 值必须是字符串',
      },
      {
        content: storageFile({ capturedAt: undefined }),
        expectDetail: '缺少 capturedAt',
      },
      {
        content: storageFile({ extra: true }),
        expectDetail: '契约外顶层键：extra',
      },
      {
        content: storageFile({ cacheStorage: [{ origin: 'https://kvm.test' }] }),
        expectDetail: 'cacheStorage 元素不符合 browser-storage.schema.json',
      },
      {
        content: storageFile({
          additionalContexts: [
            {
              targetId: 'target-iframe-0001',
              capturedAt: '2026-09-21T10:00:11.000Z',
              localStorage: {},
              sessionStorage: {},
              indexedDb: [],
              cacheStorage: [],
            },
            {
              // 第二个上下文：数组栈场景——内层数组关闭后外层状态必须仍在
              targetId: 'target-iframe-0002',
              capturedAt: '2026-09-21T10:00:12.000Z',
              localStorage: {},
              sessionStorage: {},
              indexedDb: [{ database: 'db2', objectStore: 's2', record: 1 }],
              cacheStorage: [],
            },
          ],
        }),
        expectDetail: 'NOT-REPORTED',
      },
    ];
    for (const { content, expectDetail } of cases) {
      const mutated = withText(artifacts, 'raw/browser/storage.json', content);
      const result = await streamValidateLargeIndexes(mutated);
      if (expectDetail === 'NOT-REPORTED') {
        // 两个上下文（内含 indexedDb 数组）都合法：零问题、两个上下文都收集
        expect(result.problems).toEqual([]);
        expect(result.facts.storageCacheRefs?.additionalContexts).toHaveLength(2);
        continue;
      }
      expect(
        result.problems.some(
          problem => problem.code === 'SCHEMA_VIOLATION' && problem.detail.includes(expectDetail),
        ),
        expectDetail,
      ).toBe(true);
    }
  });

  it('反例：additionalContexts 元素缺必填键 / 空文件', async () => {
    const artifacts = await sampleArtifacts();
    const missingKey = storageFile({
      additionalContexts: [
        {
          capturedAt: '2026-09-21T10:00:11.000Z',
          localStorage: {},
          sessionStorage: {},
          indexedDb: [],
          cacheStorage: [],
        },
      ],
    });
    const mutated = withText(artifacts, 'raw/browser/storage.json', missingKey);
    const result = await streamValidateLargeIndexes(mutated);
    expect(
      result.problems.some(
        problem =>
          problem.code === 'SCHEMA_VIOLATION' && problem.detail.includes('缺少 targetId'),
      ),
    ).toBe(true);
    // 缺 targetId 的上下文不收集（无归属 ID 的事实不注入）
    expect(result.facts.storageCacheRefs?.additionalContexts ?? []).toHaveLength(0);

    const empty = withText(artifacts, 'raw/browser/storage.json', '');
    const emptyResult = await streamValidateLargeIndexes(empty);
    expect(
      emptyResult.problems.some(problem => problem.code === 'SCHEMA_VIOLATION'),
    ).toBe(true);
  });
});

describe('Schema/走查钉住（防止 Schema 与走查漂移）', () => {
  it('走查硬编码的键集合与包内 Schema 副本声明一致', async () => {
    const artifacts = await sampleArtifacts();
    const valueFlowSchema = JSON.parse(textOf(artifacts, 'schema/ai-value-flow.schema.json')) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(Object.keys(valueFlowSchema.properties).sort()).toEqual([
      'edges',
      'nodes',
      'schemaVersion',
    ]);
    expect(valueFlowSchema.required.sort()).toEqual(['edges', 'nodes', 'schemaVersion']);

    const storageSchema = JSON.parse(
      textOf(artifacts, 'schema/browser-storage.schema.json'),
    ) as {
      required: string[];
      properties: Record<string, {
        items?: { properties?: Record<string, unknown>; required?: string[] };
        additionalProperties?: unknown;
      }>;
    };
    expect(Object.keys(storageSchema.properties).sort()).toEqual([
      'additionalContexts',
      'cacheStorage',
      'capturedAt',
      'cookies',
      'indexedDb',
      'localStorage',
      'schemaVersion',
      'sessionStorage',
      'targetId',
    ]);
    expect(storageSchema.required.sort()).toEqual([
      'cacheStorage',
      'capturedAt',
      'cookies',
      'indexedDb',
      'localStorage',
      'schemaVersion',
      'sessionStorage',
      'targetId',
    ]);
    // 上下文元素键集合：走查按此集合逐键检查（缺一不可）
    const contextItems = storageSchema.properties.additionalContexts?.items;
    expect(Object.keys(contextItems?.properties ?? {}).sort()).toEqual([
      'cacheStorage',
      'capturedAt',
      'indexedDb',
      'localStorage',
      'sessionStorage',
      'targetId',
    ]);
    expect((contextItems?.required ?? []).sort()).toEqual([
      'cacheStorage',
      'capturedAt',
      'indexedDb',
      'localStorage',
      'sessionStorage',
      'targetId',
    ]);
    // 走查只对 cookies/indexedDb/cacheStorage 逐元素装配校验：Schema 必须声明 items
    for (const key of ['cookies', 'indexedDb', 'cacheStorage']) {
      expect(storageSchema.properties[key]?.items).toBeDefined();
    }
  });
});
