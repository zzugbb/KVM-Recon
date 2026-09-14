import { describe, expect, it } from 'vitest';

import { buildBrowserArtifacts } from './buildBrowserArtifacts';
import { createBrowserTimeline } from './browserCaptureCore';

describe('buildBrowserArtifacts', () => {
  it('serializes timeline, storage, selectors, and screenshot references', () => {
    const timeline = createBrowserTimeline('job-001');
    timeline.recordNavigation('https://10.0.0.10/');
    timeline.recordStorageSnapshot({
      localStorageKeys: ['LOCAL_USERNAME'],
      sessionStorageKeys: ['QSESSIONID'],
    });
    timeline.recordScreenshot('/tmp/kvm-recon/login.png', '/tmp/kvm-recon/login.png');
    timeline.recordSelectorCandidates([
      {
        role: 'kvm-entry',
        selector: 'button[data-testid="kvm"]',
        confidence: 0.8,
      },
    ]);

    const artifacts = buildBrowserArtifacts(timeline.toJSON());

    expect(artifacts.map(artifact => artifact.path).sort()).toEqual([
      'page/screenshots.json',
      'page/selectors.json',
      'page/storage.json',
      'page/timeline.jsonl',
    ]);
    expect(
      artifacts.find(artifact => artifact.path === 'page/timeline.jsonl')!.content.trim().split('\n'),
    ).toHaveLength(4);
    expect(JSON.parse(artifacts.find(artifact => artifact.path === 'page/storage.json')!.content)).toEqual({
      localStorageKeys: ['LOCAL_USERNAME'],
      sessionStorageKeys: ['QSESSIONID'],
      localStorageAdded: [],
      localStorageRemoved: [],
      sessionStorageAdded: [],
      sessionStorageRemoved: [],
      windowRole: 'main',
      windowRoles: ['main'],
      snapshots: [
        {
          windowRole: 'main',
          captureRole: 'unknown',
          localStorageKeys: ['LOCAL_USERNAME'],
          sessionStorageKeys: ['QSESSIONID'],
          localStorageAdded: [],
          localStorageRemoved: [],
          sessionStorageAdded: [],
          sessionStorageRemoved: [],
        },
      ],
    });
    expect(JSON.parse(artifacts.find(artifact => artifact.path === 'page/screenshots.json')!.content)).toEqual([
      { path: 'page/screenshots/login.png', role: 'unknown', windowRole: 'main' },
    ]);
    expect(JSON.parse(artifacts.find(artifact => artifact.path === 'page/selectors.json')!.content)).toEqual([
      {
        role: 'kvm-entry',
        selector: 'button[data-testid="kvm"]',
        confidence: 0.8,
        windowRole: 'main',
        captureRole: 'unknown',
      },
    ]);
    expect(artifacts.find(artifact => artifact.path === 'page/timeline.jsonl')!.content).not.toContain(
      '/tmp/kvm-recon/login.png',
    );
  });

  it('aggregates and deduplicates storage and selectors across page roles and windows', () => {
    const timeline = createBrowserTimeline('job-aggregate');
    timeline.recordStorageSnapshot({
      localStorageKeys: ['LOGIN_NAME'],
      sessionStorageKeys: ['SESSION'],
      windowRole: 'main',
      captureRole: 'login',
    });
    timeline.recordStorageSnapshot({
      localStorageKeys: ['VIEWER_STATE', 'LOGIN_NAME'],
      sessionStorageKeys: ['KVM_TOKEN'],
      windowRole: 'popup',
      captureRole: 'viewer',
    });
    timeline.recordSelectorCandidates(
      [{ role: 'login', selector: '#login', confidence: 0.7 }],
      'main',
      'login',
    );
    timeline.recordSelectorCandidates(
      [
        { role: 'viewer', selector: 'iframe', confidence: 0.5 },
        { role: 'viewer', selector: 'iframe', confidence: 0.8 },
      ],
      'popup',
      'viewer',
    );

    const artifacts = buildBrowserArtifacts(timeline.toJSON());
    const storage = JSON.parse(
      artifacts.find(artifact => artifact.path === 'page/storage.json')!.content,
    );
    const selectors = JSON.parse(
      artifacts.find(artifact => artifact.path === 'page/selectors.json')!.content,
    );

    expect(storage.localStorageKeys).toEqual(['LOGIN_NAME', 'VIEWER_STATE']);
    expect(storage.windowRoles).toEqual(['main', 'popup']);
    expect(storage.snapshots).toHaveLength(2);
    expect(selectors).toEqual([
      {
        role: 'login',
        selector: '#login',
        confidence: 0.7,
        windowRole: 'main',
        captureRole: 'login',
      },
      {
        role: 'viewer',
        selector: 'iframe',
        confidence: 0.8,
        windowRole: 'popup',
        captureRole: 'viewer',
      },
    ]);
  });

  it('keeps storage snapshots from two popups with different captureWindowId separate', () => {
    const timeline = createBrowserTimeline('job-two-popups');
    timeline.recordStorageSnapshot({
      localStorageKeys: ['KVM_TOKEN'],
      sessionStorageKeys: [],
      windowRole: 'popup',
      captureRole: 'viewer',
      captureWindowId: 'popup-kvm',
    });
    timeline.recordStorageSnapshot({
      localStorageKeys: ['HELP_PAGE'],
      sessionStorageKeys: [],
      windowRole: 'popup',
      captureRole: 'viewer',
      captureWindowId: 'popup-help',
    });

    const storage = JSON.parse(
      buildBrowserArtifacts(timeline.toJSON()).find(artifact => artifact.path === 'page/storage.json')!
        .content,
    );
    expect(storage.captureWindowIds).toEqual(['popup-kvm', 'popup-help']);
    expect(storage.snapshots).toEqual([
      expect.objectContaining({
        windowRole: 'popup',
        captureWindowId: 'popup-kvm',
        localStorageKeys: ['KVM_TOKEN'],
      }),
      expect.objectContaining({
        windowRole: 'popup',
        captureWindowId: 'popup-help',
        localStorageKeys: ['HELP_PAGE'],
      }),
    ]);
  });
});
