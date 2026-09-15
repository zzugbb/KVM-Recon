export interface PopupWindowDetails {
  url?: string;
  disposition?: string;
  frameName?: string;
  referrer?: { policy?: string; url?: string };
  postBody?: unknown;
}

export interface PopupWindowFactsInput {
  childCaptureWindowId: string;
  openerCaptureWindowId: string;
  openerAncestorCaptureWindowIds?: string[];
  details?: PopupWindowDetails | null;
  fallbackUrl?: string;
}

export function childWindowLineage(input: {
  openerCaptureWindowId: string;
  openerAncestorCaptureWindowIds?: string[];
}) {
  return {
    openerCaptureWindowId: input.openerCaptureWindowId,
    ancestorCaptureWindowIds: [
      input.openerCaptureWindowId,
      ...(input.openerAncestorCaptureWindowIds || []),
    ],
  };
}

export function nativePopupWindowOpenHandler(input: { partition: string }) {
  return {
    action: 'allow' as const,
    overrideBrowserWindowOptions: {
      width: 1280,
      height: 860,
      webPreferences: {
        partition: input.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: false,
      },
    },
  };
}

export function popupWindowFacts(input: PopupWindowFactsInput) {
  return {
    url: String(input.details?.url || input.fallbackUrl || '').trim(),
    disposition: input.details?.disposition || 'new-window',
    windowRole: 'popup' as const,
    captureWindowId: input.childCaptureWindowId,
    ...childWindowLineage({
      openerCaptureWindowId: input.openerCaptureWindowId,
      openerAncestorCaptureWindowIds: input.openerAncestorCaptureWindowIds,
    }),
  };
}
