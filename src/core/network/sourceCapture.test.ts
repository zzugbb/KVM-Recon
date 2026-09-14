import { describe, expect, it } from 'vitest';

import type { HttpRequestRecord } from './createNetworkRecorder';
import {
  adapterSourceCandidates,
  adapterSourceCoverage,
  classifySourceKind,
  isCompleteAdapterSource,
  isJavascriptSourceText,
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

  it('includes hashed first-party chunks for unclassified families', () => {
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
    expect(adapterSourceCandidates([chunk, jquery], { host: 'bmc.example', unclassified: false })).toEqual(
      [],
    );
    expect(
      adapterSourceCandidates([chunk, jquery], { host: 'bmc.example', unclassified: true }).map(
        item => item.id,
      ),
    ).toEqual(['chunk']);
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
});
