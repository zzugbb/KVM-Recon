import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * 完全未知、随机 URL 的本地 Mock KVM（规范 §19 阶段 0）。
 *
 * 用于验证「清空所有厂商和协议签名后，随机 URL 的 Mock KVM 仍得到
 * COMPLETE + KVM_REACHED + UNKNOWN」（规范 §20）：
 * - 每次启动随机生成路径段与表单字段名；固定 seed 时可复现。
 * - 不包含任何已知厂商 URL、路径、帧魔数或品牌词。
 * - 提供完整 HTML5 KVM 链路：登录页 → 登录 API（token + cookie）→
 *   控制台入口 → KVM 启动 API → Viewer 页（canvas + Worker）→ 双向 WebSocket。
 *
 * 页面内引用一律使用相对 URL 或运行时 location.host 拼接，
 * 响应正文与监听端口无关，固定 seed 时输出完全确定。
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Mock 演示账号与密码：登录页展示，登录页脚本与服务端验证使用同一方案。 */
const MOCK_DEMO_USERNAME = 'operator';
const MOCK_DEMO_PASSPHRASE = 'operator-passphrase';

export interface MockKvmUrlSet {
  loginPage: string;
  loginApi: string;
  consoleEntry: string;
  kvmLaunch: string;
  viewerPage: string;
  viewerWorker: string;
  websocket: string;
}

export interface MockKvmRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
}

export interface MockKvmFrameRecord {
  direction: 'up' | 'down';
  opcode: 'text' | 'binary';
  payload: Uint8Array;
}

export interface MockKvmHandle {
  host: string;
  port: number;
  /** http://<host>:<port> */
  base: string;
  /** 随机根路径段。 */
  randomTag: string;
  /** 随机生成的路径（以 / 开头）。 */
  paths: MockKvmUrlSet;
  /** 完整 URL（base + path）。 */
  urls: MockKvmUrlSet;
  loginFieldNames: { user: string; password: string; nonce: string };
  /** KVM 启动请求必须携带的 CSRF 头名；值来自登录响应 csrfToken，缺失或错误返回 403。 */
  csrfHeaderName: string;
  /** 登录页脚本存放 csrfToken 的 sessionStorage 键。 */
  csrfStorageKey: string;
  /** 控制台页脚本存放 viewerToken 的 sessionStorage 键。 */
  viewerTokenStorageKey: string;
  capturedRequests(): MockKvmRequestRecord[];
  capturedFrames(): MockKvmFrameRecord[];
  close(): Promise<void>;
}

export interface MockKvmOptions {
  /** 随机种子；固定后路径与帧内容可复现。缺省每次启动随机。 */
  seed?: string;
  host?: string;
  port?: number;
}

function randomHexFromSeed(seed: string, index: number, bytes: number): Buffer {
  const digest = createHash('sha256')
    .update(`${seed}:${index}`)
    .digest();
  return digest.subarray(0, bytes);
}

function randomHexFromOs(index: number, bytes: number): Buffer {
  return randomBytes(bytes);
}

function hex(buffer: Buffer): string {
  return buffer.toString('hex');
}

