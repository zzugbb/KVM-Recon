import { describe, expect, it, vi } from 'vitest';
import { createBrowserRequestCancellationTracker, type BrowserRequestEvent } from './browserRequestCancellation';

const start: BrowserRequestEvent = {
  kind: 'before-request', requestId: 7, url: 'https://bmc.test/security', method: 'GET',
  timestamp: 1000, mainFrame: true, resourceType: 'xhr',
};
const error: BrowserRequestEvent = { ...start, kind: 'request-error', timestamp: 1100, error: 'net::ERR_ABORTED' };
const request = {
  requestId: 'cdp-1', frameId: 'main', loaderId: 'old', wallTime: 1,
  type: 'XHR', request: { url: start.url, method: start.method },
};
const navigation = { frame: { id: 'main', loaderId: 'new' } };
function harness() {
  const record = vi.fn(async (_row: unknown) => {});
  const cancel = vi.fn(async (_id: string) => {});
  const isPending = vi.fn(() => true);
  const tracker = createBrowserRequestCancellationTracker({ record, cancel, isPending });
  return { ...tracker, record, cancel, isPending };
}

describe('浏览器请求取消证据关联', () => {
  it('连续取消 600 个已收到 CDP 结束事件的请求，不反复扫描历史终态', async () => {
    let recorded = 0;
    let cancelled = 0;
    const h = createBrowserRequestCancellationTracker({
      record: async () => { recorded += 1; }, isPending: () => true,
      cancel: async () => { cancelled += 1; },
    });
    const began = performance.now();
    for (let i = 0; i < 600; i += 1) {
      const url = `${start.url}?request=${i}`;
      const native = { ...start, requestId: i, url };
      await h.observeBrowser(native);
      await h.observeCdp('Network.requestWillBeSent', {
        ...request, requestId: `cdp-${i}`, request: { url, method: 'GET' },
      }, `http-${i}`);
      await h.observeBrowser({ ...native, kind: 'request-error', error: 'net::ERR_ABORTED', timestamp: 1100 });
      await h.observeCdp('Network.loadingFailed', { requestId: `cdp-${i}` });
    }
    expect(recorded).toBe(1200);
    expect(cancelled).toBe(0);
    // 旧算法纯内存就需数秒；留出远大于修复后耗时的余量，检测数量级退化。
    expect(performance.now() - began).toBeLessThan(2000);
  }, 30000);

  it.each([true, false])('取消事件与跨文档导航不同到达顺序都能收口（取消先到=%s）', async errorFirst => {
    const h = harness();
    await h.observeBrowser(start);
    await h.observeCdp('Network.requestWillBeSent', request, 'http-1');
    if (errorFirst) await h.observeBrowser(error);
    await h.observeCdp('Page.frameNavigated', navigation);
    if (!errorFirst) await h.observeBrowser(error);
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith('http-1');
    expect(h.record).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'navigation-cancellation', requestId: 7, httpId: 'http-1', error: 'net::ERR_ABORTED',
    }));
    await h.observeBrowser(error);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('取消早于排队的 CDP 请求事实也保留，等事实齐备才关联', async () => {
    const h = harness();
    await h.observeBrowser(start);
    await h.observeBrowser(error);
    await h.observeCdp('Page.frameNavigated', navigation);
    expect(h.cancel).not.toHaveBeenCalled();
    await h.observeCdp('Network.requestWillBeSent', request, 'http-1');
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith('http-1');
  });

  it.each(['no-error', 'unknown-start', 'other-error', 'same-document', 'subframe', 'other-frame',
    'native-response', 'cdp-response', 'cdp-extra-info', 'finished', 'failed', 'not-pending',
    'native-duplicate', 'cdp-duplicate', 'redirect', 'other-method', 'other-url', 'future-request',
    'old-request', 'invalid-error-clock', 'no-clock'])
  ('%s 不得被误认为可补齐的导航取消', async scenario => {
    const h = harness();
    if (scenario !== 'unknown-start') await h.observeBrowser({ ...start, mainFrame: scenario !== 'subframe' });
    if (scenario === 'native-duplicate') await h.observeBrowser({ ...start, requestId: 8 });
    const params = { ...request, ...(scenario === 'no-clock' ? { wallTime: undefined } : {}),
      ...(scenario === 'future-request' ? { wallTime: 2 } : {}),
      ...(scenario === 'old-request' ? { wallTime: 0.5 } : {}) };
    await h.observeCdp('Network.requestWillBeSent', params, 'http-1');
    if (scenario === 'cdp-duplicate' || scenario === 'redirect') {
      await h.observeCdp('Network.requestWillBeSent', { ...request,
        requestId: scenario === 'redirect' ? 'cdp-1' : 'cdp-2' }, 'http-2');
    }
    if (scenario === 'native-response') await h.observeBrowser({ ...start, kind: 'response-started' });
    const event = { 'cdp-response': 'Network.responseReceived', 'cdp-extra-info': 'Network.responseReceivedExtraInfo',
      finished: 'Network.loadingFinished', failed: 'Network.loadingFailed' }[scenario];
    if (event) await h.observeCdp(event, { requestId: 'cdp-1' });
    if (scenario === 'not-pending') h.isPending.mockReturnValue(false);
    if (scenario !== 'no-error') await h.observeBrowser({ ...error,
      ...(scenario === 'invalid-error-clock' ? { timestamp: NaN } : {}),
      ...(scenario === 'other-error' ? { error: 'net::ERR_CONNECTION_RESET' } : {}),
      ...(scenario === 'other-method' ? { method: 'POST' } : {}),
      ...(scenario === 'other-url' ? { url: 'https://bmc.test/elsewhere' } : {}),
    });
    await h.observeCdp('Page.frameNavigated', { frame: { id: scenario === 'other-frame' ? 'elsewhere' : 'main',
      loaderId: scenario === 'same-document' ? 'old' : 'new' } });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('不同根窗口的同名请求和取消证据不能混用', async () => {
    const main = harness(); const popup = harness();
    await main.observeBrowser(start);
    await main.observeCdp('Network.requestWillBeSent', request, 'main-http');
    await main.observeCdp('Page.frameNavigated', navigation);
    await popup.observeBrowser(error);
    await popup.observeCdp('Page.frameNavigated', navigation);
    expect(main.cancel).not.toHaveBeenCalled();
    expect(popup.cancel).not.toHaveBeenCalled();
  });

  it('同 requestId 重定向改 URL 后，不得用旧 URL 索引关联上一跳', async () => {
    const h = harness();
    await h.observeBrowser(start);
    await h.observeCdp('Network.requestWillBeSent', request, 'http-1');
    await h.observeCdp('Network.requestWillBeSent', {
      ...request, request: { url: 'https://bmc.test/redirected', method: 'GET' },
    }, 'http-1::redirect-1');
    await h.observeBrowser(error);
    await h.observeCdp('Page.frameNavigated', navigation);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('原生同 requestId 开始下一跳后，不沿用上一跳的取消事件', async () => {
    const h = harness();
    await h.observeBrowser(start);
    await h.observeCdp('Network.requestWillBeSent', request, 'http-1');
    await h.observeBrowser(error);
    const url = 'https://bmc.test/redirected';
    await h.observeBrowser({ ...start, url });
    await h.observeCdp('Network.requestWillBeSent', { ...request, request: { url, method: 'GET' } }, 'redirect-1');
    await h.observeCdp('Page.frameNavigated', navigation);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('证据写盘失败不得提交取消语义', async () => {
    const h = harness();
    await h.observeBrowser(start);
    await h.observeCdp('Network.requestWillBeSent', request, 'http-1');
    await h.observeBrowser(error);
    h.record.mockRejectedValueOnce(new Error('disk full'));
    await expect(h.observeCdp('Page.frameNavigated', navigation)).rejects.toThrow('disk full');
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
