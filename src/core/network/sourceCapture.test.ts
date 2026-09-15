import { describe, expect, it } from 'vitest';

import type { HttpRequestRecord } from './createNetworkRecorder';
import {
  adapterSourceCandidates,
  adapterSourceCoverage,
  classifySourceKind,
  isCompleteAdapterSource,
  isJavascriptSourceText,
  pageReferencedScriptsFromEvents,
} from './sourceCapture';

function request(extra: Partial<HttpRequestRecord> & Pick<HttpRequestRecord, 'id' | 'url'>): HttpRequestRecord {
  return {
    timestamp: '2026-09-14T12:00:00.000+08:00',
    method: 'GET',
    resourceType: 'xhr',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBodySummary: { bytes: 0, redactedFields: [] },
    responseBodySummary: { bytes: 0, redactedFields: [] },
    tags: [],
    ...extra,
  };
}

describe('sourceCapture', () => {
  it('treats CDP Script and IIFE bundles as JavaScript even with a wrong MIME type', () => {
    expect(isJavascriptSourceText('(()=>{window.kvm=1})()', 'application/octet-stream', 'Script')).toBe(
      true,
    );
    expect(isJavascriptSourceText('!function(e){e.kvm=1}(window)', 'text/plain', 'script')).toBe(true);
    expect(classifySourceKind('(()=>{window.kvm=1})()', 'application/octet-stream', 'Script')).toBe(
      'javascript',
    );
  });

  it('does not treat an XHR .js URL as adapter source unless it is a script or JS MIME', () => {
    const xhr = request({
      id: 'kvmclient',
      url: 'https://10.10.8.107/bmc/resources/js/module/remote/html5/kvmclient.js',
      resourceType: 'xhr',
      tags: ['kvm-entry'],
    });
    expect(
      adapterSourceCandidates([xhr], { host: '10.10.8.107', unclassified: false }),
    ).toEqual([]);
    expect(
      adapterSourceCandidates([xhr], { host: '10.10.8.107', unclassified: true }),
    ).toEqual([]);
  });

  it('does not require homepage hashed chunks for unclassified families', () => {
    const chunk = request({
      id: 'chunk',
      url: 'https://bmc.example/static/js/8f3a21.chunk.js',
      resourceType: 'script',
      responseContentType: 'application/javascript',
    });
    const jquery = request({
      id: 'jquery',
      url: 'https://bmc.example/js/jquery.min.js',
      resourceType: 'script',
    });
    const home = request({
      id: 'home',
      url: 'https://bmc.example/assets/app.home.js',
      resourceType: 'script',
      windowRole: 'main',
    });
    expect(adapterSourceCandidates([chunk, jquery, home], { host: 'bmc.example', unclassified: false })).toEqual(
      [],
    );
    expect(
      adapterSourceCandidates([chunk, jquery, home], { host: 'bmc.example', unclassified: true }).map(
        item => item.id,
      ),
    ).toEqual([]);
  });

  it('requires viewer primary bundles and workers, not every first-party script', () => {
    const homeScripts = Array.from({ length: 40 }, (_, index) =>
      request({
        id: `home-${index}`,
        url: `https://10.10.8.101/static/js/${index}.chunk.js`,
        resourceType: 'script',
        windowRole: 'main',
        responseBodyCaptured: false,
        sourceTruncated: true,
      }),
    );
    const main = request({
      id: 'main',
      url: 'https://10.10.8.101/vmc/vconsole/main.36508cda.js',
      resourceType: 'script',
      windowRole: 'popup',
      captureWindowId: 'popup-kvm',
      responseBodyCaptured: true,
      sourceSha256: 'a'.repeat(64),
      sourceBytes: 1200,
      sourceTruncated: false,
      responseBodySummary: { bytes: 1200, redactedFields: [], sample: `function startKvm(){${'A'.repeat(64)}}` },
    });
    const worker = request({
      id: 'worker',
      url: 'https://10.10.8.101/vmc/vconsole/file.worker.js',
      resourceType: 'script',
      windowRole: 'popup',
      captureWindowId: 'popup-kvm',
      responseBodyCaptured: true,
      sourceSha256: 'd'.repeat(64),
      sourceBytes: 1200,
      sourceTruncated: false,
      responseBodySummary: { bytes: 1200, redactedFields: [], sample: `self.onmessage=function(){${'A'.repeat(64)}}` },
    });
    expect(
      adapterSourceCandidates([...homeScripts, main, worker], {
        host: '10.10.8.101',
        unclassified: true,
      }).map(item => item.id),
    ).toEqual(['main', 'worker']);
  });

  it('rejects truncated prefixes even when the sample is longer than 32 characters', () => {
    expect(
      isCompleteAdapterSource(
        request({
          id: 'viewer',
          url: 'https://bmc.example/html5viewer.js',
          resourceType: 'script',
          responseBodySummary: {
            bytes: 65536,
            redactedFields: [],
            sample: `${'A'.repeat(64)}<truncated>`,
          },
          sourceSha256: 'abc',
          sourceBytes: 65536,
          sourceTruncated: true,
        }),
      ),
    ).toBe(false);
  });

  it('marks referenced main/polyfill missing when only a worker was captured', () => {
    const worker = request({
      id: 'worker',
      url: 'https://10.10.8.101/vmc/vconsole/file.worker.js',
      resourceType: 'script',
      responseContentType: 'application/javascript',
      responseBodyCaptured: true,
      sourceSha256: 'd'.repeat(64),
      sourceBytes: 1200,
      sourceTruncated: false,
      responseBodySummary: {
        bytes: 1200,
        redactedFields: [],
        sample: `self.onmessage=function(){${'A'.repeat(64)}}`,
      },
    });
    const coverage = adapterSourceCoverage({
      requests: [worker],
      referenced: [
        { url: 'https://10.10.8.101/vmc/vconsole/main.36508cda.js', kind: 'javascript', initiator: 'script-tag' },
        { url: 'https://10.10.8.101/vmc/vconsole/polyfills.41fe.js', kind: 'javascript', initiator: 'script-tag' },
        { url: 'https://10.10.8.101/vmc/vconsole/file.worker.js', kind: 'javascript', initiator: 'worker' },
      ],
      host: '10.10.8.101',
      unclassified: true,
    });

    expect(coverage.missingReferenced.map(item => item.url)).toEqual([
      'https://10.10.8.101/vmc/vconsole/main.36508cda.js',
      'https://10.10.8.101/vmc/vconsole/polyfills.41fe.js',
    ]);
    expect(coverage.candidates.map(item => item.id)).toEqual(['worker']);
  });

  it('inherits page-scripts window context and keeps query parameters', () => {
    const scripts = pageReferencedScriptsFromEvents([
      {
        type: 'page-scripts',
        captureWindowId: 'popup-kvm',
        windowRole: 'popup',
        scripts: [{ url: 'https://10.10.8.107/kvmclient.js?resource_id=12', kind: 'javascript' }],
      },
    ]);
    expect(scripts).toEqual([
      {
        url: 'https://10.10.8.107/kvmclient.js?resource_id=12',
        kind: 'javascript',
        captureWindowId: 'popup-kvm',
        windowRole: 'popup',
      },
    ]);
  });

  it('does not let another window or query-less URL fill the current Viewer source', () => {
    const mainWindow = request({
      id: 'main-old',
      url: 'https://10.10.8.101/vmc/vconsole/main.36508cda.js',
      resourceType: 'script',
      captureWindowId: 'win-main',
      windowRole: 'main',
      responseBodyCaptured: true,
      sourceSha256: 'a'.repeat(64),
      sourceBytes: 1200,
      sourceTruncated: false,
      responseBodySummary: { bytes: 1200, redactedFields: [], sample: `function startKvm(){${'A'.repeat(64)}}` },
    });
    const otherSession = request({
      id: 'worker-old',
      url: 'https://10.10.8.101/kvmclient.js',
      resourceType: 'script',
      captureWindowId: 'popup-old',
      windowRole: 'popup',
      responseBodyCaptured: true,
      sourceSha256: 'b'.repeat(64),
      sourceBytes: 800,
      sourceTruncated: false,
      responseBodySummary: { bytes: 800, redactedFields: [], sample: `function kvm(){${'A'.repeat(64)}}` },
    });
    const coverage = adapterSourceCoverage({
      requests: [mainWindow, otherSession],
      referenced: [
        {
          url: 'https://10.10.8.101/vmc/vconsole/main.36508cda.js',
          kind: 'javascript',
          captureWindowId: 'popup-kvm',
          windowRole: 'popup',
        },
        {
          url: 'https://10.10.8.101/kvmclient.js?resource_id=12',
          kind: 'javascript',
          captureWindowId: 'popup-kvm',
          windowRole: 'popup',
        },
      ],
      host: '10.10.8.101',
      unclassified: true,
    });
    expect(coverage.missingReferenced.map(item => item.url)).toEqual([
      'https://10.10.8.101/vmc/vconsole/main.36508cda.js',
      'https://10.10.8.101/kvmclient.js?resource_id=12',
    ]);
  });
});
