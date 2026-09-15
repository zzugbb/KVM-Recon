import { describe, expect, it } from 'vitest';

import {
  packRequiresReferencedRequiredField,
  referencedSourceIsRequired,
} from './packVersionContract';

describe('packVersionContract', () => {
  it('requires referenced.required from 0.2.7 and unknown versions', () => {
    expect(packRequiresReferencedRequiredField('0.2.7')).toBe(true);
    expect(packRequiresReferencedRequiredField('0.3.0')).toBe(true);
    expect(packRequiresReferencedRequiredField('1.0.0')).toBe(true);
    expect(packRequiresReferencedRequiredField('')).toBe(true);
    expect(packRequiresReferencedRequiredField('dev')).toBe(true);
  });

  it('keeps pre-0.2.7 packs on the legacy compatibility path', () => {
    expect(packRequiresReferencedRequiredField('0.2.6')).toBe(false);
    expect(packRequiresReferencedRequiredField('0.2.5')).toBe(false);
  });

  it('treats a missing required flag as critical', () => {
    expect(referencedSourceIsRequired(true)).toBe(true);
    expect(referencedSourceIsRequired(false)).toBe(false);
    expect(referencedSourceIsRequired(undefined)).toBe(true);
  });
});
