import { describe, expect, it } from 'vitest';

import { readReadmePreview } from './readmePreview';

describe('readmePreview', () => {
  it('stays off unless the README screenshot query is present', () => {
    expect(readReadmePreview()).toBeNull();
  });
});
