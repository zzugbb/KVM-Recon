import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  CACHE_STORAGE_DUMP_EXPRESSION,
  INDEXEDDB_DUMP_EXPRESSION,
} from './attachProtocolAgnosticCapture';

describe('浏览器存储快照表达式', () => {
  it('存储存在但为空时返回成功的空集合', async () => {
    const indexedDb = await runInNewContext(INDEXEDDB_DUMP_EXPRESSION, {
      indexedDB: { databases: async () => [] },
    });
    const cacheStorage = await runInNewContext(CACHE_STORAGE_DUMP_EXPRESSION, {
      caches: { keys: async () => [] },
    });
    expect(indexedDb).toEqual([]);
    expect(cacheStorage).toEqual([]);
  });

  it('IndexedDB 数据库打开失败时不伪造为空集合', async () => {
    const result = await runInNewContext(INDEXEDDB_DUMP_EXPRESSION, {
      indexedDB: {
        databases: async () => [{ name: 'app' }],
        open: () => {
          throw new Error('open failed');
        },
      },
    });
    expect(result).toBeNull();
  });

  it('CacheStorage 响应正文读取失败时不伪造为空集合', async () => {
    const request = { url: 'https://bmc.invalid/viewer.js' };
    const cache = {
      keys: async () => [request],
      match: async () => ({
        status: 200,
        headers: { get: () => 'text/javascript' },
        arrayBuffer: async () => {
          throw new Error('body unreadable');
        },
      }),
    };
    const result = await runInNewContext(CACHE_STORAGE_DUMP_EXPRESSION, {
      caches: { keys: async () => ['app'], open: async () => cache },
      location: { origin: 'https://bmc.invalid' },
    });
    expect(result).toBeNull();
  });
});
