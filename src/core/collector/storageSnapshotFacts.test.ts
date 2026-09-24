import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readStorageSnapshotFacts } from './storageSnapshotFacts';

/**
 * 阶段 6 刀 1：storage.json 流式事实提取。
 * 反例先行：空输入 / 非法 JSON / 多根必须抛错（读取失败显式记账，
 * 不允许静默当作空快照）；被消费字段的语义与整读 JSON.parse 等价。
 */

function fromText(text: string): Readable {
  return Readable.from([text]);
}

describe('readStorageSnapshotFacts', () => {
  it('提取证据图实际消费的字段（cookies / sessionStorage / localStorage / capturedAt）', async () => {
    const facts = await readStorageSnapshotFacts(
      fromText(
        JSON.stringify({
          schemaVersion: '2.0.0',
          targetId: 'target-000001',
          capturedAt: '2026-09-23T10:00:00.000Z',
          cookies: [
            { name: 'JSESSIONID', value: 'abc123', domain: '.example.local' },
            { name: 'b', value: '2' },
          ],
          localStorage: { theme: 'dark', token: 't'.repeat(16) },
          sessionStorage: { sid: 's'.repeat(16) },
          // 未消费的大块（indexedDb / cacheStorage / additionalContexts）在场也必须跳过
          indexedDb: [
            { database: 'db', objectStore: 'store', record: { blob: 'x'.repeat(4096) } },
          ],
          cacheStorage: [{ origin: 'https://a', cacheName: 'c', requestUrl: 'https://a/x' }],
          additionalContexts: [
            {
              targetId: 'popup-1',
              capturedAt: '2026-09-23T10:00:01.000Z',
              localStorage: { k: 'v' },
              sessionStorage: {},
              indexedDb: [],
              cacheStorage: [],
            },
          ],
        }),
      ),
    );
    expect(facts.capturedAt).toBe('2026-09-23T10:00:00.000Z');
    expect(facts.storageCookies).toEqual([
      { name: 'JSESSIONID', value: 'abc123' },
      { name: 'b', value: '2' },
    ]);
    // 与整读一致的顺序：sessionStorage 在前，localStorage 在后
    expect(facts.storageValues).toEqual([
      { key: 'sid', value: 's'.repeat(16) },
      { key: 'theme', value: 'dark' },
      { key: 'token', value: 't'.repeat(16) },
    ]);
  });

  it('非法条目跳过：cookie 缺 name/value、storage 值非字符串', async () => {
    const facts = await readStorageSnapshotFacts(
      fromText(
        JSON.stringify({
          capturedAt: '2026-09-23T10:00:00.000Z',
          cookies: [
            { name: 'ok', value: '1' },
            { name: 'no-value' },
            { value: 'no-name' },
            'not-an-object',
            { name: 1, value: 2 },
          ],
          sessionStorage: { good: 'v', bad: 42, worse: null, deep: { x: 1 } },
          localStorage: {},
        }),
      ),
    );
    expect(facts.storageCookies).toEqual([{ name: 'ok', value: '1' }]);
    expect(facts.storageValues).toEqual([{ key: 'good', value: 'v' }]);
  });

  it('capturedAt 非字符串为 null；缺字段维度为空；数组根返回空维度', async () => {
    const noField = await readStorageSnapshotFacts(fromText('{"targetId": "t"}'));
    expect(noField.capturedAt).toBeNull();
    expect(noField.storageCookies).toEqual([]);
    expect(noField.storageValues).toEqual([]);

    const nonString = await readStorageSnapshotFacts(
      fromText('{"capturedAt": 123, "cookies": [], "localStorage": {}, "sessionStorage": {}}'),
    );
    expect(nonString.capturedAt).toBeNull();

    const arrayRoot = await readStorageSnapshotFacts(fromText('[1, 2, 3]'));
    expect(arrayRoot.capturedAt).toBeNull();
    expect(arrayRoot.storageCookies).toEqual([]);
    expect(arrayRoot.storageValues).toEqual([]);
  });

  it('重复键 last-wins：storage 源内覆盖、cookies 数组重开清空', async () => {
    const facts = await readStorageSnapshotFacts(
      fromText(
        '{"capturedAt":"a","capturedAt":"b",' +
          '"sessionStorage":{"k":"first","k":"second"},' +
          '"cookies":[{"name":"a","value":"1"}],"cookies":[{"name":"b","value":"2"}]}',
      ),
    );
    expect(facts.capturedAt).toBe('b');
    expect(facts.storageValues).toEqual([{ key: 'k', value: 'second' }]);
    expect(facts.storageCookies).toEqual([{ name: 'b', value: '2' }]);
  });

  it('反例：空输入 / 非法 JSON / 多根 / 截断一律抛错（不得静默当作空快照）', async () => {
    await expect(readStorageSnapshotFacts(fromText(''))).rejects.toThrow();
    await expect(readStorageSnapshotFacts(fromText('   '))).rejects.toThrow();
    await expect(readStorageSnapshotFacts(fromText('{"cookies": ['))).rejects.toThrow();
    await expect(readStorageSnapshotFacts(fromText('{"a":1} trailing'))).rejects.toThrow();
    await expect(readStorageSnapshotFacts(fromText('{"a":1}{"b":2}'))).rejects.toThrow();
  });

  it('跨块流式：字段值被任意切块仍完整提取', async () => {
    const text = JSON.stringify({
      capturedAt: '2026-09-23T10:00:00.000Z',
      cookies: [{ name: 'sid', value: '0123456789abcdef' }],
      sessionStorage: { k: 'v'.repeat(64) },
    });
    const mid = Math.floor(text.length / 2);
    const stream = Readable.from([text.slice(0, mid), text.slice(mid)]);
    const facts = await readStorageSnapshotFacts(stream);
    expect(facts.capturedAt).toBe('2026-09-23T10:00:00.000Z');
    expect(facts.storageCookies).toEqual([{ name: 'sid', value: '0123456789abcdef' }]);
    expect(facts.storageValues).toEqual([{ key: 'k', value: 'v'.repeat(64) }]);
  });
});
