/**
 * Mock KVM 真实浏览器流程 E2E（Electron 主进程脚本）。
 *
 * 由 e2e/mock-kvm-browser-flow.mjs 打包到临时 app 目录运行：
 * - 用隐藏 BrowserWindow 加载随机 URL Mock KVM 的登录页。
 * - 全程真实用户输入（sendInputEvent 鼠标点击 + 字符输入），不直接调接口：
 *   填写登录 → 提交（页面执行 WebCrypto 摘要）→ 跳转控制台 →
 *   点击「打开远程控制台」（页面发 CSRF 启动请求）→ 跳转 Viewer →
 *   页面创建 Worker 并建立 WebSocket。
 * - 断言全部来自 Mock 服务端观察到的实际网络事实（请求与帧）。
 */

import { app, BrowserWindow } from 'electron';

import { createMockKvmServer } from './mock-kvm-server.mjs';

const successMarker = 'mock kvm browser flow e2e passed';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const handle = await createMockKvmServer({ seed: 'mock-kvm-browser-e2e' });
  let win = null;
  try {
    win = new BrowserWindow({
      width: 1024,
      height: 768,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;

    const queryScript = (selector, expression) =>
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; ${expression} })()`;

    async function elementCenter(selector) {
      const rect = await wc.executeJavaScript(
        queryScript(
          selector,
          'const r = el.getBoundingClientRect(); return { x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2), w: r.width, h: r.height };',
        ),
      );
      if (!rect || !rect.w || !rect.h) {
        throw new Error(`元素不存在或不可点击：${selector}`);
      }
      return { x: rect.x, y: rect.y };
    }

    async function clickAt(selector) {
      const { x, y } = await elementCenter(selector);
      wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', clickCount: 0 });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }

    async function typeInto(selector, text) {
      const isTargetFocused = () =>
        wc.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && document.activeElement === el; })()`,
        );

      // 串行跑在其他 Electron E2E 之后时，隐藏窗口可能没有拿到焦点，
      // 直接发送字符会被丢弃。先点击并显式 focus，等到 activeElement
      // 就位后再逐字输入。
      const typeOnce = async () => {
        wc.focus();
        await wc.executeJavaScript(queryScript(selector, 'el.focus();'));
        await waitFor(`输入框获得焦点：${selector}`, isTargetFocused, 5000);
        for (const char of text) {
          wc.sendInputEvent({ type: 'char', keyCode: char });
          await sleep(15);
        }
      };

      await clickAt(selector);
      await typeOnce();
      // 焦点时序仍可能吞掉字符：值未生效就清空并显式 focus 后重试一次。
      if ((await inputValue(selector)) !== text) {
        await wc.executeJavaScript(queryScript(selector, 'el.value = ""; el.focus();'));
        await typeOnce();
      }
      await waitFor(
        `键盘输入生效：${selector}`,
        async () => (await inputValue(selector)) === text,
        5000,
      );
    }

    async function inputValue(selector) {
      return wc.executeJavaScript(queryScript(selector, 'return el.value;'));
    }

    async function waitFor(label, condition, timeoutMs = 15000) {
      const startedAt = Date.now();
      for (;;) {
        const ok = await condition();
        if (ok) return;
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`等待超时：${label}`);
        }
        await sleep(100);
      }
    }

    // 1. 打开登录页，真实输入账号与密码并提交。
    await wc.loadURL(handle.urls.loginPage);
    const userField = '#login-form input:not([type=hidden]):not([type=password])';
    const passField = '#login-form input[type=password]';
    await typeInto(userField, 'operator');
    await typeInto(passField, 'operator-passphrase');
    if ((await inputValue(userField)) !== 'operator') {
      throw new Error('账号输入未生效（真实键盘输入失败）');
    }
    if ((await inputValue(passField)) !== 'operator-passphrase') {
      throw new Error('密码输入未生效（真实键盘输入失败）');
    }
    await clickAt('#login-submit');

    // 2. 登录页脚本执行 WebCrypto 摘要 → 登录 API → 跳转控制台。
    await waitFor('登录成功后跳转控制台入口', async () =>
      wc.getURL().includes(handle.paths.consoleEntry),
    );
    const consoleTitle = await wc.executeJavaScript(
      '(() => { const el = document.getElementById("console-title"); return el ? el.textContent : null; })()',
    );
    if (!consoleTitle) {
      throw new Error('控制台入口页未渲染标题（登录链路未真正走通）');
    }

    // 3. 点击「打开远程控制台」：页面发起带 CSRF 头的启动请求 → 跳转 Viewer。
    await clickAt('#console-open');
    await waitFor('点击按钮后进入 Viewer 页', async () =>
      wc.getURL().includes(handle.paths.viewerPage),
    );

    // 4. Viewer 页创建解码 Worker 并建立 WebSocket（全部由服务端观察到的网络事实证明）。
    const workerPath = handle.paths.viewerWorker;
    await waitFor('Viewer 页创建 Worker（真实拉取 Worker 脚本）', async () =>
      handle
        .capturedRequests()
        .some(request => request.url.split('?')[0] === workerPath),
    );
    await waitFor(
      'Viewer 页建立 WebSocket 并收到初始下行帧',
      async () => handle.capturedFrames().filter(frame => frame.direction === 'down').length >= 3,
    );
    if (!handle.capturedRequests().some(request => request.url.startsWith(handle.paths.websocket))) {
      throw new Error('未观察到 WebSocket 升级握手请求');
    }

    console.log(successMarker);
    return 0;
  } catch (error) {
    console.error('[mock-kvm-browser-flow] 失败：', (error && error.message) || error);
    if (win) {
      console.error('[mock-kvm-browser-flow] 当前 URL：', win.webContents.getURL());
    }
    return 1;
  } finally {
    if (win) {
      win.destroy();
    }
    await handle.close().catch(() => {});
  }
}

process.on('unhandledRejection', error => {
  console.error('[mock-kvm-browser-flow] 未处理异常：', error);
  app.exit(1);
});

app.whenReady().then(
  async () => {
    const code = await run();
    app.exit(code);
  },
  error => {
    console.error('[mock-kvm-browser-flow] 启动失败：', error);
    app.exit(1);
  },
);
