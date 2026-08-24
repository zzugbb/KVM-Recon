import { describe, expect, it } from 'vitest';

import { createCaptureLogger } from './createCaptureLogger';

describe('createCaptureLogger', () => {
  it('redacts password, cookie, and token fields from log lines', () => {
    const lines: string[] = [];
    const logger = createCaptureLogger(line => lines.push(line));

    logger.info('export-start', {
      host: '10.0.0.10',
      password: 'secret-password',
      cookie: 'QSESSIONID=abc123',
      token: 'kvm-token',
    });

    expect(lines[0]).toContain('[kvm-recon] export-start');
    expect(lines[0]).toContain('10.0.0.10');
    expect(lines[0]).not.toContain('secret-password');
    expect(lines[0]).not.toContain('abc123');
    expect(lines[0]).not.toContain('kvm-token');
    expect(lines[0]).toContain('<redacted:sha256:');
  });
});