function buildUrlSet(randomTag: string, segments: string[]): MockKvmUrlSet {
  return {
    loginPage: `/${randomTag}/${segments[0]}.html`,
    loginApi: `/${randomTag}/${segments[1]}`,
    consoleEntry: `/${randomTag}/${segments[2]}.html`,
    kvmLaunch: `/${randomTag}/${segments[3]}`,
    viewerPage: `/${randomTag}/${segments[4]}.html`,
    viewerWorker: `/${randomTag}/${segments[5]}.js`,
    websocket: `/${randomTag}/${segments[6]}`,
  };
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export function createMockKvmServer(options: MockKvmOptions = {}): Promise<MockKvmHandle> {
  const host = options.host || '127.0.0.1';
  const seeded = typeof options.seed === 'string' && options.seed.length > 0;
  const randomSource = seeded ? randomHexFromSeed.bind(null, options.seed!) : randomHexFromOs;

  const randomTag = hex(randomSource(0, 6));
  const segments = Array.from({ length: 7 }, (_, index) => hex(randomSource(index + 1, 5)));
  const paths = buildUrlSet(randomTag, segments);

  const sessionCookieName = `m${hex(randomSource(8, 4))}`;
  const sessionToken = hex(randomSource(9, 16));
  const csrfToken = hex(randomSource(10, 16));
  const viewerToken = hex(randomSource(11, 16));
  const nonceValue = hex(randomSource(12, 12));

  const loginFieldNames = {
    user: `f${hex(randomSource(13, 4))}u`,
    password: `f${hex(randomSource(14, 4))}p`,
    nonce: `f${hex(randomSource(15, 4))}n`,
  };

  // CSRF 头名与 sessionStorage 键名同样随机生成（协议无关、无已知厂商签名）。
  // 登录页脚本把登录响应的 csrfToken 存入 csrfStorageKey；
  // 控制台页把启动响应的 viewerToken 存入 viewerTokenStorageKey。
  const csrfHeaderName = `x-${hex(randomSource(16, 4))}-csrf`;
  const csrfStorageKey = `s${hex(randomSource(17, 5))}c`;
  const viewerTokenStorageKey = `s${hex(randomSource(18, 5))}v`;

  const requests: MockKvmRequestRecord[] = [];
  const frames: MockKvmFrameRecord[] = [];
  const liveSockets = new Set<Duplex>();

  function sessionCookieOf(headerValue: string | string[] | undefined): string | null {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!raw) return null;
    const match = raw
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(`${sessionCookieName}=`));
    return match ? decodeURIComponent(match.slice(sessionCookieName.length + 1)) : null;
  }

  // 严格会话校验：Cookie 值必须等于登录时签发的 sessionToken，
  // 只携带同名 Cookie（任意值）不构成有效会话。
  function hasValidSession(headerValue: string | string[] | undefined): boolean {
    return sessionCookieOf(headerValue) === sessionToken;
  }

  function loginPageHtml(): string {
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head><meta charset="utf-8"><title>Console Gateway</title></head>',
      '<body>',
      '<h1 id="login-title">BMC 管理控制台</h1>',
      '<p id="credential-hint">演示凭证：operator / operator-passphrase</p>',
      `<form id="login-form" method="post" action="${paths.loginApi}">`,
      `<input name="${loginFieldNames.user}" autocomplete="off">`,
      `<input name="${loginFieldNames.password}" type="password">`,
      `<input type="hidden" name="${loginFieldNames.nonce}" value="${nonceValue}">`,
      '<button type="submit" id="login-submit">登录</button>',
      '</form>',
      // 登录页真正执行 WebCrypto 摘要：密码字段提交的是 SHA-256(passphrase:nonce)。
      // 登录接口验证摘要，错误凭据返回 401；阶段 2 的 Collector 必须从真实浏览器
      // 捕获这条运行时加密链才能复现登录。登录成功后把 csrfToken 存入
      // sessionStorage 并跳转控制台入口——真实浏览器无需任何手工步骤即可走完整链。
      '<script id="login-digest">',
      '(function () {',
      '  var form = document.getElementById("login-form");',
      '  var userField = form.querySelector("input:not([type=hidden]):not([type=password])");',
      '  var passField = form.querySelector("input[type=password]");',
      '  var nonceField = form.querySelector("input[type=hidden]");',
      '  form.addEventListener("submit", function (event) {',
      '    event.preventDefault();',
      '    var material = new TextEncoder().encode(passField.value + ":" + nonceField.value);',
      '    crypto.subtle.digest("SHA-256", material).then(function (digest) {',
      '      var hex = Array.from(new Uint8Array(digest)).map(function (byte) {',
      '        return byte.toString(16).padStart(2, "0");',
      '      }).join("");',
      '      var payload = {};',
      `      payload[${JSON.stringify(loginFieldNames.user)}] = userField.value;`,
      `      payload[${JSON.stringify(loginFieldNames.password)}] = hex;`,
      '      fetch(form.action, {',
      '        method: "POST",',
      '        headers: { "content-type": "application/json" },',
      '        body: JSON.stringify(payload),',
      '      })',
      '        .then(function (response) { return response.json(); })',
      '        .then(function (data) {',
      '          if (data && data.ok) {',
      `            sessionStorage.setItem(${JSON.stringify(csrfStorageKey)}, data.csrfToken);`,
      // fetch 完成后立即跳转文档，URL loader 随即释放，Network.getResponseBody
      // 取不到响应正文（Chromium 限制，采集侧以 missingBodies 显式记账）。
      // 延迟跳转演示可采集路径；「fetch 完成即跳转」作为已知缺口场景。
      `            setTimeout(function () { location.href = ${JSON.stringify(paths.consoleEntry)}; }, 500);`,
      '          }',
      '        });',
      '    });',
      '  });',
      '}());',
      '</script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  function consoleEntryHtml(): string {
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head><meta charset="utf-8"><title>Console Gateway</title></head>',
      '<body>',
      '<h1 id="console-title">远程控制台</h1>',
      '<p id="console-hint">点击下方按钮打开 HTML5 远程控制台。</p>',
      `<button id="console-open" data-launch="${paths.kvmLaunch}" data-viewer="${paths.viewerPage}">打开远程控制台</button>`,
      // 点击按钮真实发起 KVM 启动请求：必须携带登录时存入 sessionStorage 的
      // csrfToken（CSRF 头），服务端缺失或错误一律 403。启动成功后把 viewerToken
      // 存入 sessionStorage 并跳转 Viewer 页——浏览器链路完整可走通。
      '<script id="console-launch">',
      '(function () {',
      '  var button = document.getElementById("console-open");',
      '  button.addEventListener("click", function () {',
      `    var csrf = sessionStorage.getItem(${JSON.stringify(csrfStorageKey)}) || "";`,
      `    fetch(button.dataset.launch, {`,
      '      method: "POST",',
      `      headers: { ${JSON.stringify(csrfHeaderName)}: csrf },`,
      '    })',
      '      .then(function (response) { return response.json(); })',
      '      .then(function (data) {',
      '        if (data && data.ok) {',
      `          sessionStorage.setItem(${JSON.stringify(viewerTokenStorageKey)}, data.viewerToken);`,
      // 同上：延迟跳转保住 launch 响应正文（viewerToken 经响应正文 → 查询参数成边）
      `          setTimeout(function () { location.href = button.dataset.viewer; }, 500);`,
      '        }',
      '      });',
      '  });',
      '}());',
      '</script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  function viewerPageHtml(): string {
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head><meta charset="utf-8"><title>Remote Viewer</title></head>',
      '<body>',
      '<canvas id="remote-screen" width="1024" height="768"></canvas>',
      '<script id="viewer-bootstrap">',
      `(function () {`,
      `  var worker = new Worker('${paths.viewerWorker}');`,
      `  var token = sessionStorage.getItem('${viewerTokenStorageKey}') || '';`,
      `  var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';`,
      // 浏览器 WebSocket API 不能自定义请求头，viewerToken 经查询参数 t 传递，
      // 服务端在升级握手里校验 Session Cookie 与 t。
      `  var stream = new WebSocket(scheme + location.host + '${paths.websocket}' + '?t=' + encodeURIComponent(token));`,
      `  worker.onmessage = function (event) { stream.send(event.data); };`,
      `  stream.onmessage = function (event) { worker.postMessage(event.data); };`,
      `}())`,
      '</script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  function viewerWorkerJs(): string {
    return [
      '// Remote viewer decode worker (mock).',
      `"use strict";`,
      `var boot = "${randomTag}";`,
      'self.onmessage = function (event) { self.postMessage(event.data); };',
      'self.postMessage({ type: "worker-ready", boot: boot });',
      '',
    ].join('\n');
  }

  function initialDownFrame(index: number): Buffer {
    const source = seeded
      ? randomHexFromSeed(options.seed!, index + 20, 32)
      : randomBytes(32);
    return Buffer.from(source);
  }

  function attachWebSocket(socket: Duplex, head: Buffer) {
    let buffer = Buffer.from(head);
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));

    // 回声节流：上行帧延迟 25ms 回显（≈ 真实 KVM 视频帧率 40fps）。
    // 不节流的「服务端→页面→worker→服务端」回声环会以 ~5000 帧/s 自激，
    // 采集器（~900 帧/s 落盘）事件链积压数万帧，e2e 稳定窗口等待 15s+
    // 后收尾排空远超时器预算——节流后回声环仍在跑但速率落在采集能力内。
    const ECHO_DELAY_MS = 25;

    const sendFrame = (opcode: number, payload: Buffer) => {
      if (!liveSockets.has(socket) || socket.destroyed || !socket.writable) return;
      if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
        frames.push({
          direction: 'down',
          opcode: opcode === OPCODE_TEXT ? 'text' : 'binary',
          payload: new Uint8Array(payload),
        });
      }
      socket.write(encodeWsFrame(opcode, payload));
    };

    for (let index = 0; index < 3; index += 1) {
      sendFrame(OPCODE_BINARY, initialDownFrame(index));
    }

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // 逐帧解析（客户端帧均带掩码）。
      for (;;) {
        if (buffer.length < 2) break;
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const masked = (secondByte & 0x80) !== 0;
        let length = secondByte & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) break;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) break;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + (masked ? 4 : 0) + length) break;
        let mask: Buffer | null = null;
        if (masked) {
          mask = Buffer.from(buffer.subarray(offset, offset + 4));
          offset += 4;
        }
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }
        buffer = buffer.subarray(offset + length);

        if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
          frames.push({
            direction: 'up',
            opcode: opcode === OPCODE_TEXT ? 'text' : 'binary',
            payload: new Uint8Array(payload),
          });
          setTimeout(() => sendFrame(opcode, payload), ECHO_DELAY_MS);
        } else if (opcode === OPCODE_CLOSE) {
          socket.write(encodeWsFrame(OPCODE_CLOSE, payload));
          socket.end();
          return;
        } else if (opcode === OPCODE_PING) {
          socket.write(encodeWsFrame(OPCODE_PONG, payload));
        }
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }

  const handler: RequestListener = (request, response) => {
    // 禁用自动 Date 头：固定 seed 时响应头跨进程确定（样例包可复现）。
    response.sendDate = false;
    const url = request.url || '/';
    const record = (body: string | null) => {
      requests.push({
        method: request.method || 'GET',
        url,
        headers: { ...request.headers },
        body,
      });
    };

    const readBody = () =>
      new Promise<string | null>(resolve => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          resolve(chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null);
        });
        request.on('error', () => resolve(null));
      });

    void (async () => {
      const body = await readBody();
      record(body);

      const sendJson = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}) => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        for (const [name, value] of Object.entries(extraHeaders)) {
          response.setHeader(name, value);
        }
        response.end(JSON.stringify(payload));
      };

      if (url === paths.loginPage && request.method === 'GET') {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(loginPageHtml());
        return;
      }

      if (url === paths.loginApi && request.method === 'POST') {
        // 登录接口验证用户名 + 摘要凭据：用户名必须是演示账号，
        // credential 必须等于 SHA-256(<演示密码>:<本次启动 nonce>)，与登录页内联脚本一致。
        let credential: unknown = null;
        let username: unknown = null;
        try {
          const parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : null;
          credential = parsedBody?.[loginFieldNames.password] ?? null;
          username = parsedBody?.[loginFieldNames.user] ?? null;
        } catch {
          credential = null;
        }
        const expectedCredential = createHash('sha256')
          .update(`${MOCK_DEMO_PASSPHRASE}:${nonceValue}`)
          .digest('hex');
        if (
          typeof credential !== 'string' ||
          credential !== expectedCredential ||
          username !== MOCK_DEMO_USERNAME
        ) {
          sendJson(401, { ok: false, error: 'invalid-credential' });
          return;
        }
        sendJson(200, { ok: true, sessionToken, csrfToken }, {
          'set-cookie': `${sessionCookieName}=${encodeURIComponent(sessionToken)}; Path=/`,
        });
        return;
      }

      if (url === paths.consoleEntry && request.method === 'GET') {
        if (!hasValidSession(request.headers.cookie)) {
          response.statusCode = 401;
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end('unauthorized');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(consoleEntryHtml());
        return;
      }

      if (url === paths.kvmLaunch && request.method === 'POST') {
        if (!hasValidSession(request.headers.cookie)) {
          response.statusCode = 401;
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end('unauthorized');
          return;
        }
        // CSRF 校验：请求必须携带与登录响应 csrfToken 一致的 CSRF 头。
        // Replay 声明启动请求依赖 csrfToken，这里是真的——缺失或错误一律 403。
        const csrfHeader = request.headers[csrfHeaderName];
        const csrf = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
        if (typeof csrf !== 'string' || csrf !== csrfToken) {
          sendJson(403, { ok: false, error: 'invalid-csrf' });
          return;
        }
        sendJson(200, { ok: true, viewerToken, streamPath: paths.websocket });
        return;
      }

      if (url === paths.viewerPage && request.method === 'GET') {
        if (!hasValidSession(request.headers.cookie)) {
          response.statusCode = 401;
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end('unauthorized');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(viewerPageHtml());
        return;
      }

      if (url === paths.viewerWorker && request.method === 'GET') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/javascript; charset=utf-8');
        response.end(viewerWorkerJs());
        return;
      }

      response.statusCode = 404;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('not found');
    })();
  };

  return new Promise<MockKvmHandle>(resolve => {
    const server: Server = createServer(handler);
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = request.url || '/';
      const requestUrl = new URL(url, `http://${request.headers.host || 'localhost'}`);
      if (requestUrl.pathname !== paths.websocket || typeof request.headers['sec-websocket-key'] !== 'string') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // WS 握手校验 Session Cookie 与 viewerToken（查询参数 t，与 Viewer 页脚本一致）。
      const token = requestUrl.searchParams.get('t');
      if (!hasValidSession(request.headers.cookie) || token !== viewerToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}${WS_GUID}`)
        .digest('base64');
      requests.push({
        method: 'GET',
        url,
        headers: { ...request.headers },
        body: null,
      });
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          '\r\n',
      );
      attachWebSocket(socket, head);
    });
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    server.listen(options.port ?? 0, host, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const base = `http://${host}:${port}`;
      const buildUrls = (): MockKvmUrlSet => ({
        loginPage: `${base}${paths.loginPage}`,
        loginApi: `${base}${paths.loginApi}`,
        consoleEntry: `${base}${paths.consoleEntry}`,
        kvmLaunch: `${base}${paths.kvmLaunch}`,
        viewerPage: `${base}${paths.viewerPage}`,
        viewerWorker: `${base}${paths.viewerWorker}`,
        websocket: `ws://${host}:${port}${paths.websocket}`,
      });

      resolve({
        host,
        port,
        base,
        randomTag,
        paths,
        urls: buildUrls(),
        loginFieldNames,
        csrfHeaderName,
        csrfStorageKey,
        viewerTokenStorageKey,
        capturedRequests: () => requests.map(record => ({ ...record, headers: { ...record.headers } })),
        capturedFrames: () =>
          frames.map(frame => ({
            direction: frame.direction,
            opcode: frame.opcode,
            payload: new Uint8Array(frame.payload),
          })),
        close: () =>
          new Promise<void>(resolveClose => {
            for (const socket of liveSockets) {
              socket.destroy();
            }
            liveSockets.clear();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
