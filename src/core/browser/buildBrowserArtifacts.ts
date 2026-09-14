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

function windowRoleOf(event: { [key: string]: unknown }): 'main' | 'popup' {
  return event.windowRole === 'popup' ? 'popup' : 'main';
}

function captureWindowIdOf(event: { [key: string]: unknown }) {
  return typeof event.captureWindowId === 'string' && event.captureWindowId
    ? event.captureWindowId
    : undefined;
}

function windowGroupKey(event: { [key: string]: unknown }, captureRoleValue: string) {
  return `${captureWindowIdOf(event) || windowRoleOf(event)}:${captureRoleValue}`;
}

function withCaptureWindowId<T>(item: T, captureWindowId?: string): T {
  return captureWindowId ? { ...item, captureWindowId } : item;
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
      captureWindowId?: string;
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
    const windowRole = windowRoleOf(event);
    const eventCaptureRole = captureRole(event.captureRole);
    const captureWindowId = captureWindowIdOf(event);
    const key = windowGroupKey(event, eventCaptureRole);
    const group = storageGroups.get(key) || {
      windowRole,
      ...(captureWindowId ? { captureWindowId } : {}),
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
  const captureWindowIds = unique(
    storageSnapshots
      .map(snapshot => snapshot.captureWindowId)
      .filter((value): value is string => Boolean(value)),
  );
  const selectorsByKey = new Map<
    string,
    SelectorCandidate & { windowRole: 'main' | 'popup'; captureRole: string; captureWindowId?: string }
  >();
  for (const event of selectorEvents) {
    const windowRole = windowRoleOf(event);
    const eventCaptureRole = captureRole(event.captureRole);
    const captureWindowId = captureWindowIdOf(event);
    const candidates = Array.isArray(event.candidates)
      ? (event.candidates as SelectorCandidate[])
      : [];
    for (const candidate of candidates) {
      const key = `${windowGroupKey(event, eventCaptureRole)}:${candidate.role}:${candidate.selector}`;
      const previous = selectorsByKey.get(key);
      if (!previous || candidate.confidence > previous.confidence) {
        selectorsByKey.set(
          key,
          withCaptureWindowId(
            { ...candidate, windowRole, captureRole: eventCaptureRole },
            captureWindowId,
          ),
        );
      }
    }
  }
  const selectors = [...selectorsByKey.values()];
  const scriptEvents = timeline.events.filter(event => event.type === 'page-scripts');
  const referencedScripts: Array<{
    url: string;
    kind: 'javascript' | 'html';
    initiator?: string;
    windowRole: 'main' | 'popup';
    captureWindowId?: string;
  }> = [];
  const referencedKeys = new Set<string>();
  for (const event of scriptEvents) {
    const scripts = Array.isArray(event.scripts) ? event.scripts : [];
    for (const item of scripts) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { url?: unknown; kind?: unknown; initiator?: unknown };
      if (typeof record.url !== 'string' || !record.url) continue;
      const key = `${record.url}\0${captureWindowIdOf(event) || windowRoleOf(event)}`;
      if (referencedKeys.has(key)) continue;
      referencedKeys.add(key);
      referencedScripts.push(
        withCaptureWindowId(
          {
            url: record.url,
            kind: record.kind === 'html' ? 'html' : 'javascript',
            ...(typeof record.initiator === 'string' && record.initiator
              ? { initiator: record.initiator }
              : {}),
            windowRole: windowRoleOf(event),
          },
          captureWindowIdOf(event),
        ),
      );
    }
  }
  const screenshots = screenshotEvents
    .map(event => {
      const path = typeof event.path === 'string' ? toPackScreenshotPath(event.path) : '';
      if (!path) return null;
      return withCaptureWindowId(
        {
          path,
          role: typeof event.role === 'string' ? event.role : 'unknown',
          windowRole: windowRoleOf(event),
          ...(event.operatorConfirmed === true ? { operatorConfirmed: true } : {}),
        },
        captureWindowIdOf(event),
      );
    })
    .filter(
      (
        item,
      ): item is {
        path: string;
        role: string;
        windowRole: 'main' | 'popup';
        operatorConfirmed?: boolean;
        captureWindowId?: string;
      } => Boolean(item),
    );

  return [
    {
      path: 'page/timeline.jsonl',
      content:
        timeline.events
          .map(event => {
            const normalized = withCaptureWindowId(
              {
                ...event,
                windowRole: windowRoleOf(event),
                ...(['storage-snapshot', 'selector-candidates'].includes(event.type)
                  ? { captureRole: captureRole(event.captureRole) }
                  : {}),
              },
              captureWindowIdOf(event),
            );
            if (event.type !== 'screenshot') return JSON.stringify(normalized);
            const { sourcePath: _sourcePath, ...rest } = event;
            return JSON.stringify({
              ...rest,
              windowRole: windowRoleOf(rest),
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
        ...(captureWindowIds.length ? { captureWindowIds } : {}),
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
    ...(referencedScripts.length
      ? [
          {
            path: 'page/scripts.json',
            content: stringify(referencedScripts),
          },
        ]
      : []),
  ];
}
