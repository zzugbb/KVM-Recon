import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { scanStreamForNeedles } from './chunkedNeedleScan';

/**
 * 刀 1：分块滚动扫描原语。反例先行：needle 跨块边界必须命中（块重叠 =
 * 最长 needle − 1）；needle 命中即从待测集移除；空 needle 永不命中。
 */

function chunked(data: Buffer, chunkBytes: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
    chunks.push(data.subarray(offset, Math.min(data.byteLength, offset + chunkBytes)));
  }
  return Readable.from(chunks);
}

describe('scanStreamForNeedles', () => {
  it('needle 恰好跨块边界（任意切点）必须命中', async () => {
    const needle = Buffer.from('NEEDLE-0123456789abcdef', 'utf8');
    const data = Buffer.from(`--${needle.toString('utf8')}--`, 'utf8');
    // 逐字节扫过全部切点：needle 的每个内部位置都曾是块边界
    for (let split = 0; split < data.byteLength; split++) {
      const stream = Readable.from([data.subarray(0, split), data.subarray(split)]);
      const matched = await scanStreamForNeedles(stream, [needle]);
      expect([...matched]).toEqual([needle]);
    }
  });

  it('多个 needle 不同长度（含跨块命中的长 needle 与块内短 needle）', async () => {
    const long = Buffer.from('L'.repeat(37), 'utf8');
    const short = Buffer.from('short-needle', 'utf8');
    const absent = Buffer.from('absent'.repeat(4), 'utf8');
    const data = Buffer.from(
      `aaa${short.toString('utf8')}bbb${long.toString('utf8')}ccc`,
      'utf8',
    );
    const matched = await scanStreamForNeedles(chunked(data, 5), [long, short, absent]);
    expect(matched.has(long)).toBe(true);
    expect(matched.has(short)).toBe(true);
    expect(matched.has(absent)).toBe(false);
    expect(matched.size).toBe(2);
  });

  it('needle 出现在流开头与结尾（carry 边界）', async () => {
    const needle = Buffer.from('boundary-needle-1234', 'utf8');
    const head = Buffer.from(`${needle.toString('utf8')}tail`, 'utf8');
    const tail = Buffer.from(`head${needle.toString('utf8')}`, 'utf8');
    const headMatch = await scanStreamForNeedles(chunked(head, 3), [needle]);
    const tailMatch = await scanStreamForNeedles(chunked(tail, 3), [needle]);
    expect(headMatch.has(needle)).toBe(true);
    expect(tailMatch.has(needle)).toBe(true);
  });

  it('空 needle 与空列表返回空集合；未命中返回空集合', async () => {
    const data = Buffer.from('plain text body', 'utf8');
    const empty = await scanStreamForNeedles(Readable.from([data]), []);
    expect(empty.size).toBe(0);
    const zero = await scanStreamForNeedles(Readable.from([data]), [Buffer.alloc(0)]);
    expect(zero.size).toBe(0);
    const absent = await scanStreamForNeedles(Readable.from([data]), [Buffer.from('not-present-here')]);
    expect(absent.size).toBe(0);
  });

  it('全部 needle 命中后提前终止：不再拉取后续块', async () => {
    const needle = Buffer.from('stop-here-0123456789', 'utf8');
    const chunks = [
      Buffer.from(`xx${needle.toString('utf8')}xx`, 'utf8'),
      Buffer.alloc(1024, 1),
      Buffer.alloc(1024, 2),
    ];
    const pulled: Buffer[] = [];
    // 生成器按需拉取：消费方提前终止时，剩余块不再被拉出
    const source = Readable.from(
      (function* generate() {
        for (const chunk of chunks) {
          pulled.push(chunk);
          yield chunk;
        }
      })(),
    );
    const matched = await scanStreamForNeedles(source, [needle]);
    expect(matched.has(needle)).toBe(true);
    expect(pulled).toEqual([chunks[0]]);
  });
});
