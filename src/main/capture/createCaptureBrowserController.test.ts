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
          async drainClicks() {
            return [];
          },
          async collectSessionCookies() {
            return [];
          },
          async close() {},
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
      windowRole: 'main',
    });
    expect(controller.timeline().events.find(event => event.type === 'screenshot')).toMatchObject({
      role: 'login',
      path: 'page/screenshots/login.png',
    });
  });

  it('records popup WebSocket facts after the first window loses focus', async () => {
    const popupListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const popupCdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand() {},
      on(event, listener) {
        if (event === 'message') popupListeners.push(listener);
      },
    };
    let focused: 'main' | 'popup' = 'main';
    let mainAlive = true;

    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        await nextOptions.onNetworkDebugger({
          async attach() {},
          async sendCommand() {},
          on() {},
        });
        return {
          async loadURL(url) {
            nextOptions.onNavigation(url);
            nextOptions.onPopup({
              url: `${url}kvm.html`,
              disposition: 'new-window',
            });
            await nextOptions.onNetworkDebugger(popupCdp);
            focused = 'popup';
            mainAlive = false;
          },
          async collectStorageKeys() {
            if (focused === 'main' && !mainAlive) {
              throw new Error('main window closed');
            }
            return {
              localStorageKeys: focused === 'popup' ? ['VIEWER'] : ['LOCAL_USERNAME'],
              sessionStorageKeys: [],
            };
          },
          async collectSelectorCandidates() {
            return [
              {
                role: 'viewer' as const,
                selector: 'canvas',
                confidence: 0.7,
              },
            ];
          },
          async captureScreenshot(label) {
            return {
              packPath: `page/screenshots/${label}.png`,
              sourcePath: `/tmp/${label}.png`,
            };
          },
          async drainClicks() {
            return focused === 'popup'
              ? [{ selector: 'canvas', text: 'viewer', tagName: 'canvas' }]
              : [];
          },
          async collectSessionCookies() {
            return [];
          },
          async close() {},
        };
      },
    };

    const controller = createCaptureBrowserController({
      jobId: 'job-popup',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    for (const listener of popupListeners) {
      listener({}, 'Network.webSocketCreated', {
        requestId: 'ws-popup',
        url: 'wss://10.0.0.10/kvm',
      });
      listener({}, 'Network.webSocketFrameReceived', {
        requestId: 'ws-popup',
        timestamp: 1,
        response: {
          opcode: 2,
          payloadData: Buffer.from([0x17, 0x00, 0x00, 0x01]).toString('base64'),
        },
      });
    }
    await controller.collectPageFacts('viewer');

    expect(controller.network().webSockets[0]).toMatchObject({
      url: 'wss://10.0.0.10/kvm',
      tags: ['kvm-video'],
      windowRole: 'popup',
    });
    expect(controller.network().webSocketFrames[0]?.socketId).toBe('ws-popup');
    expect(controller.timeline().events.map(event => event.type)).toContain('popup');
    expect(controller.timeline().events).toContainEqual(
      expect.objectContaining({
        type: 'click',
        selector: 'canvas',
      }),
    );
    expect(JSON.stringify(controller.timeline())).not.toMatch(/\/Users\//);
  });

  it('records live clicks without taking a screenshot and keeps facts after stop', async () => {
    let closed = false;
    let pendingClicks = [{ selector: '#kvm', text: 'HTML5 KVM', tagName: 'button' }];
    const adapter: CaptureBrowserAdapter = {
      async createWindow() {
        return {
          async loadURL() {},
          async collectStorageKeys() {
            return { localStorageKeys: [], sessionStorageKeys: [] };
          },
          async collectSelectorCandidates() {
            return [];
          },
          async captureScreenshot(label) {
            return {
              packPath: `page/screenshots/${label}.png`,
              sourcePath: `/tmp/${label}.png`,
            };
          },
          async drainClicks() {
            const items = pendingClicks;
            pendingClicks = [];
            return items;
          },
          async collectSessionCookies() {
            return [{ name: 'QSESSIONID', value: 'abc123' }];
          },
          async close() {
            closed = true;
          },
        };
      },
    };

    const controller = createCaptureBrowserController({
      jobId: 'job-stop',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    expect(controller.windowsOpen()).toBe(true);
    await controller.ingestLiveEvents();
    expect(controller.timeline().events).toContainEqual(
      expect.objectContaining({
        type: 'click',
        selector: '#kvm',
      }),
    );
    expect(controller.timeline().events.map(event => event.type)).not.toContain('screenshot');

    await controller.stop();
    expect(closed).toBe(true);
    expect(controller.windowsOpen()).toBe(false);
    await controller.collectPageFacts('viewer');
    expect(controller.timeline().events.map(event => event.type)).not.toContain('screenshot');
    expect(controller.network()).toMatchObject({
      httpRequests: [],
      webSockets: [],
    });
  });

  it('clears live windows but can still read session cookies after the operator closes them', async () => {
    let capturedOptions: CaptureBrowserAdapterOptions | undefined;
    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        capturedOptions = nextOptions;
        return {
          async loadURL() {},
          async collectStorageKeys() {
            return { localStorageKeys: [], sessionStorageKeys: [] };
          },
          async collectSelectorCandidates() {
            return [];
          },
          async captureScreenshot(label) {
            return {
              packPath: `page/screenshots/${label}.png`,
              sourcePath: `/tmp/${label}.png`,
            };
          },
          async drainClicks() {
            return [];
          },
          async collectSessionCookies() {
            return [{ name: 'QSESSIONID', value: 'session-secret' }];
          },
          async close() {},
        };
      },
    };

    const controller = createCaptureBrowserController({
      jobId: 'job-closed',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    expect(controller.windowsOpen()).toBe(true);
    capturedOptions?.onAllWindowsClosed();
    expect(controller.windowsOpen()).toBe(false);
    await controller.collectPageFacts('viewer');
    expect(controller.timeline().events.map(event => event.type)).not.toContain('screenshot');
    await expect(controller.readSessionCookies()).resolves.toEqual([
      { name: 'QSESSIONID', value: 'session-secret' },
    ]);
    expect(JSON.stringify(controller.timeline())).not.toContain('session-secret');
  });

  it('pauses HTTP, navigation and click recording without closing the capture window', async () => {
    const cdpListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand() {},
      on(event, listener) {
        if (event === 'message') cdpListeners.push(listener);
      },
    };
    let pendingClicks = [{ selector: '#paused', text: 'ignored', tagName: 'button' }];
    let capturedOptions: CaptureBrowserAdapterOptions | undefined;
    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        capturedOptions = nextOptions;
        await nextOptions.onNetworkDebugger(cdp);
        return {
          async loadURL(url) {
            nextOptions.onNavigation(url);
          },
          async collectStorageKeys() {
            return { localStorageKeys: [], sessionStorageKeys: [] };
          },
          async collectSelectorCandidates() {
            return [];
          },
          async captureScreenshot(label) {
            return {
              packPath: `page/screenshots/${label}.png`,
              sourcePath: `/tmp/${label}.png`,
            };
          },
          async drainClicks() {
            const items = pendingClicks;
            pendingClicks = [];
            return items;
          },
          async collectSessionCookies() {
            return [];
          },
          async close() {},
        };
      },
    };

    const controller = createCaptureBrowserController({
      jobId: 'job-pause',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    for (const listener of cdpListeners) {
      listener({}, 'Network.requestWillBeSent', {
        requestId: 'req-1',
        type: 'XHR',
        request: {
          method: 'GET',
          url: 'https://10.0.0.10/api/session',
          headers: {},
        },
      });
    }

    controller.pause();
    expect(controller.isPaused()).toBe(true);
    expect(controller.windowsOpen()).toBe(true);
    capturedOptions?.onNavigation('https://10.0.0.10/kvm');
    await controller.ingestLiveEvents();
    for (const listener of cdpListeners) {
      listener({}, 'Network.requestWillBeSent', {
        requestId: 'req-2',
        type: 'XHR',
        request: {
          method: 'GET',
          url: 'https://10.0.0.10/api/kvm/token',
          headers: {},
        },
      });
    }

    controller.resume();
    pendingClicks = [{ selector: '#kvm', text: 'HTML5 KVM', tagName: 'button' }];
    await controller.ingestLiveEvents();

    expect(controller.network().httpRequests.map(item => item.id)).toEqual(['req-1']);
    expect(controller.timeline().events.map(event => event.type)).toEqual(['navigation', 'click']);
    expect(controller.timeline().events).toContainEqual(
      expect.objectContaining({
        type: 'click',
        selector: '#kvm',
      }),
    );
    expect(controller.timeline().events).not.toContainEqual(
      expect.objectContaining({
        selector: '#paused',
      }),
    );
  });
});
