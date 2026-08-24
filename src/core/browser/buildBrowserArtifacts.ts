import type { SelectorCandidate } from './browserCaptureCore';

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
  };
  const latestSelectorEvent = selectorEvents.at(-1);
  const selectors = (latestSelectorEvent?.candidates || []) as SelectorCandidate[];
  const screenshots = screenshotEvents
    .map(event => event.path)
    .filter((path): path is string => typeof path === 'string');

  return [
    {
      path: 'page/timeline.jsonl',
      content: timeline.events.map(event => JSON.stringify(event)).join('\n') + '\n',
    },
    {
      path: 'page/storage.json',
      content: stringify({
        localStorageKeys: latestStorage.localStorageKeys || [],
        sessionStorageKeys: latestStorage.sessionStorageKeys || [],
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
