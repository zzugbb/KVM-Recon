/**
 * CDP 会话最小接口（与 Electron `webContents.debugger` 对齐）。
 * 根会话不得把空 sessionId 传给 sendCommand（Electron 44 会拒绝）。
 */

export interface CdpSession {
  attach(protocolVersion: string): Promise<void> | void;
  isAttached?: () => boolean;
  sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> | unknown;
  on(
    event: 'message',
    listener: (
      event: unknown,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): void;
  /** 移除 message 监听（挂载失败清理用；Electron debugger 支持 off/removeListener）。 */
  off?(
    event: 'message',
    listener: (
      event: unknown,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): void;
  /** 断开 debugger（挂载失败清理用）。 */
  detach?(): Promise<void> | void;
}

export function sendCdpCommand(
  cdp: CdpSession,
  command: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<unknown> | unknown {
  if (typeof sessionId === 'string' && sessionId) {
    return cdp.sendCommand(command, params, sessionId);
  }
  return cdp.sendCommand(command, params);
}
