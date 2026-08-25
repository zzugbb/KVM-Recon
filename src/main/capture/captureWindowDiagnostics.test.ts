import { describe, expect, it } from 'vitest';

import { getCaptureWindowLogs, recordCaptureWindowLog } from './captureWindowDiagnostics';

describe('captureWindowDiagnostics', () => {
  it('keeps recent capture window log lines for the diagnostics dialog', () => {
    recordCaptureWindowLog('capture-window-fail-load -3 ERR_CERT_AUTHORITY_INVALID https://10.0.0.10/');
    expect(getCaptureWindowLogs()).toContain('ERR_CERT_AUTHORITY_INVALID');
  });
});
