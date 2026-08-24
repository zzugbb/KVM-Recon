import type { CaptureTarget } from '../../core/capture-pack/types';
import {
  buildBmcUrl,
  createBrowserTimeline,
  diffKeyLists,
  screenshotRoleFromLabel,
  shouldAllowCertificateError,
  type ClickSummary,
  type SelectorCandidate,
} from '../../core/browser/browserCaptureCore';
import { createNetworkRecorder } from '../../core/network/createNetworkRecorder';
import { attachCdpNetworkCapture, type CdpDebuggerLike } from './attachCdpNetworkCapture';

export interface ChromiumAccessInfo {
  reachable: boolean;
  authorizationError: string;
}

export interface CaptureBrowserAdapterOptions {
  partition: string;
  targetHost: string;
  allowCertificateError(url: string): boolean;
  onNavigation(url: string): void;
  onHashChange(url: string): void;
  onPopup(input: { url: string; disposition: string }): void;
  onNetworkDebugger(cdp: CdpDebuggerLike): Promise<void>;
  onChromiumAccess(info: ChromiumAccessInfo): void;
  onAllWindowsClosed(): void;
}

export interface CaptureBrowserWindowHandle {
  loadURL(url: string): Promise<void>;
  collectStorageKeys(): Promise<{
    localStorageKeys: string[];
    sessionStorageKeys: string[];
  }>;
  collectSelectorCandidates(): Promise<SelectorCandidate[]>;
  captureScreenshot(label: string): Promise<{
    packPath: string;
    sourcePath: string;
  }>;
  drainClicks(): Promise<ClickSummary[]>;
  collectSessionCookies(): Promise<Array<{ name: string; value: string }>>;
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
  return `persist:kvm-recon-${jobId}`;
}

async function recordClicks(
  windowHandle: CaptureBrowserWindowHandle,
  timeline: ReturnType<typeof createBrowserTimeline>,
) {
  const clicks = await windowHandle.drainClicks();
  for (const click of clicks) {
    timeline.recordClick({
      selector: click.selector,
      text: click.text.slice(0, 80),
      tagName: click.tagName,
    });
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
  let previousLocalStorage: string[] = [];
  let previousSessionStorage: string[] = [];
  let captureWindowsOpen = false;
  let debuggerCount = 0;

  return {
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
        onNavigation: url => timeline.recordNavigation(url),
        onHashChange: url => timeline.recordHashChange(url),
        onPopup: popup => timeline.recordPopup(popup),
        onNetworkDebugger: cdp =>
          attachCdpNetworkCapture({
            cdp,
            recorder: networkRecorder,
            windowRole: debuggerCount++ === 0 ? 'main' : 'popup',
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
        await recordClicks(windowHandle, timeline);
      } catch (error) {
        // 捕获进度轮询时读取点击失败：窗口可能已关闭或页面正在导航
        // 策略：跳过本次点击，不影响 HTTP/WS 持续记录和后续导出
        void error;
      }
    },
    async collectPageFacts(label: string) {
      if (!captureWindowsOpen || !windowHandle) return;

      try {
        await recordClicks(windowHandle, timeline);
        const storage = await windowHandle.collectStorageKeys();
        const localDiff = diffKeyLists(previousLocalStorage, storage.localStorageKeys);
        const sessionDiff = diffKeyLists(previousSessionStorage, storage.sessionStorageKeys);
        previousLocalStorage = storage.localStorageKeys;
        previousSessionStorage = storage.sessionStorageKeys;
        timeline.recordStorageSnapshot({
          localStorageKeys: storage.localStorageKeys,
          sessionStorageKeys: storage.sessionStorageKeys,
          localStorageAdded: localDiff.added,
          localStorageRemoved: localDiff.removed,
          sessionStorageAdded: sessionDiff.added,
          sessionStorageRemoved: sessionDiff.removed,
        });
        const screenshot = await windowHandle.captureScreenshot(label);
        timeline.recordScreenshot(
          screenshot.packPath,
          screenshot.sourcePath,
          screenshotRoleFromLabel(label),
        );
        timeline.recordSelectorCandidates(await windowHandle.collectSelectorCandidates());
      } catch (error) {
        // 捕获页面事实采集失败：窗口可能已被用户关掉或截图目录不可写
        // 策略：跳过本次截图/storage，保留已有时间线与网络记录，便于关窗后仍能导出
        void error;
      }
    },
    async readSessionCookies() {
      if (!windowHandle) return [];
      try {
        return await windowHandle.collectSessionCookies();
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
    chromiumAccess() {
      return chromiumAccess;
    },
  };
}
