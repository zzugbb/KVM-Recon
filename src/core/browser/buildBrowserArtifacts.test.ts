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
    timeline.recordScreenshot('/tmp/kvm-recon/login.png');
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
    });
    expect(JSON.parse(artifacts.find(artifact => artifact.path === 'page/screenshots.json')!.content)).toEqual([
      '/tmp/kvm-recon/login.png',
    ]);
  });
});
