export interface PopupWindowDetails {
  url?: string;
  disposition?: string;
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

export function shouldAttachBeforePopupNavigate(url: string) {
  return /^https?:/i.test(String(url || '').trim());
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
