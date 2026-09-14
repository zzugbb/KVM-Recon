import type { ScreenshotRole, SelectorCandidate } from './browserCaptureCore';
import { toPackScreenshotPath } from './collectScreenshotArtifacts';

interface BrowserTimelineJson {
  jobId: string;
  events: Array<{
    type: string;
    [key: string]: unknown;
  }>;
}

interface BrowserArtifact {
  path: string;
  content: string;
}

function stringify(data: unknown) {
  return JSON.stringify(data, null, 2);
}

function stringValues(event: { [key: string]: unknown }, key: string) {
  return Array.isArray(event[key])
    ? (event[key] as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function captureRole(value: unknown): ScreenshotRole {
  return ['login', 'home', 'kvm-entry', 'viewer', 'error'].includes(String(value))
    ? (value as ScreenshotRole)
    : 'unknown';
}

export function buildBrowserArtifacts(timeline: BrowserTimelineJson): BrowserArtifact[] {
  const storageEvents = timeline.events.filter(event => event.type === 'storage-snapshot');
  const selectorEvents = timeline.events.filter(event => event.type === 'selector-candidates');
  const screenshotEvents = timeline.events.filter(event => event.type === 'screenshot');
  const latestStorage = storageEvents.at(-1);
  const storageGroups = new Map<
    string,
    {
      windowRole: 'main' | 'popup';
      captureRole: string;
      localStorageKeys: string[];
      sessionStorageKeys: string[];
      localStorageAdded: string[];
      localStorageRemoved: string[];
      sessionStorageAdded: string[];
      sessionStorageRemoved: string[];
    }
  >();
  for (const event of storageEvents) {
    const windowRole = event.windowRole === 'popup' ? 'popup' : 'main';
    const eventCaptureRole = captureRole(event.captureRole);
    const key = `${windowRole}:${eventCaptureRole}`;
    const group = storageGroups.get(key) || {
      windowRole,
      captureRole: eventCaptureRole,
      localStorageKeys: [],
      sessionStorageKeys: [],
      localStorageAdded: [],
      localStorageRemoved: [],
      sessionStorageAdded: [],
      sessionStorageRemoved: [],
    };
    for (const field of [
      'localStorageKeys',
      'sessionStorageKeys',
      'localStorageAdded',
      'localStorageRemoved',
      'sessionStorageAdded',
      'sessionStorageRemoved',
    ] as const) {
      group[field] = unique([...group[field], ...stringValues(event, field)]);
    }
    storageGroups.set(key, group);
  }
  const storageSnapshots = [...storageGroups.values()];
  const selectorsByKey = new Map<
    string,
    SelectorCandidate & { windowRole: 'main' | 'popup'; captureRole: string }
  >();
  for (const event of selectorEvents) {
    const windowRole = event.windowRole === 'popup' ? 'popup' : 'main';
    const eventCaptureRole = captureRole(event.captureRole);
    const candidates = Array.isArray(event.candidates)
      ? (event.candidates as SelectorCandidate[])
      : [];
    for (const candidate of candidates) {
      const key = `${windowRole}:${eventCaptureRole}:${candidate.role}:${candidate.selector}`;
      const previous = selectorsByKey.get(key);
      if (!previous || candidate.confidence > previous.confidence) {
        selectorsByKey.set(key, { ...candidate, windowRole, captureRole: eventCaptureRole });
      }
    }
  }
  const selectors = [...selectorsByKey.values()];
  const screenshots = screenshotEvents
    .map(event => {
      const path = typeof event.path === 'string' ? toPackScreenshotPath(event.path) : '';
      if (!path) return null;
      return {
        path,
        role: typeof event.role === 'string' ? event.role : 'unknown',
        windowRole: event.windowRole === 'popup' ? 'popup' : 'main',
        ...(event.operatorConfirmed === true ? { operatorConfirmed: true } : {}),
      };
    })
    .filter((item): item is { path: string; role: string; windowRole: string } => Boolean(item));

  return [
    {
      path: 'page/timeline.jsonl',
      content:
        timeline.events
          .map(event => {
            const normalized = {
              ...event,
              windowRole: event.windowRole === 'popup' ? 'popup' : 'main',
              ...(['storage-snapshot', 'selector-candidates'].includes(event.type)
                ? { captureRole: captureRole(event.captureRole) }
                : {}),
            };
            if (event.type !== 'screenshot') return JSON.stringify(normalized);
            const { sourcePath: _sourcePath, ...rest } = event;
            return JSON.stringify({
              ...rest,
              windowRole: normalized.windowRole,
              path: typeof rest.path === 'string' ? toPackScreenshotPath(rest.path) : rest.path,
            });
          })
          .join('\n') + '\n',
    },
    {
      path: 'page/storage.json',
      content: stringify({
        localStorageKeys: unique(storageSnapshots.flatMap(snapshot => snapshot.localStorageKeys)),
        sessionStorageKeys: unique(storageSnapshots.flatMap(snapshot => snapshot.sessionStorageKeys)),
        localStorageAdded: unique(storageSnapshots.flatMap(snapshot => snapshot.localStorageAdded)),
        localStorageRemoved: unique(storageSnapshots.flatMap(snapshot => snapshot.localStorageRemoved)),
        sessionStorageAdded: unique(storageSnapshots.flatMap(snapshot => snapshot.sessionStorageAdded)),
        sessionStorageRemoved: unique(storageSnapshots.flatMap(snapshot => snapshot.sessionStorageRemoved)),
        windowRole: latestStorage?.windowRole === 'popup' ? 'popup' : 'main',
        windowRoles: unique(storageSnapshots.map(snapshot => snapshot.windowRole)),
        snapshots: storageSnapshots,
      }),
    },
    {
      path: 'page/selectors.json',
      content: stringify(selectors),
    },
    {
      path: 'page/screenshots.json',
      content: stringify(screenshots),
    },
  ];
}
