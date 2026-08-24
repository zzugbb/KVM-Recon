import { describe, expect, it } from 'vitest';

import {
  createCaptureBrowserController,
  type CaptureBrowserAdapter,
  type CaptureBrowserAdapterOptions,
} from './createCaptureBrowserController';
import type { CdpDebuggerLike } from './attachCdpNetworkCapture';

describe('createCaptureBrowserController', () => {
  it('opens the BMC URL in an isolated session and records browser facts', async () => {
    let capturedOptions: CaptureBrowserAdapterOptions | undefined;
    const loadedUrls: string[] = [];
    const cdpListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand() {},
      on(event, listener) {
        if (event === 'message') cdpListeners.push(listener);
      },
    };

    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        capturedOptions = nextOptions;
        await nextOptions.onNetworkDebugger(cdp);
        return {
          async loadURL(url) {
            loadedUrls.push(url);
            nextOptions.onNavigation(url);
            nextOptions.onHashChange(`${url}#/kvm`);
            nextOptions.onPopup({
              url: `${url}kvm.html`,
              disposition: 'new-window',
            });
          },
          async collectStorageKeys() {
            return {
              localStorageKeys: ['LOCAL_USERNAME'],
              sessionStorageKeys: ['QSESSIONID'],
            };
          },
          async collectSelectorCandidates() {
            return [
              {
                role: 'kvm-entry' as const,
                selector: 'button[data-testid="kvm"]',
                confidence: 0.8,
              },
            ];
          },
          async captureScreenshot(label) {
            return {
              packPath: `page/screenshots/${label}.png`,
              sourcePath: `/tmp/${label}.png`,
            };
          },
        };
      },
    };

    const controller = createCaptureBrowserController({
      jobId: 'job-001',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    await controller.collectPageFacts('login');
    for (const listener of cdpListeners) {
      listener({}, 'Network.requestWillBeSent', {
        requestId: 'req-1',
        type: 'XHR',
        request: {
          method: 'GET',
          url: 'https://10.0.0.10/api/kvm/token',
          headers: {},
        },
      });
    }

    expect(capturedOptions).toBeDefined();
    if (!capturedOptions) {
      throw new Error('Capture browser adapter options missing');
    }
    expect(capturedOptions).toMatchObject({
      partition: 'persist:kvm-recon-job-001',
      targetHost: '10.0.0.10',
    });
    expect(capturedOptions.allowCertificateError('https://10.0.0.10/login.html')).toBe(true);
    expect(capturedOptions.allowCertificateError('https://example.com/login.html')).toBe(false);
    expect(loadedUrls).toEqual(['https://10.0.0.10:443/']);
    expect(controller.timeline().events.map(event => event.type)).toEqual([
      'navigation',
      'hash-change',
      'popup',
      'storage-snapshot',
      'screenshot',
      'selector-candidates',
    ]);
    expect(controller.network().httpRequests[0]).toMatchObject({
      id: 'req-1',
      url: 'https://10.0.0.10/api/kvm/token',
      tags: ['kvm-token'],
    });
  });
});
