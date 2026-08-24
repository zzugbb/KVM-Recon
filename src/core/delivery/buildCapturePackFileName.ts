import type { CaptureReadiness } from '../capture-pack/types';

interface BuildCapturePackFileNameInput {
  startedAt: string;
  targetHost: string;
  kvmFamily: string;
  readiness: CaptureReadiness;
}

function dateSegment(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return 'unknown-time';
  const [, year, month, day, hour, minute, second] = match;
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'unknown'
  );
}

export function buildCapturePackFileName(input: BuildCapturePackFileNameInput): string {
  return [
    'KVM-Recon',
    dateSegment(input.startedAt),
    safeSegment(input.targetHost),
    safeSegment(input.kvmFamily),
    input.readiness,
  ].join('_') + '.zip';
}
