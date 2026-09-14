import { describe, expect, it } from 'vitest';

import { parseCapturePort } from './parseCapturePort';

describe('parseCapturePort', () => {
  it.each(['', '0', '65536', '-1', '443.5', '1e3', 'abc'])(
    'rejects invalid port %j',
    value => {
      expect(parseCapturePort(value)).toBeNull();
    },
  );

  it.each([
    ['1', 1],
    ['443', 443],
    [65535, 65535],
  ])('accepts valid port %j', (value, expected) => {
    expect(parseCapturePort(value)).toBe(expected);
  });
});
