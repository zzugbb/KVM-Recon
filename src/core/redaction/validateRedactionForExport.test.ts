import { describe, expect, it } from 'vitest';

import { redactSensitiveData } from './redactSensitiveData';
import { validateRedactionForExport } from './validateRedactionForExport';

describe('validateRedactionForExport', () => {
  it('passes when redacted data no longer contains sensitive plaintext', () => {
    const redacted = redactSensitiveData({
      Password: 'secret-password',
      token: 'token-123',
    });

    expect(
      validateRedactionForExport({
        data: redacted.data,
        sensitiveValues: ['secret-password', 'token-123'],
        redactedFields: redacted.redactedFields,
      }),
    ).toEqual({
      status: 'pass',
      redactedFields: 2,
      leaks: [],
      canExportSafePack: true,
    });
  });

  it('fails when sensitive plaintext remains in export data', () => {
    expect(
      validateRedactionForExport({
        data: {
          rawPassword: 'secret-password',
        },
        sensitiveValues: ['secret-password'],
        redactedFields: 0,
      }),
    ).toEqual({
      status: 'fail',
      redactedFields: 0,
      leaks: ['secret-password'],
      canExportSafePack: false,
    });
  });
});
