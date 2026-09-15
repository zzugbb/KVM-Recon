import { describe, expect, it } from 'vitest';

import { shouldCommitAboutBlankBeforeCdp } from './cdpRendererReady';

describe('shouldCommitAboutBlankBeforeCdp', () => {
  it('loads about:blank for an empty main capture window before Network.enable', () => {
    expect(
      shouldCommitAboutBlankBeforeCdp({ windowRole: 'main', url: '' }),
    ).toBe(true);
    expect(
      shouldCommitAboutBlankBeforeCdp({ windowRole: 'main', url: 'about:blank' }),
    ).toBe(true);
  });

  it('does not replace a popup or BMC navigation with about:blank', () => {
    expect(
      shouldCommitAboutBlankBeforeCdp({
        windowRole: 'popup',
        url: '',
      }),
    ).toBe(false);
    expect(
      shouldCommitAboutBlankBeforeCdp({
        windowRole: 'main',
        url: 'https://10.10.8.94/',
      }),
    ).toBe(false);
  });
});
