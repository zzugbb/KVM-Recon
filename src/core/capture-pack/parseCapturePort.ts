export function parseCapturePort(value: string | number): number | null {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}
