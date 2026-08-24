import { describe, expect, it } from 'vitest';

import {
  createCaptureBrowserController,
  type CaptureBrowserAdapter,
  type CaptureBrowserAdapterOptions,
} from './createCaptureBrowserController';

describe('createCaptureBrowserController', () => {
  it('opens the BMC URL in an isolated session and records browser facts', async () => {
    let capturedOptions: CaptureBrowserAdapterOptions | undefined;
    const loadedUrls: string[] = [];

    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        capturedOptions = nextOptions;
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
            return `page/screenshots/${label}.png`;
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
  });
});
