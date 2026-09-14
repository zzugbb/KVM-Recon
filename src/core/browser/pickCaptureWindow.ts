export interface PickCaptureWindowInput<T> {
  alive: T[];
  foreground: T | null;
  preferredCaptureWindowId?: string;
  preferredWindowRole?: 'main' | 'popup';
  requireKvmSurface?: boolean;
  windowId(window: T): string;
  windowRole(window: T): 'main' | 'popup';
  hasKvmSurface(window: T): Promise<boolean>;
}

/**
 * 有 preferredCaptureWindowId 时只使用该窗口，找不到或暂无 KVM 画面则返回 null，
 * 避免把帮助页/虚拟介质弹窗截成 viewer。
 */
export async function pickCaptureWindow<T>(input: PickCaptureWindowInput<T>): Promise<T | null> {
  const alive = input.alive;
  if (input.preferredCaptureWindowId) {
    const byId = alive.find(candidate => input.windowId(candidate) === input.preferredCaptureWindowId);
    if (!byId) return null;
    if (!input.requireKvmSurface) return byId;
    return (await input.hasKvmSurface(byId)) ? byId : null;
  }

  const preferred = alive.filter(
    candidate => !input.preferredWindowRole || input.windowRole(candidate) === input.preferredWindowRole,
  );
  const ordered = [...preferred, ...alive.filter(candidate => !preferred.includes(candidate))];
  const foregroundAlive =
    input.foreground != null && alive.includes(input.foreground) ? input.foreground : null;

  if (!input.requireKvmSurface) {
    if (
      foregroundAlive &&
      (!input.preferredWindowRole || input.windowRole(foregroundAlive) === input.preferredWindowRole)
    ) {
      return foregroundAlive;
    }
    return ordered[0] || null;
  }

  if (
    foregroundAlive &&
    (!input.preferredWindowRole || input.windowRole(foregroundAlive) === input.preferredWindowRole) &&
    (await input.hasKvmSurface(foregroundAlive))
  ) {
    return foregroundAlive;
  }
  for (const candidate of ordered) {
    if (candidate !== foregroundAlive && (await input.hasKvmSurface(candidate))) {
      return candidate;
    }
  }
  return null;
}
