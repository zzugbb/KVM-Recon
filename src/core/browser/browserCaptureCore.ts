import type { CaptureTarget } from '../capture-pack/types';

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
      timestamp: string;
    }
  | {
      type: 'screenshot';
      path: string;
      timestamp: string;
    }
  | {
      type: 'selector-candidates';
      candidates: SelectorCandidate[];
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
    return parsed.hostname === input.targetHost;
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
        timestamp: nowIso(),
      });
    },
    recordScreenshot(path: string) {
      events.push({
        type: 'screenshot',
        path,
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
