import { describe, expect, it } from 'vitest';

import { pickCaptureWindow } from './pickCaptureWindow';

interface FakeWindow {
  id: string;
  role: 'main' | 'popup';
  hasSurface: boolean;
}

const windows = {
  main: { id: 'main', role: 'main' as const, hasSurface: false },
  kvm: { id: 'popup-kvm', role: 'popup' as const, hasSurface: true },
  help: { id: 'popup-help', role: 'popup' as const, hasSurface: false },
  vmedia: { id: 'popup-vmedia', role: 'popup' as const, hasSurface: true },
};

function pick(
  alive: FakeWindow[],
  options: {
    preferredCaptureWindowId?: string;
    preferredWindowRole?: 'main' | 'popup';
    requireKvmSurface?: boolean;
    foreground?: FakeWindow | null;
  },
) {
  return pickCaptureWindow({
    alive,
    foreground: options.foreground ?? null,
    preferredCaptureWindowId: options.preferredCaptureWindowId,
    preferredWindowRole: options.preferredWindowRole,
    requireKvmSurface: options.requireKvmSurface,
    windowId: window => window.id,
    windowRole: window => window.role,
    hasKvmSurface: async window => window.hasSurface,
  });
}

describe('pickCaptureWindow', () => {
  it('uses only the preferred window when a captureWindowId is given', async () => {
    await expect(
      pick([windows.main, windows.help, windows.kvm], {
        preferredCaptureWindowId: 'popup-kvm',
        preferredWindowRole: 'popup',
        requireKvmSurface: true,
        foreground: windows.help,
      }),
    ).resolves.toEqual(windows.kvm);
  });

  it('does not fall back to another popup when the preferred viewer has no surface yet', async () => {
    await expect(
      pick([windows.main, windows.help, windows.vmedia], {
        preferredCaptureWindowId: 'popup-help',
        preferredWindowRole: 'popup',
        requireKvmSurface: true,
        foreground: windows.vmedia,
      }),
    ).resolves.toBeNull();
  });

  it('returns the preferred window without requiring a surface for operator-confirmed shots', async () => {
    await expect(
      pick([windows.main, windows.help, windows.vmedia], {
        preferredCaptureWindowId: 'popup-help',
        requireKvmSurface: false,
        foreground: windows.main,
      }),
    ).resolves.toEqual(windows.help);
  });

  it('returns null when the preferred window is gone instead of picking a sibling popup', async () => {
    await expect(
      pick([windows.main, windows.vmedia], {
        preferredCaptureWindowId: 'popup-kvm',
        preferredWindowRole: 'popup',
        requireKvmSurface: true,
        foreground: windows.vmedia,
      }),
    ).resolves.toBeNull();
  });
});
