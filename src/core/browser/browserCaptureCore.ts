import net from 'node:net';
import type { CaptureTarget } from '../capture-pack/types';

export type ScreenshotRole = 'login' | 'home' | 'kvm-entry' | 'viewer' | 'error' | 'unknown';

type BrowserTimelineEvent =
  | {
      type: 'navigation' | 'hash-change';
      url: string;
      timestamp: string;
    }
  | {
      type: 'popup';
      url: string;
      disposition: string;
      timestamp: string;
    }
  | {
      type: 'storage-snapshot';
      localStorageKeys: string[];
      sessionStorageKeys: string[];
      localStorageAdded: string[];
      localStorageRemoved: string[];
      sessionStorageAdded: string[];
      sessionStorageRemoved: string[];
      timestamp: string;
    }
  | {
      type: 'screenshot';
      path: string;
      sourcePath?: string;
      role: ScreenshotRole;
      timestamp: string;
    }
  | {
      type: 'selector-candidates';
      candidates: SelectorCandidate[];
      timestamp: string;
    }
  | {
      type: 'click';
      selector: string;
      text: string;
      tagName: string;
      timestamp: string;
    };

interface BrowserTimelineJson {
  jobId: string;
  events: BrowserTimelineEvent[];
}

interface PopupEventInput {
  url: string;
  disposition: string;
}

interface StorageSnapshotInput {
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  localStorageAdded?: string[];
  localStorageRemoved?: string[];
  sessionStorageAdded?: string[];
  sessionStorageRemoved?: string[];
}

export interface ClickSummary {
  selector: string;
  text: string;
  tagName: string;
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

export function buildBmcUrl(target: CaptureTarget): string {
  return `${target.scheme}://${target.host}:${target.port}/`;
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
    return net.isIP(input.targetHost) !== 0;
  } catch {
    return false;
  }
}

export function createBrowserTimeline(jobId: string) {
  const events: BrowserTimelineEvent[] = [];

  return {
    recordNavigation(url: string) {
      events.push({
        type: 'navigation',
        url,
        timestamp: nowIso(),
      });
    },
    recordHashChange(url: string) {
      events.push({
        type: 'hash-change',
        url,
        timestamp: nowIso(),
      });
    },
    recordPopup(input: PopupEventInput) {
      events.push({
        type: 'popup',
        url: input.url,
        disposition: input.disposition,
        timestamp: nowIso(),
      });
    },
    recordStorageSnapshot(input: StorageSnapshotInput) {
      events.push({
        type: 'storage-snapshot',
        localStorageKeys: input.localStorageKeys,
        sessionStorageKeys: input.sessionStorageKeys,
        localStorageAdded: input.localStorageAdded || [],
        localStorageRemoved: input.localStorageRemoved || [],
        sessionStorageAdded: input.sessionStorageAdded || [],
        sessionStorageRemoved: input.sessionStorageRemoved || [],
        timestamp: nowIso(),
      });
    },
    recordScreenshot(path: string, sourcePath?: string, role: ScreenshotRole = 'unknown') {
      events.push({
        type: 'screenshot',
        path,
        role,
        ...(sourcePath ? { sourcePath } : {}),
        timestamp: nowIso(),
      });
    },
    recordClick(input: ClickSummary) {
      events.push({
        type: 'click',
        selector: input.selector,
        text: input.text,
        tagName: input.tagName,
        timestamp: nowIso(),
      });
    },
    recordSelectorCandidates(candidates: SelectorCandidate[]) {
      events.push({
        type: 'selector-candidates',
        candidates,
        timestamp: nowIso(),
      });
    },
    toJSON(): BrowserTimelineJson {
      return {
        jobId,
        events: [...events],
      };
    },
  };
}
