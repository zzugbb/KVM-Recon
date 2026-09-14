import type { CaptureTarget } from '../capture-pack/types';

export type ScreenshotRole = 'login' | 'home' | 'kvm-entry' | 'viewer' | 'error' | 'unknown';
export type CaptureWindowRole = 'main' | 'popup';

type CaptureWindowIdFields = {
  captureWindowId?: string;
  openerCaptureWindowId?: string;
};

type BrowserTimelineEvent =
  | {
      type: 'navigation' | 'hash-change';
      url: string;
      windowRole: CaptureWindowRole;
      timestamp: string;
    } & CaptureWindowIdFields
  | {
      type: 'popup';
      url: string;
      disposition: string;
      windowRole: CaptureWindowRole;
      timestamp: string;
    } & CaptureWindowIdFields
  | {
      type: 'storage-snapshot';
      localStorageKeys: string[];
      sessionStorageKeys: string[];
      localStorageAdded: string[];
      localStorageRemoved: string[];
      sessionStorageAdded: string[];
      sessionStorageRemoved: string[];
      windowRole: CaptureWindowRole;
      captureRole: ScreenshotRole;
      timestamp: string;
    } & CaptureWindowIdFields
  | {
      type: 'screenshot';
      path: string;
      sourcePath?: string;
      role: ScreenshotRole;
      windowRole: CaptureWindowRole;
      operatorConfirmed?: boolean;
      timestamp: string;
    } & CaptureWindowIdFields
  | {
      type: 'selector-candidates';
      candidates: SelectorCandidate[];
      windowRole: CaptureWindowRole;
      captureRole: ScreenshotRole;
      timestamp: string;
    } & CaptureWindowIdFields
  | {
      type: 'click';
      selector: string;
      text: string;
      tagName: string;
      windowRole: CaptureWindowRole;
      timestamp: string;
    } & CaptureWindowIdFields;

interface BrowserTimelineJson {
  jobId: string;
  events: BrowserTimelineEvent[];
}

interface PopupEventInput {
  url: string;
  disposition: string;
  windowRole?: CaptureWindowRole;
  captureWindowId?: string;
  openerCaptureWindowId?: string;
}

interface StorageSnapshotInput {
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  localStorageAdded?: string[];
  localStorageRemoved?: string[];
  sessionStorageAdded?: string[];
  sessionStorageRemoved?: string[];
  windowRole?: CaptureWindowRole;
  captureRole?: ScreenshotRole;
  captureWindowId?: string;
}

export interface ClickSummary {
  selector: string;
  text: string;
  tagName: string;
  windowRole?: CaptureWindowRole;
  captureWindowId?: string;
}

export function screenshotRoleFromLabel(label: string): ScreenshotRole {
  const normalized = label.toLowerCase();
  if (normalized === 'login') return 'login';
  if (normalized === 'home' || normalized === 'after-login') return 'home';
  if (normalized === 'kvm-entry' || normalized === 'kvm') return 'kvm-entry';
  if (normalized === 'viewer') return 'viewer';
  if (normalized === 'error') return 'error';
  return 'unknown';
}

export function isViewerScreenshotEvent(event: { type?: unknown; role?: unknown }): boolean {
  return event.type === 'screenshot' && event.role === 'viewer';
}

export function viewerScreenshotPaths(
  events: Array<{ type?: unknown; role?: unknown; path?: unknown }>,
): string[] {
  return events
    .filter(isViewerScreenshotEvent)
    .map(event => event.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}

export function diffKeyLists(previous: string[] | undefined, next: string[]) {
  const prev = new Set(previous || []);
  const upcoming = new Set(next);
  return {
    added: next.filter(key => !prev.has(key)),
    removed: [...prev].filter(key => !upcoming.has(key)),
  };
}

export interface SelectorCandidate {
  role: 'login' | 'kvm-entry' | 'viewer' | 'unknown';
  selector: string;
  confidence: number;
}

function nowIso() {
  return new Date().toISOString();
}

function withCaptureWindowId<T>(event: T, captureWindowId?: string): T {
  return captureWindowId ? { ...event, captureWindowId } : event;
}

export function buildBmcUrl(target: CaptureTarget): string {
  return `${target.scheme}://${target.host}:${target.port}/`;
}

function isIpAddress(host: string) {
  const value = host.replace(/^\[|\]$/g, '');
  const ipv4 = value.split('.');
  if (
    ipv4.length === 4 &&
    ipv4.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  ) {
    return true;
  }
  if (!value.includes(':')) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 0;
  } catch {
    return false;
  }
}

