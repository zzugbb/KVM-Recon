/**
 * 正文 needle 分块滚动扫描（阶段 6 刀 1）。
 *
 * 干草堆侧（响应 / 请求正文）逐块流式扫描：块重叠 = 最长 needle − 1，
 * 跨块边界的命中不丢失；全部 needle 命中后提前终止读取。内存上界 =
 * 块大小 + 最长 needle，绝不整体载入正文。
 * 纯扫描原语：needle 长于正文总字节数的预筛由调用方（持有 BodyRef.bytes）
 * 完成；此处只保证「正文里存在的 needle 一定命中」。
 */

import type { Readable } from 'node:stream';

/**
 * 分块扫描字节流，返回命中的 needle 引用集合（按 needles 内的对象同一性）。
 * 空 needle 与空列表返回空集合；源流读取失败时抛错（由调用方记账降级）。
 */
export async function scanStreamForNeedles(
  source: Readable,
  needles: ReadonlyArray<Buffer>,
): Promise<ReadonlySet<Buffer>> {
  const matched = new Set<Buffer>();
  let pending = needles.filter(needle => needle.byteLength > 0);
  if (pending.length === 0) return matched;
  const overlap = Math.max(...pending.map(needle => needle.byteLength)) - 1;
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    const piece = chunk as Buffer;
    const window = carry.length === 0 ? piece : Buffer.concat([carry, piece]);
    for (const needle of [...pending]) {
      if (window.indexOf(needle) >= 0) {
        matched.add(needle);
        pending = pending.filter(candidate => candidate !== needle);
      }
    }
    if (pending.length === 0) return matched;
    carry = window.subarray(Math.max(0, window.length - overlap));
  }
  return matched;
}
