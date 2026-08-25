import { describe, expect, it } from 'vitest';

import { isIpHost, tlsServerName } from './tlsServerName';

describe('tlsServerName', () => {
  it('disables SNI for IP addresses and keeps DNS names', () => {
    expect(isIpHost('10.128.6.235')).toBe(true);
    expect(tlsServerName('10.128.6.235')).toBe('');
    expect(isIpHost('bmc.example')).toBe(false);
    expect(tlsServerName('bmc.example')).toBe('bmc.example');
  });
});
