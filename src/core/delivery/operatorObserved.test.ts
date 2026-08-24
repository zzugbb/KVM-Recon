import { describe, expect, it } from 'vitest';

import {
  buildOperatorObservedArtifact,
  hasStructuredObserved,
  normalizeOperatorObserved,
  observedForManifest,
} from './operatorObserved';

describe('operatorObserved', () => {
  it('trims and caps field length without inventing a kvmFamily', () => {
    const observed = normalizeOperatorObserved({
      vendor: '  Huawei  ',
      product: `${'X'.repeat(100)}`,
      firmware: 'iBMC 3.10',
      location: 'A柜 U12',
      note: '面板铭牌',
    });

    expect(observed.vendor).toBe('Huawei');
    expect(observed.product).toHaveLength(80);
    expect(hasStructuredObserved(observed)).toBe(true);
    expect(observedForManifest(observed)).toEqual({
      vendor: 'Huawei',
      product: observed.product,
      firmware: 'iBMC 3.10',
      location: 'A柜 U12',
    });
    expect(JSON.parse(String(buildOperatorObservedArtifact(observed)?.content || '{}'))).toMatchObject({
      source: 'operator',
      vendor: 'Huawei',
      note: '面板铭牌',
    });
  });

  it('omits the artifact and manifest observed object when only empty strings are given', () => {
    const observed = normalizeOperatorObserved({
      vendor: '   ',
      product: '',
      note: '',
    });
    expect(hasStructuredObserved(observed)).toBe(false);
    expect(observedForManifest(observed)).toBeUndefined();
    expect(buildOperatorObservedArtifact(observed)).toBeNull();
  });
});
