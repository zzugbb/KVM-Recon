import { describe, expect, it } from 'vitest';

import { popupWindowFacts } from './popupWindowFacts';

describe('popupWindowFacts', () => {
  it('keeps concurrent popups from sharing a global pending URL', () => {
    const kvm = popupWindowFacts({
      childCaptureWindowId: 'popup-kvm',
      openerCaptureWindowId: 'win-main',
      details: {
        url: 'https://10.0.0.10/kvm.html',
        disposition: 'new-window',
      },
    });
    const help = popupWindowFacts({
      childCaptureWindowId: 'popup-help',
      openerCaptureWindowId: 'win-main',
      details: {
        url: 'https://10.0.0.10/help.html',
        disposition: 'foreground-tab',
      },
    });

    expect(kvm).toMatchObject({
      url: 'https://10.0.0.10/kvm.html',
      captureWindowId: 'popup-kvm',
      openerCaptureWindowId: 'win-main',
      disposition: 'new-window',
    });
    expect(help).toMatchObject({
      url: 'https://10.0.0.10/help.html',
      captureWindowId: 'popup-help',
      openerCaptureWindowId: 'win-main',
      disposition: 'foreground-tab',
    });
  });

  it('records nested popups against the immediate opener window', () => {
    const nested = popupWindowFacts({
      childCaptureWindowId: 'popup-nested',
      openerCaptureWindowId: 'popup-kvm',
      openerAncestorCaptureWindowIds: ['win-main'],
      details: {
        url: 'https://10.0.0.10/viewer.html',
      },
      fallbackUrl: 'about:blank',
    });

    expect(nested).toMatchObject({
      url: 'https://10.0.0.10/viewer.html',
      captureWindowId: 'popup-nested',
      openerCaptureWindowId: 'popup-kvm',
      ancestorCaptureWindowIds: ['popup-kvm', 'win-main'],
      windowRole: 'popup',
    });
  });
});