export function shouldAllowCertificateError(input: {
  targetHost: string;
  url: string;
}): boolean {
  try {
    const parsed = new URL(input.url);
    if (parsed.hostname === input.targetHost) return true;
    // 现场常用 IP 打开 BMC：证书 CN / 跳转主机名往往不是该 IP，Chrome 要点「高级」继续。
    // 采集窗口没有该拦截页，主机名对不上就会白屏。目标已是 IP 时放行该采集会话内的证书错误。
    return isIpAddress(input.targetHost);
  } catch {
    return false;
  }
}

export function createBrowserTimeline(jobId: string) {
  const events: BrowserTimelineEvent[] = [];

  return {
    recordNavigation(url: string, windowRole: CaptureWindowRole = 'main', captureWindowId?: string) {
      events.push(
        withCaptureWindowId(
          {
            type: 'navigation',
            url,
            windowRole,
            timestamp: nowIso(),
          },
          captureWindowId,
        ),
      );
    },
    recordHashChange(url: string, windowRole: CaptureWindowRole = 'main', captureWindowId?: string) {
      events.push(
        withCaptureWindowId(
          {
            type: 'hash-change',
            url,
            windowRole,
            timestamp: nowIso(),
          },
          captureWindowId,
        ),
      );
    },
    recordPopup(input: PopupEventInput) {
      events.push(
        withCaptureWindowId(
          {
            type: 'popup',
            url: input.url,
            disposition: input.disposition,
            windowRole: input.windowRole || 'main',
            timestamp: nowIso(),
            ...(input.openerCaptureWindowId
              ? { openerCaptureWindowId: input.openerCaptureWindowId }
              : {}),
          },
          input.captureWindowId,
        ),
      );
    },
    recordStorageSnapshot(input: StorageSnapshotInput) {
      events.push(
        withCaptureWindowId(
          {
            type: 'storage-snapshot',
            localStorageKeys: input.localStorageKeys,
            sessionStorageKeys: input.sessionStorageKeys,
            localStorageAdded: input.localStorageAdded || [],
            localStorageRemoved: input.localStorageRemoved || [],
            sessionStorageAdded: input.sessionStorageAdded || [],
            sessionStorageRemoved: input.sessionStorageRemoved || [],
            windowRole: input.windowRole || 'main',
            captureRole: input.captureRole || 'unknown',
            timestamp: nowIso(),
          },
          input.captureWindowId,
        ),
      );
    },
    recordScreenshot(
      path: string,
      sourcePath?: string,
      role: ScreenshotRole = 'unknown',
      windowRole: CaptureWindowRole = 'main',
      operatorConfirmed = false,
      captureWindowId?: string,
    ) {
      events.push(
        withCaptureWindowId(
          {
            type: 'screenshot',
            path,
            role,
            windowRole,
            ...(operatorConfirmed ? { operatorConfirmed: true } : {}),
            ...(sourcePath ? { sourcePath } : {}),
            timestamp: nowIso(),
          },
          captureWindowId,
        ),
      );
    },
    recordClick(input: ClickSummary, windowRole: CaptureWindowRole = input.windowRole || 'main') {
      events.push(
        withCaptureWindowId(
          {
            type: 'click',
            selector: input.selector,
            text: input.text,
            tagName: input.tagName,
            windowRole,
            timestamp: nowIso(),
          },
          input.captureWindowId,
        ),
      );
    },
    recordSelectorCandidates(
      candidates: SelectorCandidate[],
      windowRole: CaptureWindowRole = 'main',
      captureRole: ScreenshotRole = 'unknown',
      captureWindowId?: string,
    ) {
      events.push(
        withCaptureWindowId(
          {
            type: 'selector-candidates',
            candidates,
            windowRole,
            captureRole,
            timestamp: nowIso(),
          },
          captureWindowId,
        ),
      );
    },
    toJSON(): BrowserTimelineJson {
      return {
        jobId,
        events: [...events],
      };
    },
  };
}
