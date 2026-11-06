import type { Session, OnBeforeRequestListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails } from 'electron';
import type { CaptureSession } from '../../core/collector/createCaptureSession';
import type { BrowserRequestEvent } from '../../core/collector/browserRequestCancellation';

/** 只观察浏览器进程事实，不拦截、重试、取消或改写请求。分区内与现有 beforeRequest 共用入口。 */
export function createElectronRequestObserver(
  electronSession: Session,
  capture: Pick<CaptureSession, 'recordBrowserRequest'>,
  targetForContents: (contentsId: number) => string | undefined,
) {
  function observe(kind: BrowserRequestEvent['kind'],
    details: OnBeforeRequestListenerDetails | OnErrorOccurredListenerDetails | OnResponseStartedListenerDetails) {
    if (details.webContentsId === undefined) return;
    const targetId = targetForContents(details.webContentsId);
    if (!targetId) return;
    let mainFrame = false;
    // 错误通知到达时旧 frame 可能已销毁，归属以 before-request 时保存的事实为准。
    try { mainFrame = !!details.frame && details.frame.parent === null; } catch { /* 已销毁 */ }
    capture.recordBrowserRequest(targetId, {
      kind, requestId: details.id, url: details.url, method: details.method,
      timestamp: details.timestamp, resourceType: details.resourceType, mainFrame,
      ...('error' in details ? { error: details.error } : {}),
    });
  }
  electronSession.webRequest.onResponseStarted(details => observe('response-started', details));
  electronSession.webRequest.onErrorOccurred(details => observe('request-error', details));
  return {
    beforeRequest: (details: OnBeforeRequestListenerDetails) => observe('before-request', details),
    dispose() {
      electronSession.webRequest.onResponseStarted(null);
      electronSession.webRequest.onErrorOccurred(null);
    },
  };
}
