export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function headersValue(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, nextValue]) => [key, nextValue]),
  );
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

export function protocolList(headers: Record<string, string>): string[] {
  const protocolHeader = headerValue(headers, 'sec-websocket-protocol');
  if (!protocolHeader) return [];
  return protocolHeader
    .split(',')
    .map(protocol => protocol.trim())
    .filter(Boolean);
}

export function scopedId(requestId: string, sessionId?: string): string {
  return sessionId ? `${sessionId}::${requestId}` : requestId;
}

/** 用作目录名的通道 ID：去掉 CDP session 分隔符等非法路径字符。 */
export function safeFsId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (!safe) throw new Error(`无法派生安全 ID：${id}`);
  return safe;
}

export function decodeCdpBody(result: unknown): Buffer {
  if (!isRecord(result)) return Buffer.alloc(0);
  const body = stringValue(result.body);
  if (result.base64Encoded === true) {
    return Buffer.from(body, 'base64');
  }
  return Buffer.from(body, 'utf8');
}
