/**
 * 无上界索引文件的流式内容校验（导出门禁，规范 §9 磁盘优先）。
 *
 * catalog/resources.jsonl、catalog/relations.jsonl、replay/http.jsonl 是
 * 无上界行索引；ai/value-flow.json 与 raw/browser/storage.json（IndexedDB
 * record 内联、无上界）是无上界元素文件。它们在这里逐行 / 逐元素流式
 * 校验：JSONL 逐行 JSON 解析 + 包内 Schema 副本 Ajv 校验；元素文件用
 * stream-json 逐 token 走查（stream-json 严格保证恰好一个根对象的 JSON
 * 语法），数组元素用 JsonAssembler 单元素装配后逐元素 Ajv 校验，映射
 * （localStorage/sessionStorage）逐值检查字符串类型。校验后的行数据
 * 收集回传，注入 validatePackV2Consistency 执行全部跨文件闭包 / 对齐
 * 检查（单一实现，不在流式侧重复）。
 *
 * 诚实边界：行 / 元素数据本身仍 O(行数) 驻留（配对算法固有）；流式化
 * 消灭的是「整文件 buffer + 等大字符串 + 整份 JSON.parse 值」。元素级
 * 内存上界 = 最大单个元素（cacheStorage 条目 / value-flow 节点边）。
 * 问题列表上限 200 项并明确截断。path→Schema 映射复用
 * packV2Consistency 的同一事实源（单一实现）。
 */

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import Ajv from 'ajv';
import { parser } from 'stream-json';

import { JsonAssembler } from '../collector/jsonAssembler';
import type { Token } from '../collector/streamJsonTypes';
import {
  packV2SchemaTargetFor,
  SCHEMA_ID_PREFIX,
  type PackV2LargeIndexFacts,
  type PackV2ReplayHttpRow,
  type PackV2ValueFlowEdgeRef,
  type PackV2ValueFlowNodeRef,
} from '../capture-pack-v2/packV2Consistency';
import type {
  PackV2BodyRef,
  PackV2RelationRow,
  PackV2ResourceRow,
} from '../capture-pack-v2/types';
import {
  compileTargetSchemas,
  linesOf,
  readArtifactBytes,
  type RawJournalProblem,
} from './streamingRawJournalChecks';
import type { ZipArtifact } from './exportPackV2Zip';

export interface StreamedLargeIndexResult {
  problems: RawJournalProblem[];
  /** 校验后的大索引行数据（注入 validatePackV2Consistency 的闭包检查）。 */
  facts: PackV2LargeIndexFacts;
}

/** localStorage/sessionStorage 收集的 cacheStorage 引用行。 */
interface StorageCacheEntry {
  requestUrl: string;
  responseRef?: PackV2BodyRef;
}

function firstErrorOf(validate: (data: unknown) => boolean): string {
  const errors = (
    validate as unknown as { errors?: Array<{ instancePath?: string; message?: string }> }
  ).errors;
  const first = (errors || [])[0];
  return first ? `${first.instancePath || '/'} ${first.message || ''}` : 'invalid';
}

const isValueToken = (tok: Token): boolean =>
  tok.name === 'stringValue' ||
  tok.name === 'numberValue' ||
  tok.name === 'trueValue' ||
  tok.name === 'falseValue' ||
  tok.name === 'nullValue';

/**
 * 逐 token 走查一个元素文件（stream-json 保证恰好一个根对象的 JSON 语法，
 * 尾部垃圾 / 多根 / 未闭合都会以流错误返回）。返回流级错误（无则为 null）。
 */
