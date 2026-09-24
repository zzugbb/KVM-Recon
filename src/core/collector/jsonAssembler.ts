/**
 * 最小 JSON 装配器：吃 stream-json token，吐一个 JS 值。
 *
 * 仅用于单个数组元素 / 单个顶层字段的内存装配（每个元素装配完即交付，
 * 不承载无界数据——元素级内存上界 = 最大单个元素）。
 *
 * stream-json 对每个字符串/数字同时发 chunked 形式
 * （startString/stringChunk/endString 等）与装配后的 collapsed
 * 值（stringValue/numberValue）；此处只消费 collapsed 值，
 * chunked token 一律忽略，否则同一值会被装配两次。
 */

import type { Token } from './streamJsonTypes';

export class JsonAssembler {
  private stack: Array<Record<string, unknown> | unknown[]> = [];
  private keys: Array<string | null> = [];
  private current: unknown = null;
  private key: string | null = null;
  private started = false;
  done = false;

  consume(tok: Token): void {
    switch (tok.name) {
      case 'startObject':
        this.beginContainer({});
        return;
      case 'startArray':
        this.beginContainer([]);
        return;
      case 'endObject':
      case 'endArray':
        this.endContainer();
        return;
      case 'keyValue':
        this.key = String(tok.value);
        return;
      case 'stringValue':
        this.save(String(tok.value));
        return;
      case 'numberValue':
        this.save(parseFloat(String(tok.value)));
        return;
      case 'nullValue':
        this.save(null);
        return;
      case 'trueValue':
        this.save(true);
        return;
      case 'falseValue':
        this.save(false);
        return;
      default:
        // chunked token（startString 等）与未知 token 忽略（前向兼容；
        // 装配失败会在 done 检查处暴露）
        return;
    }
  }

  private beginContainer(container: Record<string, unknown> | unknown[]): void {
    if (!this.started) {
      this.started = true;
      this.current = container;
      this.key = null;
      return;
    }
    this.stack.push(this.current as Record<string, unknown> | unknown[]);
    this.keys.push(this.key);
    this.current = container;
    this.key = null;
  }

  private attach(value: unknown): void {
    const top = this.current;
    if (Array.isArray(top)) {
      top.push(value);
    } else if (top && typeof top === 'object') {
      (top as Record<string, unknown>)[this.key ?? ''] = value;
    }
    this.key = null;
  }

  /** 装配完成的值（done 为 true 时有效）。 */
  get value(): unknown {
    return this.current;
  }

  private save(value: unknown): void {
    if (!this.started) {
      // 根为标量：装配立即完成
      this.started = true;
      this.current = value;
      this.done = true;
      return;
    }
    this.attach(value);
  }

  private endContainer(): void {
    if (this.stack.length === 0) {
      this.done = true;
      this.key = null;
      return;
    }
    const finished = this.current;
    this.current = this.stack.pop();
    this.key = this.keys.pop() ?? null;
    this.attach(finished);
  }
}
