import { describe, expect, it } from 'vitest';

import {
  assertNoSensitivePlaintext,
  redactSensitiveData,
} from './redactSensitiveData';

describe('redactSensitiveData', () => {
  it('redacts nested sensitive fields while preserving safe values', () => {
    const result = redactSensitiveData({
      requestHeaders: {
        Cookie: 'QSESSIONID=abc123; theme=dark',
        'X-Auth-Token': 'token-123',
        Accept: 'application/json',
      },
      requestBody: {
        UserName: 'Administrator',
        Password: 'secret-password',
        nested: {
          csrfToken: 'csrf-123',
          authParam: 'auth-param-123',
        },
      },
      storage: {
        LOCAL_USERNAME: 'Administrator',
        UNIQUEID: 'unique-123',
      },
    });

    expect(result.redactedFields).toBe(6);
    expect(result.data.requestHeaders.Accept).toBe('application/json');
    expect(result.data.requestBody.UserName).toBe('Administrator');
    expect(JSON.stringify(result.data)).not.toContain('secret-password');
    expect(JSON.stringify(result.data)).not.toContain('token-123');
    expect(JSON.stringify(result.data)).not.toContain('csrf-123');
    expect(JSON.stringify(result.data)).toContain('<redacted:sha256:');
  });

  it('reports unsafe plaintext when known sensitive values remain', () => {
    const safe = redactSensitiveData({
      password: 'secret-password',
      token: 'token-123',
      visible: 'keep-me',
    });

    expect(assertNoSensitivePlaintext(safe.data, ['secret-password', 'token-123'])).toEqual({
      ok: true,
      leaks: [],
    });
    expect(assertNoSensitivePlaintext({ raw: 'secret-password' }, ['secret-password'])).toEqual({
      ok: false,
      leaks: ['secret-password'],
    });
  });
});
