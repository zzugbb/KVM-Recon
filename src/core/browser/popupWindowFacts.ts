export interface PopupWindowDetails {
  url?: string;
  disposition?: string;
}

export interface PopupWindowFactsInput {
  childCaptureWindowId: string;
  openerCaptureWindowId: string;
  details?: PopupWindowDetails | null;
  fallbackUrl?: string;
}

export function popupWindowFacts(input: PopupWindowFactsInput) {
  return {
    url: String(input.details?.url || input.fallbackUrl || '').trim(),
    disposition: input.details?.disposition || 'new-window',
    windowRole: 'popup' as const,
    captureWindowId: input.childCaptureWindowId,
    openerCaptureWindowId: input.openerCaptureWindowId,
  };
}
