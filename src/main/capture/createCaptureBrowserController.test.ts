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
            nextOptions.onNavigation({ url, windowRole: 'main' });
            nextOptions.onHashChange({ url: `${url}#/kvm`, windowRole: 'main' });
            nextOptions.onPopup({
              url: `${url}kvm.html`,
              disposition: 'new-window',
              windowRole: 'main',
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
      partition: 'kvm-recon-job-001',
      targetHost: '10.0.0.10',
    });
    expect(capturedOptions.allowCertificateError('https://10.0.0.10/login.html')).toBe(true);
    expect(capturedOptions.allowCertificateError('https://ibmc.local/login.html')).toBe(true);
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
    const factWindowIds: string[] = [];

    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        await nextOptions.onNetworkDebugger(
          {
            async attach() {},
            async sendCommand() {},
            on() {},
          },
          { windowRole: 'main', captureWindowId: 'main-window' },
        );
        return {
          async loadURL(url) {
            nextOptions.onNavigation({
              url,
              windowRole: 'main',
              captureWindowId: 'main-window',
            });
            nextOptions.onPopup({
              url: `${url}kvm.html`,
              disposition: 'new-window',
              windowRole: 'popup',
              captureWindowId: 'popup-window',
              openerCaptureWindowId: 'main-window',
            });
            await nextOptions.onNetworkDebugger(popupCdp, {
              windowRole: 'popup',
              captureWindowId: 'popup-window',
              openerCaptureWindowId: 'main-window',
            });
            focused = 'main';
          },
          async selectPageTarget(options) {
            expect(options).toMatchObject({
              requireKvmSurface: true,
              preferredWindowRole: 'popup',
              preferredCaptureWindowId: 'popup-window',
            });
            return { windowId: 'popup-window', windowRole: 'popup' };
          },
          async collectStorageKeys(options) {
            factWindowIds.push(options?.target?.windowId || focused);
            return {
              localStorageKeys: options?.target?.windowRole === 'popup' ? ['VIEWER'] : ['LOCAL_USERNAME'],
              sessionStorageKeys: [],
            };
          },
          async collectSelectorCandidates(options) {
            factWindowIds.push(options?.target?.windowId || focused);
            return [
              {
                role: 'viewer' as const,
                selector: 'canvas',
                confidence: 0.7,
              },
            ];
          },
          async captureScreenshot(label, options) {
            factWindowIds.push(options?.target?.windowId || focused);
            return {
              packPath: `page/screenshots/${label}.png`,
              sourcePath: `/tmp/${label}.png`,
              windowId: options?.target?.windowId,
              windowRole: options?.target?.windowRole,
            };
          },
          async drainClicks(options) {
            factWindowIds.push(options?.target?.windowId || focused);
            return options?.target?.windowRole === 'popup'
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
      captureWindowId: 'popup-window',
      openerCaptureWindowId: 'main-window',
    });
    expect(controller.network().webSocketFrames[0]?.socketId).toBe('ws-popup');
    expect(controller.timeline().events.map(event => event.type)).toContain('popup');
    expect(controller.timeline().events).toContainEqual(
      expect.objectContaining({
        type: 'popup',
        captureWindowId: 'popup-window',
        openerCaptureWindowId: 'main-window',
        windowRole: 'popup',
      }),
    );
    expect(controller.timeline().events).toContainEqual(
      expect.objectContaining({
        type: 'click',
        selector: 'canvas',
        windowRole: 'popup',
      }),
    );
    expect(factWindowIds).toEqual([
      'popup-window',
      'popup-window',
      'popup-window',
      'popup-window',
    ]);
    expect(
      controller.timeline().events
        .filter(event => ['click', 'storage-snapshot', 'screenshot', 'selector-candidates'].includes(event.type))
        .every(
          event =>
            event.windowRole === 'popup' && event.captureWindowId === 'popup-window',
        ),
    ).toBe(true);
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

  it('auto-captures a viewer screenshot after KVM WebSocket frames arrive', async () => {
    const cdpListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand() {},
      on(event, listener) {
        if (event === 'message') cdpListeners.push(listener);
      },
    };
    const screenshotLabels: string[] = [];
    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        await nextOptions.onNetworkDebugger(cdp);
        return {
          async loadURL() {},
          async collectStorageKeys() {
            return { localStorageKeys: [], sessionStorageKeys: [] };
          },
          async collectSelectorCandidates() {
            return [];
          },
          async captureScreenshot(label) {
            screenshotLabels.push(label);
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
      jobId: 'job-auto-shot',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    for (const listener of cdpListeners) {
      listener({}, 'Network.webSocketCreated', {
        requestId: 'ws-1',
        url: 'wss://10.0.0.10/kvm',
      });
      listener({}, 'Network.webSocketFrameReceived', {
        requestId: 'ws-1',
        response: {
          opcode: 2,
          payloadData: 'AAAA',
        },
      });
    }
    await controller.ingestLiveEvents();
    await controller.flushPageFacts();
    expect(screenshotLabels).toEqual(['viewer']);
    await controller.ingestLiveEvents();
    await controller.flushPageFacts();
    expect(screenshotLabels).toEqual(['viewer']);
  });

  it('allows an operator-confirmed viewer screenshot without promoting unknown WebSocket evidence', async () => {
    const screenshotLabels: string[] = [];
    const adapter: CaptureBrowserAdapter = {
      async createWindow() {
        return {
          async loadURL() {},
          async selectPageTarget(options) {
            expect(options?.requireKvmSurface).toBe(false);
            return { windowId: 'main-window', windowRole: 'main' };
          },
          async collectStorageKeys() {
            return { localStorageKeys: ['UNKNOWN_VIEWER'], sessionStorageKeys: [] };
          },
          async collectSelectorCandidates() {
            return [{ role: 'viewer', selector: 'iframe', confidence: 0.5 }];
          },
          async captureScreenshot(label) {
            screenshotLabels.push(label);
            return {
              packPath: `page/screenshots/${label}.png`,
              sourcePath: `/tmp/${label}.png`,
              windowId: 'main-window',
              windowRole: 'main',
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
      jobId: 'job-operator-viewer',
      target: { host: '10.0.0.10', port: 443, scheme: 'https' },
      adapter,
    });

    await controller.start();
    const automatic = await controller.collectPageFacts('viewer');
    const manual = await controller.collectPageFacts('viewer', { operatorConfirmed: true });

    expect(automatic).toMatchObject({
      captured: false,
      reason: 'reliable-kvm-evidence-missing',
    });
    expect(manual).toMatchObject({ captured: true, operatorConfirmed: true });
    expect(screenshotLabels).toEqual(['viewer']);
    expect(controller.timeline().events).toContainEqual(
      expect.objectContaining({
        type: 'screenshot',
        role: 'viewer',
        operatorConfirmed: true,
      }),
    );
    expect(controller.network().webSockets).toEqual([]);
  });

  it('waits past H3C home /websocket text and generic binary frames before capturing the viewer', async () => {
    const cdpListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand() {},
      on(event, listener) {
        if (event === 'message') cdpListeners.push(listener);
      },
    };
    const screenshotLabels: string[] = [];
    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        await nextOptions.onNetworkDebugger(cdp);
        return {
          async loadURL() {},
          async collectStorageKeys() {
            return { localStorageKeys: [], sessionStorageKeys: [] };
          },
          async collectSelectorCandidates() {
            return [];
          },
          async captureScreenshot(label) {
            screenshotLabels.push(label);
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
      jobId: 'job-h3c-shot',
      target: {
        host: '10.10.8.129',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    for (const listener of cdpListeners) {
      listener({}, 'Network.webSocketCreated', {
        requestId: 'ws-home',
        url: 'wss://10.10.8.129/websocket',
      });
      listener({}, 'Network.webSocketFrameReceived', {
        requestId: 'ws-home',
        response: {
          opcode: 1,
          payloadData: '{"event":"alarm","message":"home"}',
        },
      });
      listener({}, 'Network.webSocketFrameReceived', {
        requestId: 'ws-home',
        response: {
          opcode: 2,
          payloadData: Buffer.from([0x17, 0x00, 0x00, 0x01]).toString('base64'),
        },
      });
    }
    await controller.ingestLiveEvents();
    await controller.flushPageFacts();
    expect(screenshotLabels).toEqual([]);

    for (const listener of cdpListeners) {
      listener({}, 'Network.webSocketCreated', {
        requestId: 'ws-kvm',
        url: 'wss://10.10.8.129/kvm',
      });
      listener({}, 'Network.webSocketFrameReceived', {
        requestId: 'ws-kvm',
        response: {
          opcode: 2,
          payloadData: Buffer.from([0x53, 0x00, 0x00, 0x00]).toString('base64'),
        },
      });
    }
    await controller.ingestLiveEvents();
    await controller.flushPageFacts();
    expect(screenshotLabels).toEqual(['viewer']);
  });

  it('does not capture a second viewer screenshot when polls overlap or export runs again', async () => {
    const cdpListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
    const cdp: CdpDebuggerLike = {
      async attach() {},
      async sendCommand() {},
      on(event, listener) {
        if (event === 'message') cdpListeners.push(listener);
      },
    };
    const screenshotLabels: string[] = [];
    let releaseCapture: (() => void) | undefined;
    const holdCapture = new Promise<void>(resolve => {
      releaseCapture = resolve;
    });
    const adapter: CaptureBrowserAdapter = {
      async createWindow(nextOptions) {
        await nextOptions.onNetworkDebugger(cdp);
        return {
          async loadURL() {},
          async collectStorageKeys() {
            return { localStorageKeys: [], sessionStorageKeys: [] };
          },
          async collectSelectorCandidates() {
            return [];
          },
          async captureScreenshot(label) {
            screenshotLabels.push(label);
            await holdCapture;
            return {
              packPath: `page/screenshots/${label}-${screenshotLabels.length}.png`,
              sourcePath: `/tmp/${label}-${screenshotLabels.length}.png`,
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
      jobId: 'job-overlap-shot',
      target: {
        host: '10.0.0.10',
        port: 443,
        scheme: 'https',
      },
      adapter,
    });

    await controller.start();
    for (const listener of cdpListeners) {
      listener({}, 'Network.webSocketCreated', {
        requestId: 'ws-1',
        url: 'wss://10.0.0.10/kvm',
      });
      listener({}, 'Network.webSocketFrameReceived', {
        requestId: 'ws-1',
        response: {
          opcode: 2,
          payloadData: 'AAAA',
        },
      });
    }
    const firstPoll = controller.ingestLiveEvents();
    const secondPoll = controller.ingestLiveEvents();
    await Promise.all([firstPoll, secondPoll]);
    expect(controller.isCapturingScreenshot()).toBe(true);
    releaseCapture?.();
    await controller.flushPageFacts();
    await controller.collectPageFacts('viewer');
    expect(screenshotLabels).toEqual(['viewer']);
  });

  it('clears live windows but can still read session cookies after the operator closes them', async () => {
    let capturedOptions: CaptureBrowserAdapterOptions | undefined;
    let cookieTargetUrl = '';
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
          async collectSessionCookies(targetUrl) {
            cookieTargetUrl = targetUrl;
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
    await expect(controller.readSessionCookies('/api/randomtag')).resolves.toEqual([
      { name: 'QSESSIONID', value: 'session-secret' },
    ]);
    expect(cookieTargetUrl).toBe('https://10.0.0.10/api/randomtag');
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
            nextOptions.onNavigation({ url, windowRole: 'main' });
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
    capturedOptions?.onNavigation({ url: 'https://10.0.0.10/kvm', windowRole: 'main' });
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
