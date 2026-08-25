import { describe, expect, it } from 'vitest';

import {
  buildBmcUrl,
  createBrowserTimeline,
  isViewerScreenshotEvent,
  shouldAllowCertificateError,
  viewerScreenshotPaths,
} from './browserCaptureCore';

describe('browserCaptureCore', () => {
  it('builds the BMC home URL from target connection fields', () => {
    expect(
      buildBmcUrl({
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      }),
    ).toBe('https://10.0.0.10:443/');
  });

  it('allows certificate errors for the target host, and for follow-up names when the target is an IP', () => {
    expect(
      shouldAllowCertificateError({
        targetHost: '10.0.0.10',
        url: 'https://10.0.0.10/login.html',
      }),
    ).toBe(true);
    expect(
      shouldAllowCertificateError({
        targetHost: '10.0.0.10',
        url: 'https://ibmc.local/login.html',
      }),
    ).toBe(true);
    expect(
      shouldAllowCertificateError({
        targetHost: 'bmc.example.com',
        url: 'https://other.example.com/login.html',
      }),
    ).toBe(false);
  });

  it('records navigation, hash changes, popup, storage, screenshot and selector events', () => {
    const timeline = createBrowserTimeline('job-001');

    timeline.recordNavigation('https://10.0.0.10/');
    timeline.recordHashChange('https://10.0.0.10/#/kvm');
    timeline.recordPopup({
      url: 'https://10.0.0.10/kvm.html',
      disposition: 'new-window',
    });
    timeline.recordStorageSnapshot({
      localStorageKeys: ['LOCAL_USERNAME'],
      sessionStorageKeys: ['QSESSIONID'],
    });
    timeline.recordScreenshot('page/screenshots/login.png', undefined, 'login');
    timeline.recordClick({
      selector: '#kvm',
      text: 'HTML5 KVM',
      tagName: 'button',
    });
    timeline.recordSelectorCandidates([
      {
        role: 'kvm-entry',
        selector: 'button[data-testid="kvm"]',
        confidence: 0.82,
      },
    ]);

    expect(timeline.toJSON()).toMatchObject({
      jobId: 'job-001',
      events: [
        { type: 'navigation', url: 'https://10.0.0.10/' },
        { type: 'hash-change', url: 'https://10.0.0.10/#/kvm' },
        { type: 'popup', url: 'https://10.0.0.10/kvm.html' },
        { type: 'storage-snapshot' },
        { type: 'screenshot', path: 'page/screenshots/login.png', role: 'login' },
        { type: 'click', selector: '#kvm' },
        { type: 'selector-candidates' },
      ],
    });
  });

  it('treats only role=viewer screenshot events as KVM viewer evidence', () => {
    expect(isViewerScreenshotEvent({ type: 'screenshot', role: 'viewer' })).toBe(true);
    expect(isViewerScreenshotEvent({ type: 'screenshot', role: 'login' })).toBe(false);
    expect(isViewerScreenshotEvent({ type: 'screenshot' })).toBe(false);
    expect(
      viewerScreenshotPaths([
        { type: 'screenshot', role: 'login', path: 'page/screenshots/login.png' },
        { type: 'screenshot', role: 'viewer', path: 'page/screenshots/viewer.png' },
        { type: 'screenshot', path: 'page/screenshots/unlabeled.png' },
      ]),
    ).toEqual(['page/screenshots/viewer.png']);
  });
});
