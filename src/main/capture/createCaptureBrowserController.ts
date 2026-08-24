import type { CaptureTarget } from '../../core/capture-pack/types';
import {
  buildBmcUrl,
  createBrowserTimeline,
  shouldAllowCertificateError,
  type SelectorCandidate,
} from '../../core/browser/browserCaptureCore';

export interface CaptureBrowserAdapterOptions {
  partition: string;
  targetHost: string;
  allowCertificateError(url: string): boolean;
  onNavigation(url: string): void;
  onHashChange(url: string): void;
  onPopup(input: { url: string; disposition: string }): void;
}

export interface CaptureBrowserWindowHandle {
  loadURL(url: string): Promise<void>;
  collectStorageKeys(): Promise<{
    localStorageKeys: string[];
    sessionStorageKeys: string[];
  }>;
  collectSelectorCandidates(): Promise<SelectorCandidate[]>;
  captureScreenshot(label: string): Promise<string>;
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

export function createCaptureBrowserController(input: CreateCaptureBrowserControllerInput) {
  const timeline = createBrowserTimeline(input.jobId);
  let windowHandle: CaptureBrowserWindowHandle | null = null;

  return {
    async start() {
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
      });

      await windowHandle.loadURL(buildBmcUrl(input.target));
    },
    async collectPageFacts(label: string) {
      if (!windowHandle) {
        throw new Error('Capture browser has not started');
      }

      timeline.recordStorageSnapshot(await windowHandle.collectStorageKeys());
      timeline.recordScreenshot(await windowHandle.captureScreenshot(label));
      timeline.recordSelectorCandidates(await windowHandle.collectSelectorCandidates());
    },
    timeline() {
      return timeline.toJSON();
    },
  };
}
