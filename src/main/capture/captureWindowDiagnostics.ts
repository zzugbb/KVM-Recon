const MAX_LINES = 80;
const lines: string[] = [];
const captureSessions = new WeakSet<object>();

export function registerCaptureSession(session: object) {
  captureSessions.add(session);
}

export function isCaptureSession(session: object) {
  return captureSessions.has(session);
}

export function recordCaptureWindowLog(line: string) {
  const entry = `${new Date().toISOString()} ${line}`;
  lines.push(entry);
  if (lines.length > MAX_LINES) {
    lines.shift();
  }
  console.error(`[kvm-recon] ${line}`);
}

export function getCaptureWindowLogs() {
  return lines.join('\n');
}
