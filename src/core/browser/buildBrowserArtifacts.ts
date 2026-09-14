import type { SelectorCandidate } from './browserCaptureCore';
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

export function buildBrowserArtifacts(timeline: BrowserTimelineJson): BrowserArtifact[] {
  const storageEvents = timeline.events.filter(event => event.type === 'storage-snapshot');
  const selectorEvents = timeline.events.filter(event => event.type === 'selector-candidates');
  const screenshotEvents = timeline.events.filter(event => event.type === 'screenshot');
  const latestStorage = storageEvents.at(-1) || {
    localStorageKeys: [],
    sessionStorageKeys: [],
    localStorageAdded: [],
    localStorageRemoved: [],
    sessionStorageAdded: [],
    sessionStorageRemoved: [],
    windowRole: 'main',
  };
  const latestSelectorEvent = selectorEvents.at(-1);
  const selectors = (latestSelectorEvent?.candidates || []) as SelectorCandidate[];
  const screenshots = screenshotEvents
    .map(event => {
      const path = typeof event.path === 'string' ? toPackScreenshotPath(event.path) : '';
      if (!path) return null;
      return {
        path,
        role: typeof event.role === 'string' ? event.role : 'unknown',
        windowRole: event.windowRole === 'popup' ? 'popup' : 'main',
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
        localStorageKeys: latestStorage.localStorageKeys || [],
        sessionStorageKeys: latestStorage.sessionStorageKeys || [],
        localStorageAdded: latestStorage.localStorageAdded || [],
        localStorageRemoved: latestStorage.localStorageRemoved || [],
        sessionStorageAdded: latestStorage.sessionStorageAdded || [],
        sessionStorageRemoved: latestStorage.sessionStorageRemoved || [],
        windowRole: latestStorage.windowRole === 'popup' ? 'popup' : 'main',
      }),
    },
    {
      path: 'page/selectors.json',
      content: stringify(
        selectors.map(candidate => ({
          ...candidate,
          windowRole: latestSelectorEvent?.windowRole === 'popup' ? 'popup' : 'main',
        })),
      ),
    },
    {
      path: 'page/screenshots.json',
      content: stringify(screenshots),
    },
  ];
}
