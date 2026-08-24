import type { CapturePackArtifact } from '../capture-pack/types';

export interface OperatorObservedAsset {
  vendor: string;
  product: string;
  firmware: string;
  location: string;
  note: string;
}

const MAX_FIELD_LENGTH = 80;

export function normalizeOperatorObserved(
  input?: Partial<OperatorObservedAsset> | null,
): OperatorObservedAsset {
  return {
    vendor: trimObservedField(input?.vendor),
    product: trimObservedField(input?.product),
    firmware: trimObservedField(input?.firmware),
    location: trimObservedField(input?.location),
    note: trimObservedField(input?.note),
  };
}

export function hasStructuredObserved(input: OperatorObservedAsset): boolean {
  return Boolean(input.vendor || input.product || input.firmware || input.location);
}

export function hasOperatorObserved(input: OperatorObservedAsset): boolean {
  return hasStructuredObserved(input) || Boolean(input.note);
}

export function observedForManifest(input: OperatorObservedAsset) {
  if (!hasStructuredObserved(input)) return undefined;
  return {
    vendor: input.vendor,
    product: input.product,
    firmware: input.firmware,
    location: input.location,
  };
}

export function buildOperatorObservedArtifact(
  input: OperatorObservedAsset,
): CapturePackArtifact | null {
  if (!hasOperatorObserved(input)) return null;
  return {
    path: 'probe/operator-observed.json',
    content: JSON.stringify(
      {
        source: 'operator',
        vendor: input.vendor,
        product: input.product,
        firmware: input.firmware,
        location: input.location,
        note: input.note,
      },
      null,
      2,
    ),
  };
}

function trimObservedField(value?: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
}
