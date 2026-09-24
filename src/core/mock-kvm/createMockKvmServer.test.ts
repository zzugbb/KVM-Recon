import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createMockKvmServer, type MockKvmHandle } from './createMockKvmServer';

let handles: MockKvmHandle[] = [];

async function bootMock(options: { seed?: string } = {}): Promise<MockKvmHandle> {
  const handle = await createMockKvmServer(options);
  handles.push(handle);
  return handle;
}

/** 与登录页内联脚本一致的摘要凭据：SHA-256(operator-passphrase:nonce)。 */
function digestCredential(loginPageHtml: string, nonceFieldName: string): string {
  const nonceMatch = new RegExp(`name="${nonceFieldName}" value="([^"]+)"`).exec(loginPageHtml);
  const nonce = nonceMatch ? nonceMatch[1] : '';
  return createHash('sha256').update(`operator-passphrase:${nonce}`).digest('hex');
}

// Node（undici）的 WebSocket 运行时支持 { headers } 选项（握手携带 Cookie），DOM 类型声明未包含。
const WebSocketWithHeaders = WebSocket as unknown as new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket;

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

describe('createMockKvmServer（规范 §19 阶段 0 / §20）', () => {
  it('每次启动随机生成不同 URL；固定 seed 时可复现', async () => {
    const first = await bootMock();
    const second = await bootMock();
    expect(first.randomTag).not.toBe(second.randomTag);
    expect(first.paths.loginApi).not.toBe(second.paths.loginApi);

    const seededA = await bootMock({ seed: 'acceptance-1' });
    const seededB = await bootMock({ seed: 'acceptance-1' });
    expect(seededA.paths).toEqual(seededB.paths);
    expect(seededA.loginFieldNames).toEqual(seededB.loginFieldNames);

    const otherSeed = await bootMock({ seed: 'acceptance-2' });
    expect(otherSeed.paths.loginApi).not.toBe(seededA.paths.loginApi);
  });

  it('随机 URL 不依赖常见 BMC 路径', async () => {
    const handle = await bootMock();
    const allUrls = Object.values(handle.urls);
    for (const url of allUrls) {
      expect(url).not.toMatch(/\/api\/|\/redfish|kvmservice|setkvmkey|starth5kvm|ircport|vconsole|html5viewer/i);
    }
  });

  it('完整链路可驱动：登录页 → 登录 API → 控制台 → 启动 → Viewer → Worker → 双向 WS', async () => {
    const handle = await bootMock({ seed: 'mock-kvm-drive' });

    const loginPage = await fetch(handle.urls.loginPage);
    expect(loginPage.status).toBe(200);
    const loginPageHtml = await loginPage.text();
    expect(loginPageHtml).toContain(handle.paths.loginApi);
    expect(loginPageHtml).not.toContain('api/session');
    // 登录页内联脚本真正执行 WebCrypto 摘要（阶段 2 Collector 必须捕获该运行时链）。
    expect(loginPageHtml).toContain('crypto.subtle.digest("SHA-256"');

    // 错误摘要凭据被服务端拒绝。
    const badLogin = await fetch(handle.urls.loginApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [handle.loginFieldNames.user]: 'operator',
        [handle.loginFieldNames.password]: 'deadbeef',
      }),
    });
    expect(badLogin.status).toBe(401);

    const credential = digestCredential(loginPageHtml, handle.loginFieldNames.nonce);
    const login = await fetch(handle.urls.loginApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [handle.loginFieldNames.user]: 'operator',
        [handle.loginFieldNames.password]: credential,
      }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie();
    expect(setCookie.length).toBe(1);
    const sessionCookie = setCookie[0].split(';')[0];
    const loginPayload = (await login.json()) as { sessionToken: string; csrfToken: string };
    expect(loginPayload.sessionToken).toBeTruthy();
    expect(loginPayload.csrfToken).toBeTruthy();

    const entryWithoutSession = await fetch(handle.urls.consoleEntry);
    expect(entryWithoutSession.status).toBe(401);

    const consoleEntry = await fetch(handle.urls.consoleEntry, {
      headers: { cookie: sessionCookie },
    });
    expect(consoleEntry.status).toBe(200);
    const consoleEntryHtml = await consoleEntry.text();
    expect(consoleEntryHtml).toContain(handle.paths.kvmLaunch);
    expect(consoleEntryHtml).toContain(handle.paths.viewerPage);

    // KVM 启动接口真实校验 CSRF：只有 Cookie、没有 CSRF 头 → 403。
    const launchWithoutCsrf = await fetch(handle.urls.kvmLaunch, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    expect(launchWithoutCsrf.status).toBe(403);

    const launchWithWrongCsrf = await fetch(handle.urls.kvmLaunch, {
      method: 'POST',
      headers: { cookie: sessionCookie, [handle.csrfHeaderName]: 'deadbeef' },
    });
    expect(launchWithWrongCsrf.status).toBe(403);

    const launch = await fetch(handle.urls.kvmLaunch, {
      method: 'POST',
      headers: { cookie: sessionCookie, [handle.csrfHeaderName]: loginPayload.csrfToken },
    });
    expect(launch.status).toBe(200);
    const launchPayload = (await launch.json()) as { viewerToken: string; streamPath: string };
    expect(launchPayload.viewerToken).toBeTruthy();
    expect(launchPayload.streamPath).toBe(handle.paths.websocket);

    const viewerPage = await fetch(handle.urls.viewerPage, {
      headers: { cookie: sessionCookie },
    });
    expect(viewerPage.status).toBe(200);
    const viewerHtml = await viewerPage.text();
    expect(viewerHtml).toContain('<canvas');
    expect(viewerHtml).toContain(handle.paths.viewerWorker);
    expect(viewerHtml).toContain(handle.paths.websocket);

    const worker = await fetch(handle.urls.viewerWorker, { headers: { cookie: sessionCookie } });
    expect(worker.status).toBe(200);
    expect((worker.headers.get('content-type') || '').startsWith('application/javascript')).toBe(true);

    // WS 握手校验 Session Cookie 与 viewerToken（查询参数 t，与 Viewer 页脚本一致）。
    // 双向 WebSocket：3 个初始下行二进制帧 → 上行文本/二进制 → 回显 → 关闭。
    // message 事件可能同批同步派发，必须用常驻队列消费，不能逐次挂 once 监听器。
    const wsUrl = `${handle.urls.websocket}?t=${encodeURIComponent(launchPayload.viewerToken)}`;
    const frames: Array<{ direction: 'up' | 'down'; opcode: string; data: Uint8Array }> = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocketWithHeaders(wsUrl, { headers: { cookie: sessionCookie } });
      ws.binaryType = 'arraybuffer';
      const messageQueue: Array<{ opcode: 'text' | 'binary'; data: Uint8Array }> = [];
      let notify: (() => void) | null = null;
      ws.addEventListener('error', () => reject(new Error('mock KVM WebSocket 连接失败')));
      ws.addEventListener('message', event => {
        const data =
          typeof event.data === 'string'
            ? new Uint8Array(Buffer.from(event.data, 'utf8'))
            : new Uint8Array(event.data as ArrayBuffer);
        messageQueue.push({ opcode: typeof event.data === 'string' ? 'text' : 'binary', data });
        if (notify) {
          const ready = notify;
          notify = null;
          ready();
        }
      });
      const nextMessage = () =>
        new Promise<{ opcode: 'text' | 'binary'; data: Uint8Array }>(resolveMessage => {
          if (messageQueue.length > 0) {
            resolveMessage(messageQueue.shift()!);
            return;
          }
          notify = () => resolveMessage(messageQueue.shift()!);
        });
      ws.addEventListener('open', () => {
        void (async () => {
          try {
            for (let index = 0; index < 3; index += 1) {
              const message = await nextMessage();
              frames.push({ direction: 'down', opcode: message.opcode, data: message.data });
            }
            expect(frames.filter(frame => frame.direction === 'down')).toHaveLength(3);
            const firstDown = frames[0];
            expect(firstDown.opcode).toBe('binary');
            expect(firstDown.data.byteLength).toBe(32);

            ws.send('hello-control');
            frames.push({ direction: 'up', opcode: 'text', data: new Uint8Array(Buffer.from('hello-control')) });
            const textEcho = await nextMessage();
            expect(textEcho.opcode).toBe('text');
            expect(Buffer.from(textEcho.data).toString('utf8')).toBe('hello-control');
            frames.push({ direction: 'down', opcode: textEcho.opcode, data: textEcho.data });

            const upBinary = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
            ws.send(upBinary);
            frames.push({ direction: 'up', opcode: 'binary', data: upBinary });
            const binaryEcho = await nextMessage();
            expect(binaryEcho.opcode).toBe('binary');
            expect(Buffer.from(binaryEcho.data).equals(Buffer.from(upBinary))).toBe(true);
            frames.push({ direction: 'down', opcode: binaryEcho.opcode, data: binaryEcho.data });

            ws.close(1000, 'done');
            ws.addEventListener('close', () => resolve());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
    });

    expect(frames).toHaveLength(7);
    expect(frames.filter(frame => frame.direction === 'up')).toHaveLength(2);
    expect(frames.filter(frame => frame.direction === 'down')).toHaveLength(5);

    // 服务端记录了全部请求与帧。
    const recordedUrls = handle.capturedRequests().map(request => request.url);
    expect(recordedUrls).toContain(handle.paths.loginApi);
    expect(recordedUrls).toContain(`${handle.paths.websocket}?t=${encodeURIComponent(launchPayload.viewerToken)}`);
    const loginRecord = handle
      .capturedRequests()
      .find(request => request.url === handle.paths.loginApi);
    expect(loginRecord?.body).toContain('operator');
    const capturedFrames = handle.capturedFrames();
    expect(capturedFrames).toHaveLength(7);
    expect(capturedFrames.filter(frame => frame.direction === 'down')).toHaveLength(5);
  });

  it('WS 握手缺失 Cookie 或 viewerToken 错误时被服务端拒绝', async () => {
    const handle = await bootMock({ seed: 'mock-kvm-ws-guard' });

    const loginPageHtml = await (await fetch(handle.urls.loginPage)).text();
    const credential = digestCredential(loginPageHtml, handle.loginFieldNames.nonce);
    const login = await fetch(handle.urls.loginApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [handle.loginFieldNames.user]: 'operator',
        [handle.loginFieldNames.password]: credential,
      }),
    });
    const sessionCookie = login.headers.getSetCookie()[0].split(';')[0];
    const loginPayload = (await login.json()) as { csrfToken: string };
    const launch = await fetch(handle.urls.kvmLaunch, {
      method: 'POST',
      headers: { cookie: sessionCookie, [handle.csrfHeaderName]: loginPayload.csrfToken },
    });
    const launchPayload = (await launch.json()) as { viewerToken: string };

    const expectHandshakeRejected = (url: string, headers?: Record<string, string>) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocketWithHeaders(url, headers ? { headers } : undefined);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('握手未被拒绝'));
        }, 5000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          ws.close();
          reject(new Error('握手被错误接受'));
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          resolve();
        });
      });

    // 缺 Cookie：被拒绝。
    await expectHandshakeRejected(`${handle.urls.websocket}?t=${encodeURIComponent(launchPayload.viewerToken)}`);
    // 有 Cookie 但 viewerToken 错误：被拒绝。
    await expectHandshakeRejected(`${handle.urls.websocket}?t=deadbeef`, { cookie: sessionCookie });
    // 无 token：被拒绝。
    await expectHandshakeRejected(handle.urls.websocket, { cookie: sessionCookie });

    // 没有任何 WS 帧被记录（握手全部失败）。
    expect(handle.capturedFrames()).toHaveLength(0);
  });

  it('错误用户名与伪造同名 Cookie 都被拒绝（会话值严格校验）', async () => {
    const handle = await bootMock({ seed: 'mock-kvm-session-guard' });

    const loginPageHtml = await (await fetch(handle.urls.loginPage)).text();
    const credential = digestCredential(loginPageHtml, handle.loginFieldNames.nonce);

    // 正确摘要 + 错误用户名 → 401（用户名参与认证，不是只有摘要）。
    const wrongUser = await fetch(handle.urls.loginApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [handle.loginFieldNames.user]: 'admin',
        [handle.loginFieldNames.password]: credential,
      }),
    });
    expect(wrongUser.status).toBe(401);

    const login = await fetch(handle.urls.loginApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [handle.loginFieldNames.user]: 'operator',
        [handle.loginFieldNames.password]: credential,
      }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers.getSetCookie()[0].split(';')[0];
    const loginPayload = (await login.json()) as { csrfToken: string };
    const cookieName = sessionCookie.split('=')[0];
    // 同名但值错误的 Cookie（伪造会话）。
    const forgedCookie = `${cookieName}=forged-session-value`;

    // 伪造 Cookie 无法访问控制台 / 启动 KVM / 打开 Viewer。
    expect((await fetch(handle.urls.consoleEntry, { headers: { cookie: forgedCookie } })).status).toBe(401);
    expect(
      (
        await fetch(handle.urls.kvmLaunch, {
          method: 'POST',
          headers: { cookie: forgedCookie, [handle.csrfHeaderName]: loginPayload.csrfToken },
        })
      ).status,
    ).toBe(401);
    expect((await fetch(handle.urls.viewerPage, { headers: { cookie: forgedCookie } })).status).toBe(401);

    // 伪造 Cookie + 正确 viewerToken 也无法通过 WS 握手。
    const launch = await fetch(handle.urls.kvmLaunch, {
      method: 'POST',
      headers: { cookie: sessionCookie, [handle.csrfHeaderName]: loginPayload.csrfToken },
    });
    const launchPayload = (await launch.json()) as { viewerToken: string };
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocketWithHeaders(
          `${handle.urls.websocket}?t=${encodeURIComponent(launchPayload.viewerToken)}`,
          { headers: { cookie: forgedCookie } },
        );
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('握手未被拒绝'));
        }, 5000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          ws.close();
          reject(new Error('伪造 Cookie 的握手被错误接受'));
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    ).resolves.toBeUndefined();
    expect(handle.capturedFrames()).toHaveLength(0);
  });

});
