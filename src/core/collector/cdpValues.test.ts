import { describe, expect, it } from 'vitest';

import { decodeCdpBody } from './cdpValues';

describe('CDP 正文解码', () => {
  it('空字符串是有效的零字节正文', () => {
    expect(decodeCdpBody({ body: '', base64Encoded: false })).toHaveLength(0);
  });

  it('缺失正文或损坏的 base64 不得变成已留存的空正文', () => {
    expect(() => decodeCdpBody({})).toThrow('缺少 body');
    expect(() => decodeCdpBody({ body: 0 })).toThrow('缺少 body');
    expect(() => decodeCdpBody({ body: '@@', base64Encoded: true })).toThrow('base64 编码无效');
  });
});
