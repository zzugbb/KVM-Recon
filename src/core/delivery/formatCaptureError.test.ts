import { describe, expect, it } from 'vitest';

import { classifyCaptureError, formatCaptureError } from './formatCaptureError';

describe('formatCaptureError', () => {
  it('formats network failures into a field-friendly message', () => {
    expect(
      formatCaptureError({
        code: 'BMC_UNREACHABLE',
        detail: 'connect ETIMEDOUT 10.0.0.10:443',
      }),
    ).toEqual({
      title: '无法连接目标 BMC',
      impact: '当前无法采集登录、KVM 入口和 WebSocket 资料，建议不要离场。',
      action: '请现场确认 BMC 地址、端口、网线/VLAN、防火墙和本机网络连通性后重试。',
      detail: 'connect ETIMEDOUT 10.0.0.10:443',
    });
  });

  it('formats permission limitations without exposing stack traces', () => {
    expect(
      formatCaptureError({
        code: 'PERMISSION_LIMITED',
        detail: 'EPERM: operation not permitted, open /restricted/capture.zip',
      }),
    ).toMatchObject({
      title: '当前权限不足',
      action: expect.stringContaining('可写目录'),
    });
  });
});

describe('classifyCaptureError', () => {
  it('maps permission and certificate failures to field-facing codes', () => {
    expect(classifyCaptureError(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))).toBe(
      'PERMISSION_LIMITED',
    );
    expect(classifyCaptureError(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe('CERTIFICATE_BLOCKED');
    expect(classifyCaptureError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe(
      'BMC_UNREACHABLE',
    );
    expect(classifyCaptureError(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }))).toBe(
      'EXPORT_FAILED',
    );
  });
});

describe('export and redaction recovery text', () => {
  it('does not name the PARTIAL-only button when asking the operator to retry export', () => {
    expect(formatCaptureError({ code: 'EXPORT_FAILED' }).action).toContain('重新导出 Capture Pack');
    expect(formatCaptureError({ code: 'EXPORT_FAILED' }).action).not.toContain('停止采集并导出');
    expect(formatCaptureError({ code: 'REDACTION_FAILED' }).action).toContain('再导出 Capture Pack');
    expect(formatCaptureError({ code: 'REDACTION_FAILED' }).action).not.toContain('停止采集并导出');
  });
});
