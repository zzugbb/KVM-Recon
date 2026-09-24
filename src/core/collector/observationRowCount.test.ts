import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { PackArtifactReader } from '../capture-pack-v2/readPackFacts';
import {
  countObservationRows,
  isZeroObservation,
  OBSERVATION_ROWS_UNKNOWN,
} from './observationRowCount';

/**
 * 观察事实行数计数（零观察事实丢弃门禁的判定输入）。
 * 反例先行：行数不可读 = -1（不能证明零观察就不放宽丢弃）；
 * 块边界切开的行不重复计数；channels 键值不是数组 = 不可读。
 */

function memoryReader(files: Map<string, string | Buffer>): PackArtifactReader {
  return {
    async readArtifact(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`工件不存在：${path}`);
      return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    },
    async artifactPaths() {
      return [...files.keys()].sort();
    },
    async openArtifactStream(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`工件不存在：${path}`);
      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      return Readable.from([buffer]);
    },
  };
}

describe('countObservationRows（观察事实行数）', () => {
  it('三个观察面全缺失 = 零观察事实（该观察面未产生任何行）', async () => {
    const counts = await countObservationRows(memoryReader(new Map()));
    expect(counts).toEqual({ transactions: 0, channels: 0, actions: 0 });
    expect(isZeroObservation(counts)).toBe(true);
  });

  it('事务 / 动作按非空行计数：空行不计，末行无换行也计一行', async () => {
    const files = new Map<string, string>([
      ['raw/http/transactions.jsonl', '{"requestId":"http-000001"}\n\n{"requestId":"http-000002"}\n'],
      ['raw/browser/actions.jsonl', '{"actionId":"act-000001"}'],
    ]);
    const counts = await countObservationRows(memoryReader(files));
    expect(counts.transactions).toBe(2);
    expect(counts.actions).toBe(1);
    expect(counts.channels).toBe(0);
    expect(isZeroObservation(counts)).toBe(false);
  });

  it('反例：块边界切开的行不重复计数（残行拼接）', async () => {
    const row = `{"requestId":"http-000001","url":"https://kvm.test/login","method":"POST","requestBody":"${'a'.repeat(64)}"}`;
    // 行在三个块的边界上被切开：切点不产生多余的空行 / 半行
    const whole = Buffer.from(`${row}\n${row}\n${row}\n`, 'utf8');
    const cut1 = Math.floor(whole.length / 3);
    const cut2 = Math.floor((whole.length * 2) / 3);
    const reader: PackArtifactReader = {
      async readArtifact() {
        throw new Error('不应整读');
      },
      async artifactPaths() {
        return ['raw/http/transactions.jsonl', 'raw/browser/actions.jsonl', 'catalog/channels.json'];
      },
      async openArtifactStream() {
        return Readable.from([whole.subarray(0, cut1), whole.subarray(cut1, cut2), whole.subarray(cut2)]);
      },
    };
    const counts = await countObservationRows(reader);
    expect(counts.transactions).toBe(3);
  });

  it('channels.json 顶层 channels 数组元素计数', async () => {
    const files = new Map<string, string>([
      [
        'catalog/channels.json',
        `{"schemaVersion":"2.0.0","channels":[${Array.from(
          { length: 4 },
          (_, index) => `{"channelId":"ws-000${index + 1}","kind":"websocket","frames":{"up":0,"down":3}}`,
        ).join(',')}]}\n`,
      ],
    ]);
    const counts = await countObservationRows(memoryReader(files));
    expect(counts.channels).toBe(4);
    expect(isZeroObservation(counts)).toBe(false);
  });

  it('重复 channels 键 last-wins：重开数组即重置计数（非相加）', async () => {
    const files = new Map<string, string>([
      [
        'catalog/channels.json',
        '{"schemaVersion":"2.0.0","channels":[{"channelId":"ws-0001"},{"channelId":"ws-0002"}],"channels":[{"channelId":"ws-0003"}]}\n',
      ],
    ]);
    const counts = await countObservationRows(memoryReader(files));
    expect(counts.channels).toBe(1);
  });

  it('反例：channels 键的值不是数组 = 行数不可读（-1）', async () => {
    const files = new Map<string, string>([
      ['catalog/channels.json', '{"schemaVersion":"2.0.0","channels":null}\n'],
    ]);
    const counts = await countObservationRows(memoryReader(files));
    expect(counts.channels).toBe(OBSERVATION_ROWS_UNKNOWN);
    expect(isZeroObservation(counts)).toBe(false);
  });

  it('反例：channels 键的值是对象 / 根不是对象 = 行数不可读（-1，不猜零）', async () => {
    const objectValue = new Map<string, string>([
      ['catalog/channels.json', '{"schemaVersion":"2.0.0","channels":{"ws-0001":{}}}\n'],
    ]);
    expect((await countObservationRows(memoryReader(objectValue))).channels).toBe(OBSERVATION_ROWS_UNKNOWN);

    const arrayRoot = new Map<string, string>([
      ['catalog/channels.json', '[{"channelId":"ws-0001"}]\n'],
    ]);
    expect((await countObservationRows(memoryReader(arrayRoot))).channels).toBe(OBSERVATION_ROWS_UNKNOWN);
  });

  it('反例：channels.json 非法 JSON / 打开失败 = 行数不可读（-1）', async () => {
    const garbage = new Map<string, string>([
      ['catalog/channels.json', 'not-json-at-all'],
    ]);
    expect((await countObservationRows(memoryReader(garbage))).channels).toBe(OBSERVATION_ROWS_UNKNOWN);

    const throwOnOpen = memoryReader(new Map([['catalog/channels.json', '[]']]));
    const failing: PackArtifactReader = {
      readArtifact: throwOnOpen.readArtifact,
      artifactPaths: throwOnOpen.artifactPaths,
      async openArtifactStream() {
        throw new Error('打开失败');
      },
    };
    expect((await countObservationRows(failing)).channels).toBe(OBSERVATION_ROWS_UNKNOWN);
  });

  it('反例：artifactPaths 枚举失败 = 行数不可读（-1，不猜零）', async () => {
    const reader: PackArtifactReader = {
      async readArtifact() {
        throw new Error('不应到达');
      },
      async artifactPaths() {
        throw new Error('枚举失败');
      },
      async openArtifactStream() {
        throw new Error('不应到达');
      },
    };
    const counts = await countObservationRows(reader);
    expect(counts).toEqual({
      transactions: OBSERVATION_ROWS_UNKNOWN,
      channels: OBSERVATION_ROWS_UNKNOWN,
      actions: OBSERVATION_ROWS_UNKNOWN,
    });
  });
});
