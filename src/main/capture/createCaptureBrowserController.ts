import type { CaptureTarget } from '../../core/capture-pack/types';
import {
  buildBmcUrl,
  createBrowserTimeline,
  diffKeyLists,
  screenshotRoleFromLabel,
  shouldAllowCertificateError,
  type ClickSummary,
  type CaptureWindowRole,
  type SelectorCandidate,
} from '../../core/browser/browserCaptureCore';
import { createNetworkRecorder } from '../../core/network/createNetworkRecorder';
import { kvmWebSocketEvidence } from '../../core/readiness/buildReadinessChecklist';
import { attachCdpNetworkCapture, type CdpDebuggerLike } from './attachCdpNetworkCapture';

export interface ChromiumAccessInfo {
  reachable: boolean;
  authorizationError: string;
}

export interface CaptureBrowserAdapterOptions {
  partition: string;
  targetHost: string;
  allowCertificateError(url: string): boolean;
  onNavigation(input: { url: string; windowRole: CaptureWindowRole; captureWindowId?: string }): void;
  onHashChange(input: { url: string; windowRole: CaptureWindowRole; captureWindowId?: string }): void;
  onPopup(input: {
    url: string;
    disposition: string;
    windowRole: CaptureWindowRole;
    captureWindowId?: string;
    openerCaptureWindowId?: string;
  }): void;
  onNetworkDebugger(
    cdp: CdpDebuggerLike,
    context?: {
      windowRole: CaptureWindowRole;
      captureWindowId: string;
      openerCaptureWindowId?: string;
    },
  ): Promise<void>;
  onChromiumAccess(info: ChromiumAccessInfo): void;
  onAllWindowsClosed(): void;
}

export interface CapturePageTarget {
  windowId: string;
  windowRole: CaptureWindowRole;
  openerCaptureWindowId?: string;
}

interface PageTargetOptions {
  target?: CapturePageTarget;
  expectedRole?: ReturnType<typeof screenshotRoleFromLabel>;
}

export interface PageCaptureResult {
  captured: boolean;
  reason: string;
  operatorConfirmed: boolean;
  windowRole?: CaptureWindowRole;
  path?: string;
}

export interface CaptureBrowserWindowHandle {
  loadURL(url: string): Promise<void>;
  selectPageTarget?(options?: {
    requireKvmSurface?: boolean;
    preferredWindowRole?: CaptureWindowRole;
    preferredCaptureWindowId?: string;
  }): Promise<CapturePageTarget>;
  collectStorageKeys(options?: PageTargetOptions): Promise<{
    localStorageKeys: string[];
    sessionStorageKeys: string[];
  }>;
  collectSelectorCandidates(options?: PageTargetOptions): Promise<SelectorCandidate[]>;
  captureScreenshot(
    label: string,
    options?: PageTargetOptions & {
      preferredWindowRole?: CaptureWindowRole;
      preferredCaptureWindowId?: string;
    },
  ): Promise<{
    packPath: string;
    sourcePath: string;
    windowId?: string;
    windowRole?: CaptureWindowRole;
  }>;
  drainClicks(options?: PageTargetOptions): Promise<ClickSummary[]>;
  collectSessionCookies(targetUrl: string): Promise<Array<{ name: string; value: string }>>;
  close(): Promise<void>;
}

export interface CaptureBrowserAdapter {
  createWindow(options: CaptureBrowserAdapterOptions): Promise<CaptureBrowserWindowHandle>;
}

interface CreateCaptureBrowserControllerInput {
  jobId: string;
  target: CaptureTarget;
  adapter: CaptureBrowserAdapter;
}

function buildPartition(jobId: string) {
  return `kvm-recon-${jobId}`;
}

async function recordClicks(
  windowHandle: CaptureBrowserWindowHandle,
  timeline: ReturnType<typeof createBrowserTimeline>,
  target?: CapturePageTarget,
) {
  const clicks = await windowHandle.drainClicks({ target });
  for (const click of clicks) {
    timeline.recordClick({
      selector: click.selector,
      text: click.text.slice(0, 80),
      tagName: click.tagName,
      captureWindowId: click.captureWindowId || target?.windowId,
    }, click.windowRole || target?.windowRole || 'main');
  }
}

