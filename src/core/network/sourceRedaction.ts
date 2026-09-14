import { createHash } from 'node:crypto';

import { redactSensitiveData, redactUrl } from '../redaction/redactSensitiveData';

export function redactSourceText(text: string, limit = Number.POSITIVE_INFINITY) {
  const redacted = redactUrl(text).replace(
    /((?:password|passwd|pwd|token|csrf|cookie|sessionid|session_id|authparam|garc|x-auth-token)=)([^&;\s]+)/gi,
    (_match, prefix, value) => `${prefix}${redactSensitiveData({ value }).data.value}`,
  );
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit)}<truncated>`;
}

export function sha256Hex(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
