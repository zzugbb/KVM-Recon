import { describe, expect, it } from 'vitest';

import {
  assertNoSensitivePlaintext,
  redactSensitiveData,
  redactUrl,
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
    expect(result.data.requestHeaders.Cookie).toContain('QSESSIONID=');
    expect(result.data.requestHeaders.Cookie).toContain('theme=');
    expect(result.data.requestBody.UserName).toBe('Administrator');
    expect(JSON.stringify(result.data)).not.toContain('secret-password');
    expect(JSON.stringify(result.data)).not.toContain('token-123');
    expect(JSON.stringify(result.data)).not.toContain('csrf-123');
    expect(JSON.stringify(result.data)).not.toContain('abc123');
    expect(JSON.stringify(result.data)).toContain('<redacted:sha256:');
  });

  it('redacts sensitive URL query values while keeping parameter names', () => {
    expect(redactUrl('https://bmc.example/kvm?token=secret-token&view=html5')).toContain('view=html5');
    expect(redactUrl('https://bmc.example/kvm?token=secret-token&view=html5')).not.toContain('secret-token');
    expect(redactUrl('https://bmc.example/kvm')).toBe('https://bmc.example/kvm');
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
