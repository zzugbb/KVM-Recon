/** 浏览器进程的取消证据补充 CDP 跨文档导航漏发的 loadingFailed。
 * 每个根窗口独立实例；只关联两侧均唯一的主框架 XHR/Fetch，绝不按 URL 白名单放行。
 */
export type BrowserRequestEvent = {
  kind: 'before-request' | 'response-started' | 'request-error';
  requestId: number;
  url: string;
  method: string;
  timestamp: number;
  mainFrame: boolean;
  resourceType: string;
  error?: string;
};

type CdpRequest = {
  id: string; url: string; method: string; frameId: string; loaderId: string;
  resourceType: string; wallTime: number; receivedResponse: boolean; terminal: boolean;
};

export function createBrowserRequestCancellationTracker(deps: {
  record(row: unknown): Promise<void>;
  isPending(id: string): boolean;
  cancel(id: string): Promise<void>;
}) {
  const native = new Map<number, { start: BrowserRequestEvent; receivedResponse: boolean; error?: BrowserRequestEvent }>();
  const nativeCounts = new Map<string, number>();
  const cdp = new Map<string, CdpRequest>();
  const cdpByKey = new Map<string, CdpRequest>();
  const cdpCounts = new Map<string, number>();
  const frames = new Map<string, string>();
  const applied = new Set<number>();
  // 只重查尚未关联的取消事件；历史正常请求与已有 CDP 结束事件不再参与扫描。
  // 全历史计数仍保留，清理候选不能让同名并发/重试重新变为“唯一”。
  const pendingCancellations = new Set<number>();
  const key = (url: string, method: string) => JSON.stringify([url, method]);

  async function reconcile() {
    for (const requestId of pendingCancellations) {
      const observed = native.get(requestId)!;
      const { start, error } = observed;
      if (!error || observed.receivedResponse || applied.has(requestId) || error.error !== 'net::ERR_ABORTED' ||
          !start.mainFrame || start.resourceType !== 'xhr' ||
          error.url !== start.url || error.method !== start.method) {
        pendingCancellations.delete(requestId);
        continue;
      }
      const k = key(start.url, start.method);
      // 同名并发、重试、重定向以及来源不明的请求均保守保留原缺口。
      if ((nativeCounts.get(k) ?? 0) > 1 || (cdpCounts.get(k) ?? 0) > 1) {
        pendingCancellations.delete(requestId);
        continue;
      }
      const request = cdpByKey.get(k);
      if (request?.terminal || request?.receivedResponse) {
        pendingCancellations.delete(requestId);
        continue;
      }
      if (!request ||
          !['XHR', 'Fetch'].includes(request.resourceType) || !request.frameId || !request.loaderId ||
          !Number.isFinite(request.wallTime) || !Number.isFinite(start.timestamp) ||
          !Number.isFinite(error.timestamp) || error.timestamp < start.timestamp ||
          request.wallTime > error.timestamp ||
          // 两个进程上报同一次起始事件允许少量调度误差，不能配给历史残留请求。
          Math.abs(request.wallTime - start.timestamp) > 100 ||
          !frames.has(request.frameId) || frames.get(request.frameId) === request.loaderId ||
          !deps.isPending(request.id)) continue;
      // 两种 API 没有共享 requestId：保留独立原始事件和唯一关联依据，不能伪造 CDP 事件。
      await deps.record({ kind: 'navigation-cancellation', requestId, httpId: request.id,
        error: error.error, timestamp: error.timestamp, frameId: request.frameId,
        oldLoaderId: request.loaderId, newLoaderId: frames.get(request.frameId) });
      applied.add(requestId);
      pendingCancellations.delete(requestId);
      await deps.cancel(request.id);
    }
  }

  return {
    async observeBrowser(event: BrowserRequestEvent) {
      await deps.record(event);
      if (event.kind === 'before-request') {
        pendingCancellations.delete(event.requestId);
        const k = key(event.url, event.method);
        nativeCounts.set(k, (nativeCounts.get(k) ?? 0) + 1);
        native.set(event.requestId, { start: event, receivedResponse: false });
      } else {
        const known = native.get(event.requestId);
        if (known && event.kind === 'request-error') {
          known.error = event;
          pendingCancellations.add(event.requestId);
        }
        if (known && event.kind === 'response-started') known.receivedResponse = true;
      }
      await reconcile();
    },
    async observeCdp(method: string, params: Record<string, unknown>, httpId?: string) {
      if (method === 'Network.requestWillBeSent' && httpId) {
        const request = params.request as { url?: string; method?: string } | undefined;
        const url = request?.url ?? ''; const verb = request?.method ?? '';
        const k = key(url, verb);
        cdpCounts.set(k, (cdpCounts.get(k) ?? 0) + 1);
        const previous = cdp.get(String(params.requestId));
        if (previous && cdpByKey.get(key(previous.url, previous.method)) === previous) {
          cdpByKey.delete(key(previous.url, previous.method));
        }
        const next = { id: httpId, url, method: verb,
          frameId: String(params.frameId ?? ''), loaderId: String(params.loaderId ?? ''),
          resourceType: String(params.type ?? ''), wallTime: Number(params.wallTime) * 1000,
          receivedResponse: false, terminal: false };
        cdp.set(String(params.requestId), next);
        cdpByKey.set(k, next);
      } else if (method === 'Network.responseReceived' || method === 'Network.responseReceivedExtraInfo') {
        const request = cdp.get(String(params.requestId));
        if (request) request.receivedResponse = true;
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const request = cdp.get(String(params.requestId));
        if (request) request.terminal = true;
      } else if (method === 'Page.frameNavigated') {
        const frame = params.frame as { id?: string; loaderId?: string; parentId?: string } | undefined;
        if (frame?.id && frame.loaderId && !frame.parentId) frames.set(frame.id, frame.loaderId);
      } else return;
      await reconcile();
    },
  };
}