export function createCaptureBrowserController(input: CreateCaptureBrowserControllerInput) {
  const timeline = createBrowserTimeline(input.jobId);
  const networkRecorder = createNetworkRecorder({ frameHeadBytes: 32 });
  let windowHandle: CaptureBrowserWindowHandle | null = null;
  let chromiumAccess: ChromiumAccessInfo = {
    reachable: false,
    authorizationError: '',
  };
  const previousStorageByWindow = new Map<
    string,
    { localStorageKeys: string[]; sessionStorageKeys: string[] }
  >();
  let captureWindowsOpen = false;
  let debuggerCount = 0;
  let paused = false;
  let pageFactsPending = 0;
  let pageFactsChain: Promise<void> = Promise.resolve();

  function unlessPaused<Args extends unknown[]>(fn: (...args: Args) => void) {
    return (...args: Args) => {
      if (!paused) {
        fn(...args);
      }
    };
  }

  function hasViewerScreenshot() {
    return timeline.toJSON().events.some(event => event.type === 'screenshot' && event.role === 'viewer');
  }

  function reliableKvmWindow(): { windowRole?: CaptureWindowRole; captureWindowId?: string } | undefined {
    const snapshot = networkRecorder.toJSON();
    const socketIds = new Set(kvmWebSocketEvidence(snapshot));
    const socket = snapshot.webSockets.find(item => socketIds.has(item.id));
    if (!socket) return undefined;
    return { windowRole: socket.windowRole, captureWindowId: socket.captureWindowId };
  }

  function hasReliableKvmEvidence() {
    return kvmWebSocketEvidence(networkRecorder.toJSON()).length > 0;
  }

  async function collectPageFactsNow(
    label: string,
    options: { operatorConfirmed?: boolean } = {},
  ): Promise<PageCaptureResult> {
    const operatorConfirmed = Boolean(options.operatorConfirmed);
    if (!captureWindowsOpen || !windowHandle) {
      return { captured: false, reason: 'capture-window-closed', operatorConfirmed };
    }
    const role = screenshotRoleFromLabel(label);
    if (role === 'viewer' && !operatorConfirmed && hasViewerScreenshot()) {
      return { captured: false, reason: 'viewer-already-captured', operatorConfirmed };
    }
    if (role === 'viewer' && !operatorConfirmed && !hasReliableKvmEvidence()) {
      return { captured: false, reason: 'reliable-kvm-evidence-missing', operatorConfirmed };
    }

    try {
      const preferredWindow = role === 'viewer' ? reliableKvmWindow() : undefined;
      const target = await windowHandle.selectPageTarget?.({
        requireKvmSurface: role === 'viewer' && !operatorConfirmed,
        preferredWindowRole: preferredWindow?.windowRole,
        preferredCaptureWindowId: preferredWindow?.captureWindowId,
      });
      const windowRole = target?.windowRole || preferredWindow?.windowRole || 'main';
      const captureWindowId = target?.windowId || preferredWindow?.captureWindowId;
      const pageTargetOptions = { target, expectedRole: role };
      const clicks = await windowHandle.drainClicks(pageTargetOptions);
      const storage = await windowHandle.collectStorageKeys(pageTargetOptions);
      const screenshot = await windowHandle.captureScreenshot(label, {
        ...pageTargetOptions,
        preferredWindowRole: preferredWindow?.windowRole,
        preferredCaptureWindowId: preferredWindow?.captureWindowId,
      });
      const selectors = await windowHandle.collectSelectorCandidates(pageTargetOptions);

      if (!paused) {
        for (const click of clicks) {
          timeline.recordClick(
            {
              selector: click.selector,
              text: click.text.slice(0, 80),
              tagName: click.tagName,
              captureWindowId: click.captureWindowId || captureWindowId,
            },
            click.windowRole || windowRole,
          );
        }
      }
      const storageKey = captureWindowId || windowRole;
      const previousStorage = previousStorageByWindow.get(storageKey);
      const localDiff = diffKeyLists(previousStorage?.localStorageKeys, storage.localStorageKeys);
      const sessionDiff = diffKeyLists(previousStorage?.sessionStorageKeys, storage.sessionStorageKeys);
      previousStorageByWindow.set(storageKey, storage);
      timeline.recordStorageSnapshot({
        localStorageKeys: storage.localStorageKeys,
        sessionStorageKeys: storage.sessionStorageKeys,
        localStorageAdded: localDiff.added,
        localStorageRemoved: localDiff.removed,
        sessionStorageAdded: sessionDiff.added,
        sessionStorageRemoved: sessionDiff.removed,
        windowRole,
        captureRole: role,
        captureWindowId,
      });
      timeline.recordScreenshot(
        screenshot.packPath,
        screenshot.sourcePath,
        screenshotRoleFromLabel(label),
        screenshot.windowRole || windowRole,
        operatorConfirmed,
        screenshot.windowId || captureWindowId,
      );
      timeline.recordSelectorCandidates(selectors, windowRole, role, captureWindowId);
      return {
        captured: true,
        reason: '',
        operatorConfirmed,
        windowRole: screenshot.windowRole || windowRole,
        path: screenshot.packPath,
      };
    } catch (error) {
      // 捕获页面事实采集失败：窗口可能已被用户关掉或截图目录不可写
      // 策略：返回未采集及原因，保留已有时间线与网络记录供重试
      return {
        captured: false,
        reason: error instanceof Error ? error.message : String(error),
        operatorConfirmed,
      };
    }
  }

  function collectPageFacts(label: string, options: { operatorConfirmed?: boolean } = {}) {
    pageFactsPending += 1;
    const run = pageFactsChain.then(() => collectPageFactsNow(label, options));
    pageFactsChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      pageFactsPending -= 1;
    });
  }

  function maybeAutoCaptureViewer() {
    if (paused || !captureWindowsOpen || hasViewerScreenshot() || !hasReliableKvmEvidence()) {
      return;
    }
    void collectPageFacts('viewer');
  }

  return {
    pause() {
      paused = true;
      networkRecorder.setPaused(true);
    },
    resume() {
      paused = false;
      networkRecorder.setPaused(false);
    },
    isPaused() {
      return paused;
    },
    isCapturingScreenshot() {
      return pageFactsPending > 0;
    },
    async flushPageFacts() {
      await pageFactsChain;
    },
    async start() {
      debuggerCount = 0;
      windowHandle = await input.adapter.createWindow({
        partition: buildPartition(input.jobId),
        targetHost: input.target.host,
        allowCertificateError: url =>
          shouldAllowCertificateError({
            targetHost: input.target.host,
            url,
          }),
        onNavigation: unlessPaused(event =>
          timeline.recordNavigation(event.url, event.windowRole, event.captureWindowId),
        ),
        onHashChange: unlessPaused(event =>
          timeline.recordHashChange(event.url, event.windowRole, event.captureWindowId),
        ),
        onPopup: unlessPaused(popup => timeline.recordPopup(popup)),
        onNetworkDebugger: (cdp, context) =>
          attachCdpNetworkCapture({
            cdp,
            recorder: networkRecorder,
            windowRole: context?.windowRole || (debuggerCount++ === 0 ? 'main' : 'popup'),
            captureWindowId: context?.captureWindowId,
            openerCaptureWindowId: context?.openerCaptureWindowId,
          }),
        onChromiumAccess: info => {
          chromiumAccess = info;
        },
        onAllWindowsClosed: () => {
          captureWindowsOpen = false;
        },
      });
      captureWindowsOpen = true;

      await windowHandle.loadURL(buildBmcUrl(input.target));
    },
    windowsOpen() {
      return captureWindowsOpen && windowHandle !== null;
    },
    async ingestLiveEvents() {
      if (!captureWindowsOpen || !windowHandle) return;
      try {
        if (paused) {
          await windowHandle.drainClicks();
          return;
        }
        await recordClicks(windowHandle, timeline);
        maybeAutoCaptureViewer();
      } catch (error) {
        // 捕获进度轮询时读取点击失败：窗口可能已关闭或页面正在导航
        // 策略：跳过本次点击，不影响 HTTP/WS 持续记录和后续导出
        void error;
      }
    },
    collectPageFacts,

    async readSessionCookies(path = '/') {
      if (!windowHandle) return [];
      try {
        const targetUrl = new URL(path, buildBmcUrl(input.target)).toString();
        return await windowHandle.collectSessionCookies(targetUrl);
      } catch (error) {
        // 捕获读取浏览器 Cookie 失败：窗口可能已销毁或分区已清理
        // 策略：返回空列表，匿名 probe 结果仍可用于导出，不把 Cookie 值写入日志
        void error;
        return [];
      }
    },
    async stop() {
      captureWindowsOpen = false;
      if (!windowHandle) return;
      try {
        await recordClicks(windowHandle, timeline);
      } catch (error) {
        // 捕获关窗前读取点击失败：页面可能已卸载
        // 策略：仍关闭窗口，避免采集窗口残留
        void error;
      }
      try {
        await windowHandle.close();
      } catch (error) {
        // 捕获关闭采集窗口失败：窗口可能已被用户手动关掉
        // 策略：仍释放句柄，保留已采集数据供导出
        void error;
      }
      windowHandle = null;
    },
    timeline() {
      return timeline.toJSON();
    },
    network() {
      return networkRecorder.toJSON();
    },
    async waitForNetworkIdle() {
      return networkRecorder.waitForIdle();
    },
    chromiumAccess() {
      return chromiumAccess;
    },
  };
}