async function walkTokens(
  artifact: ZipArtifact,
  onToken: (tok: Token) => void,
): Promise<string | null> {
  const source: Readable =
    artifact.source.kind === 'file'
      ? createReadStream(artifact.source.absolutePath, { encoding: 'utf8' })
      : Readable.from([
          typeof artifact.source.data === 'string'
            ? artifact.source.data
            : Buffer.from(artifact.source.data).toString('utf8'),
        ]);
  const p = parser.asStream();
  let parseError: string | null = null;
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = (error?: string) => {
      if (!settled) {
        settled = true;
        if (error) parseError = error;
        resolve();
      }
    };
    p.on('data', (tok: Token) => {
      try {
        onToken(tok);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
        p.destroy();
      }
    });
    p.on('error', error => finish(error instanceof Error ? error.message : String(error)));
    p.on('end', () => finish());
    void pipeline(source, p).catch(error => {
      finish(error instanceof Error ? error.message : String(error));
    });
  });
  return parseError;
}

export async function streamValidateLargeIndexes(
  artifacts: ReadonlyArray<ZipArtifact>,
): Promise<StreamedLargeIndexResult> {
  const problems: RawJournalProblem[] = [];
  const MAX_PROBLEMS = 200;
  let truncated = false;
  const add = (code: string, detail: string, path?: string) => {
    if (problems.length < MAX_PROBLEMS) {
      problems.push({ code, detail, ...(path ? { path } : {}) });
    } else if (!truncated) {
      truncated = true;
      problems.push({
        code: 'PROBLEM_LIST_TRUNCATED',
        detail: `校验问题超过 ${MAX_PROBLEMS} 项，其余问题已截断`,
      });
    }
  };

  const byPath = new Map(artifacts.map(artifact => [artifact.path, artifact]));
  const compiled = await compileTargetSchemas(artifacts);
  const resources: PackV2ResourceRow[] = [];
  const relations: PackV2RelationRow[] = [];
  const replayHttpRows: PackV2ReplayHttpRow[] = [];

  // ---- 行索引 JSONL：逐行解析 + Schema 校验 + 行收集 ----
  // 缺文件不在此报告（布局检查的 REQUIRED_FILE_MISSING 是单一事实源）。
  const jsonlTargets: ReadonlyArray<{
    path: string;
    rows: unknown[];
  }> = [
    { path: 'catalog/resources.jsonl', rows: resources },
    { path: 'catalog/relations.jsonl', rows: relations },
    { path: 'replay/http.jsonl', rows: replayHttpRows },
  ];
  for (const { path, rows } of jsonlTargets) {
    const artifact = byPath.get(path);
    if (!artifact) continue;
    const target = packV2SchemaTargetFor(path);
    if (!target) continue;
    const validate = compiled.validators.get(target.schema);
    let lineIndex = 0;
    for await (const line of linesOf(artifact)) {
      const index = lineIndex;
      lineIndex += 1;
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (error) {
        add(
          'PARSE_ERROR',
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
          path,
        );
        continue;
      }
      if (validate && !validate(row)) {
        add(
          'SCHEMA_VIOLATION',
          `${path} 第 ${index} 行不符合 ${target.schema}：${firstErrorOf(validate)}`,
          path,
        );
      }
      rows.push(row);
    }
  }

  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, allowUnionTypes: true });

  /** 从包内 Schema 副本编译 properties.<key>.items 的逐元素校验器。 */
  const compileItemValidators = async (
    schemaName: string,
    itemKeys: ReadonlyArray<string>,
  ): Promise<Map<string, (data: unknown) => boolean>> => {
    const result = new Map<string, (data: unknown) => boolean>();
    const copy = byPath.get(`schema/${schemaName}`);
    if (!copy) return result; // PACK_SCHEMA_MISSING 由元数据校验报告
    let schema: unknown;
    try {
      schema = JSON.parse((await readArtifactBytes(copy)).toString('utf8'));
    } catch {
      return result; // Schema 副本不可解析由元数据校验报告
    }
    const parsed = schema as { $id?: unknown; properties?: Record<string, { items?: unknown }> };
    if (parsed.$id !== `${SCHEMA_ID_PREFIX}/${schemaName}`) return result;
    for (const key of itemKeys) {
      const items = parsed.properties?.[key]?.items;
      if (!items) continue;
      try {
        result.set(key, ajv.compile(items as object) as (data: unknown) => boolean);
      } catch {
        // 编译失败由元数据校验的 Schema 自校验报告
      }
    }
    return result;
  };

  const valueFlowNodes: PackV2ValueFlowNodeRef[] = [];
  const valueFlowEdges: PackV2ValueFlowEdgeRef[] = [];
  const valueFlowArtifact = byPath.get('ai/value-flow.json');
  if (valueFlowArtifact) {
    const validators = await compileItemValidators('ai-value-flow.schema.json', ['nodes', 'edges']);
    const nodeValidate = validators.get('nodes');
    const edgeValidate = validators.get('edges');
    const path = 'ai/value-flow.json';
    const allowedKeys = new Set(['schemaVersion', 'nodes', 'edges']);

    let depth = 0;
    let sawRoot = false;
    let rootClosed = false;
    let topKey: string | null = null;
    let sawKeys = new Set<string>();
    let schemaVersion: string | null = null;
    let arrayKey: 'nodes' | 'edges' | null = null;
    let arrayDepth = 0;
    let assembler: JsonAssembler | null = null;
    let elementDepth = 0;

    const finishElement = () => {
      const value = (assembler as JsonAssembler).value as Record<string, unknown>;
      if (arrayKey === 'nodes') {
        if (nodeValidate && !nodeValidate(value)) {
          add(
            'SCHEMA_VIOLATION',
            `${path} 的 nodes 元素不符合 ai-value-flow.schema.json：${firstErrorOf(nodeValidate)}`,
            path,
          );
        }
        valueFlowNodes.push({
          id: value.id as string,
          ...(typeof value.evidencePath === 'string' ? { evidencePath: value.evidencePath } : {}),
          ...(typeof value.evidenceId === 'string' ? { evidenceId: value.evidenceId } : {}),
        });
      } else if (arrayKey === 'edges') {
        if (edgeValidate && !edgeValidate(value)) {
          add(
            'SCHEMA_VIOLATION',
            `${path} 的 edges 元素不符合 ai-value-flow.schema.json：${firstErrorOf(edgeValidate)}`,
            path,
          );
        }
        valueFlowEdges.push({
          from: value.from as string,
          to: value.to as string,
          ...(typeof value.evidencePath === 'string' ? { evidencePath: value.evidencePath } : {}),
        });
      }
    };

    const handleToken = (tok: Token) => {
      switch (tok.name) {
        case 'startObject':
        case 'startArray': {
          depth += 1;
          if (assembler) {
            assembler.consume(tok);
            return;
          }
          if (depth === 1) {
            sawRoot = true;
            if (tok.name !== 'startObject') {
              add('SCHEMA_VIOLATION', `${path} 的根必须是对象`, path);
            }
            return;
          }
          if (depth === 2 && (topKey === 'nodes' || topKey === 'edges')) {
            if (tok.name !== 'startArray') {
              add('SCHEMA_VIOLATION', `${path} 的 ${topKey} 必须是数组`, path);
              topKey = null;
              return;
            }
            arrayKey = topKey;
            arrayDepth = depth;
            topKey = null;
            return;
          }
          if (arrayKey && depth === arrayDepth + 1) {
            if (tok.name !== 'startObject') {
              add('SCHEMA_VIOLATION', `${path} 的 ${arrayKey} 数组元素必须是对象`, path);
              return;
            }
            assembler = new JsonAssembler();
            assembler.consume(tok);
            elementDepth = depth;
            return;
          }
          add(
            'SCHEMA_VIOLATION',
            `${path} 结构非法：${topKey ?? arrayKey ?? '根'} 的值形状不符`,
            path,
          );
          return;
        }
        case 'endObject':
        case 'endArray': {
          const closingDepth = depth;
          if (assembler) {
            assembler.consume(tok);
            if (tok.name === 'endObject' && closingDepth === elementDepth) {
              finishElement();
              assembler = null;
            }
            depth -= 1;
            return;
          }
          if (arrayKey && tok.name === 'endArray' && closingDepth === arrayDepth) {
            arrayKey = null;
            depth -= 1;
            return;
          }
          if (tok.name === 'endObject' && closingDepth === 1) {
            rootClosed = true;
            for (const key of ['schemaVersion', 'nodes', 'edges']) {
              if (!sawKeys.has(key)) {
                add('SCHEMA_VIOLATION', `${path} 缺少 ${key}`, path);
              }
            }
            if (schemaVersion !== '2.0.0') {
              add('SCHEMA_VIOLATION', `${path} 的 schemaVersion 必须是 2.0.0`, path);
            }
            depth -= 1;
            return;
          }
          depth -= 1;
          return;
        }
        case 'keyValue': {
          if (assembler) {
            assembler.consume(tok);
            return;
          }
          if (depth === 1) {
            const key = String(tok.value);
            if (!allowedKeys.has(key)) {
              add('SCHEMA_VIOLATION', `${path} 存在契约外顶层键：${key}`, path);
              return;
            }
            if (sawKeys.has(key)) {
              add('SCHEMA_VIOLATION', `${path} 顶层键重复：${key}`, path);
              return;
            }
            sawKeys.add(key);
            topKey = key;
            return;
          }
          add('SCHEMA_VIOLATION', `${path} 结构非法：意外的键`, path);
          return;
        }
        default: {
          if (!isValueToken(tok)) return;
          if (assembler) {
            assembler.consume(tok);
            return;
          }
          if (depth === 1 && topKey === 'schemaVersion') {
            schemaVersion = tok.name === 'stringValue' ? String(tok.value) : '';
            topKey = null;
            return;
          }
          if (depth === 1 && (topKey === 'nodes' || topKey === 'edges')) {
            add('SCHEMA_VIOLATION', `${path} 的 ${topKey} 必须是数组`, path);
            topKey = null;
            return;
          }
          if (arrayKey && depth === arrayDepth + 1) {
            add('SCHEMA_VIOLATION', `${path} 的 ${arrayKey} 数组元素必须是对象`, path);
            return;
          }
          add('SCHEMA_VIOLATION', `${path} 结构非法：意外的值`, path);
        }
      }
    };

    const parseError = await walkTokens(valueFlowArtifact, handleToken);
    if (parseError) {
      add('PARSE_ERROR', `${path}: ${parseError}`, path);
    }
    if (!sawRoot || !rootClosed) {
      add('SCHEMA_VIOLATION', `${path} 必须恰好包含一个根对象`, path);
    }
  }

  const topCacheStorage: StorageCacheEntry[] = [];
  const contextCacheStorage: Array<{ targetId: string; cacheStorage: StorageCacheEntry[] }> = [];
  const storageArtifact = byPath.get('raw/browser/storage.json');
  if (storageArtifact) {
    const validators = await compileItemValidators('browser-storage.schema.json', [
      'cookies',
      'indexedDb',
      'cacheStorage',
    ]);
    const cookieValidate = validators.get('cookies');
    const indexedDbValidate = validators.get('indexedDb');
    const cacheStorageValidate = validators.get('cacheStorage');
    const path = 'raw/browser/storage.json';
    const ROOT_KEYS = new Set([
      'schemaVersion',
      'targetId',
      'capturedAt',
      'cookies',
      'localStorage',
      'sessionStorage',
      'indexedDb',
      'cacheStorage',
      'additionalContexts',
    ]);
    const ROOT_REQUIRED = [
      'schemaVersion',
      'targetId',
      'capturedAt',
      'cookies',
      'localStorage',
      'sessionStorage',
      'indexedDb',
      'cacheStorage',
    ];
    const CONTEXT_KEYS = new Set([
      'targetId',
      'capturedAt',
      'localStorage',
      'sessionStorage',
      'indexedDb',
      'cacheStorage',
    ]);
    const CONTEXT_REQUIRED = [
      'targetId',
      'capturedAt',
      'localStorage',
      'sessionStorage',
      'indexedDb',
      'cacheStorage',
    ];

    let depth = 0;
    let sawRoot = false;
    let rootClosed = false;
    let rootKey: string | null = null;
    let sawRootKeys = new Set<string>();
    let schemaVersion: string | null = null;
    type RecordsKind = 'cookies' | 'indexedDb' | 'cacheStorage';
    type ArrayFrame = { depth: number; kind: RecordsKind | 'contexts' };
    // 数组栈：上下文内的 indexedDb/cacheStorage 数组嵌在 additionalContexts
    // 数组之内，单变量会在内层数组关闭后丢失外层状态（第二个上下文元素
    // 会被误报为意外容器）。
    const arrayStack: ArrayFrame[] = [];
    const arrayTop = (): ArrayFrame | undefined => arrayStack[arrayStack.length - 1];
    // additionalContexts 元素不整体装配（IndexedDB record 内联无上界），
    // 逐键走查：targetId / capturedAt 标量、两个 storage 映射、两个记录数组。
    let contextDepth = 0;
    let contextTargetId: string | null = null;
    let contextSawKeys = new Set<string>();
    let contextKey: string | null = null;
    let currentContextCache: StorageCacheEntry[] | null = null;
    // localStorage / sessionStorage：值为字符串的映射。
    let mapDepth: number | null = null;
    let mapKey: string | null = null;
    let assembler: JsonAssembler | null = null;
    let elementKind: RecordsKind | null = null;
    let elementDepth = 0;

    const finishElement = () => {
      const value = (assembler as JsonAssembler).value as Record<string, unknown>;
      const validate =
        elementKind === 'cookies'
          ? cookieValidate
          : elementKind === 'indexedDb'
            ? indexedDbValidate
            : cacheStorageValidate;
      if (validate && !validate(value)) {
        add(
          'SCHEMA_VIOLATION',
          `${path} 的 ${elementKind} 元素不符合 browser-storage.schema.json：${firstErrorOf(validate)}`,
          path,
        );
      }
      if (elementKind === 'cacheStorage') {
        (currentContextCache ?? topCacheStorage).push({
          requestUrl: String(value.requestUrl ?? ''),
          ...(value.responseRef !== undefined
            ? { responseRef: value.responseRef as PackV2BodyRef }
            : {}),
        });
      }
    };

    const handleToken = (tok: Token) => {
      switch (tok.name) {
        case 'startObject':
        case 'startArray': {
          depth += 1;
          if (assembler) {
            assembler.consume(tok);
            return;
          }
          if (depth === 1) {
            sawRoot = true;
            if (tok.name !== 'startObject') {
              add('SCHEMA_VIOLATION', `${path} 的根必须是对象`, path);
            }
            return;
          }
          // 根键的值开始
          if (depth === 2 && rootKey !== null) {
            const key = rootKey;
            rootKey = null;
            if (key === 'cookies' || key === 'indexedDb' || key === 'cacheStorage') {
              if (tok.name !== 'startArray') {
                add('SCHEMA_VIOLATION', `${path} 的 ${key} 必须是数组`, path);
                return;
              }
              arrayStack.push({ depth: 2, kind: key });
              return;
            }
            if (key === 'additionalContexts') {
              if (tok.name !== 'startArray') {
                add('SCHEMA_VIOLATION', `${path} 的 additionalContexts 必须是数组`, path);
                return;
              }
              arrayStack.push({ depth: 2, kind: 'contexts' });
              return;
            }
            if (key === 'localStorage' || key === 'sessionStorage') {
              if (tok.name !== 'startObject') {
                add('SCHEMA_VIOLATION', `${path} 的 ${key} 必须是对象`, path);
                return;
              }
              mapDepth = 2;
              return;
            }
            add('SCHEMA_VIOLATION', `${path} 的 ${key} 必须是非空字符串`, path);
            return;
          }
          // additionalContexts 元素开始
          const top = arrayTop();
          if (top?.kind === 'contexts' && depth === top.depth + 1) {
            if (tok.name !== 'startObject') {
              add('SCHEMA_VIOLATION', `${path} 的 additionalContexts 元素必须是对象`, path);
              return;
            }
            contextDepth = depth;
            contextTargetId = null;
            contextSawKeys = new Set();
            contextKey = null;
            currentContextCache = [];
            return;
          }
          // 上下文键的值开始
          if (contextDepth > 0 && contextKey !== null && depth === contextDepth + 1) {
            const key = contextKey;
            contextKey = null;
            if (key === 'localStorage' || key === 'sessionStorage') {
              if (tok.name !== 'startObject') {
                add('SCHEMA_VIOLATION', `${path} 上下文的 ${key} 必须是对象`, path);
                return;
              }
              mapDepth = depth;
              return;
            }
            if (key === 'indexedDb' || key === 'cacheStorage') {
              if (tok.name !== 'startArray') {
                add('SCHEMA_VIOLATION', `${path} 上下文的 ${key} 必须是数组`, path);
                return;
              }
              arrayStack.push({ depth, kind: key });
              return;
            }
            add('SCHEMA_VIOLATION', `${path} 上下文的 ${key} 必须是非空字符串`, path);
            return;
          }
          // 记录数组元素开始
          if (top && top.kind !== 'contexts' && depth === top.depth + 1) {
            if (tok.name !== 'startObject') {
              add('SCHEMA_VIOLATION', `${path} 的 ${top.kind} 数组元素必须是对象`, path);
              return;
            }
            assembler = new JsonAssembler();
            assembler.consume(tok);
            elementKind = top.kind;
            elementDepth = depth;
            return;
          }
          add('SCHEMA_VIOLATION', `${path} 结构非法：意外的容器`, path);
          return;
        }
        case 'endObject':
        case 'endArray': {
          const closingDepth = depth;
          if (assembler) {
            assembler.consume(tok);
            if (tok.name === 'endObject' && closingDepth === elementDepth) {
              finishElement();
              assembler = null;
              elementKind = null;
            }
            depth -= 1;
            return;
          }
          if (mapDepth !== null && tok.name === 'endObject' && closingDepth === mapDepth) {
            mapDepth = null;
            mapKey = null;
            depth -= 1;
            return;
          }
          if (contextDepth > 0 && tok.name === 'endObject' && closingDepth === contextDepth) {
            for (const key of CONTEXT_REQUIRED) {
              if (!contextSawKeys.has(key)) {
                add('SCHEMA_VIOLATION', `${path} 的 additionalContexts 元素缺少 ${key}`, path);
              }
            }
            if (contextTargetId !== null) {
              contextCacheStorage.push({
                targetId: contextTargetId,
                cacheStorage: currentContextCache ?? [],
              });
            }
            contextDepth = 0;
            contextTargetId = null;
            currentContextCache = null;
            contextKey = null;
            depth -= 1;
            return;
          }
          if (arrayTop() && tok.name === 'endArray' && closingDepth === arrayTop()!.depth) {
            arrayStack.pop();
            depth -= 1;
            return;
          }
          if (tok.name === 'endObject' && closingDepth === 1) {
            rootClosed = true;
            for (const key of ROOT_REQUIRED) {
              if (!sawRootKeys.has(key)) {
                add('SCHEMA_VIOLATION', `${path} 缺少 ${key}`, path);
              }
            }
            if (schemaVersion !== '2.0.0') {
              add('SCHEMA_VIOLATION', `${path} 的 schemaVersion 必须是 2.0.0`, path);
            }
            depth -= 1;
            return;
          }
          depth -= 1;
          return;
        }
        case 'keyValue': {
          if (assembler) {
            assembler.consume(tok);
            return;
          }
          if (mapDepth !== null && depth === mapDepth) {
            mapKey = String(tok.value);
            return;
          }
          if (depth === 1) {
            const key = String(tok.value);
            if (!ROOT_KEYS.has(key)) {
              add('SCHEMA_VIOLATION', `${path} 存在契约外顶层键：${key}`, path);
              return;
            }
            if (sawRootKeys.has(key)) {
              add('SCHEMA_VIOLATION', `${path} 顶层键重复：${key}`, path);
              return;
            }
            sawRootKeys.add(key);
            rootKey = key;
            return;
          }
          if (contextDepth > 0 && depth === contextDepth) {
            const key = String(tok.value);
            if (!CONTEXT_KEYS.has(key)) {
              add('SCHEMA_VIOLATION', `${path} 的 additionalContexts 元素存在契约外键：${key}`, path);
              return;
            }
            if (contextSawKeys.has(key)) {
              add('SCHEMA_VIOLATION', `${path} 的 additionalContexts 元素键重复：${key}`, path);
              return;
            }
            contextSawKeys.add(key);
            contextKey = key;
            return;
          }
          add('SCHEMA_VIOLATION', `${path} 结构非法：意外的键`, path);
          return;
        }
        default: {
          if (!isValueToken(tok)) return;
          if (assembler) {
            assembler.consume(tok);
            return;
          }
          if (mapKey !== null) {
            if (tok.name !== 'stringValue') {
              add(
                'SCHEMA_VIOLATION',
                `${path} 的 localStorage/sessionStorage 值必须是字符串`,
                path,
              );
            }
            mapKey = null;
            return;
          }
          if (depth === 1 && rootKey !== null) {
            const key = rootKey;
            rootKey = null;
            if (key === 'schemaVersion') {
              schemaVersion = tok.name === 'stringValue' ? String(tok.value) : '';
            } else if (tok.name !== 'stringValue' || String(tok.value).length === 0) {
              add('SCHEMA_VIOLATION', `${path} 的 ${key} 必须是非空字符串`, path);
            }
            return;
          }
          if (contextDepth > 0 && contextKey !== null && depth === contextDepth) {
            const key = contextKey;
            contextKey = null;
            if (key === 'targetId') {
              if (tok.name !== 'stringValue' || String(tok.value).length === 0) {
                add('SCHEMA_VIOLATION', `${path} 上下文的 targetId 必须是非空字符串`, path);
              } else {
                contextTargetId = String(tok.value);
              }
            } else if (tok.name !== 'stringValue' || String(tok.value).length === 0) {
              add('SCHEMA_VIOLATION', `${path} 上下文的 ${key} 必须是非空字符串`, path);
            }
            return;
          }
          const elementTop = arrayTop();
          if (elementTop && depth === elementTop.depth + 1) {
            add('SCHEMA_VIOLATION', `${path} 的 ${elementTop.kind} 数组元素必须是对象`, path);
            return;
          }
          add('SCHEMA_VIOLATION', `${path} 结构非法：意外的值`, path);
        }
      }
    };

    const parseError = await walkTokens(storageArtifact, handleToken);
    if (parseError) {
      add('PARSE_ERROR', `${path}: ${parseError}`, path);
    }
    if (!sawRoot || !rootClosed) {
      add('SCHEMA_VIOLATION', `${path} 必须恰好包含一个根对象`, path);
    }
  }

  return {
    problems,
    facts: {
      resources,
      relations,
      replayHttpRows,
      valueFlowNodes,
      valueFlowEdges,
      storageCacheRefs:
        topCacheStorage.length === 0 && contextCacheStorage.length === 0
          ? undefined
          : { cacheStorage: topCacheStorage, additionalContexts: contextCacheStorage },
    },
  };
}
