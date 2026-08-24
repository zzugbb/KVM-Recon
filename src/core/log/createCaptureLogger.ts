import { redactSensitiveData } from '../redaction/redactSensitiveData';

interface CaptureLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}

export function createCaptureLogger(
  write: (line: string) => void = line => console.info(line),
): CaptureLogger {
  return {
    info(event: string, fields: Record<string, unknown> = {}) {
      const safeFields = redactSensitiveData(asJson(fields)).data;
      write(`[kvm-recon] ${event} ${JSON.stringify(safeFields)}`);
    },
  };
}

function asJson(value: Record<string, unknown>): { [key: string]: string | number | boolean | null } {
  const data: { [key: string]: string | number | boolean | null } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      data[key] = item;
    } else {
      data[key] = JSON.stringify(item);
    }
  }
  return data;
}
