/**
 * Mock KVM 真实浏览器流程 E2E 运行器。
 *
 * 单元测试直接用 Node 请求各接口，无法证明「真实浏览器用户」能走通整条链路；
 * 本 E2E 用隐藏的 Electron BrowserWindow 操作真实页面（键盘输入 + 鼠标点击），
 * 断言全部来自 Mock 服务端观察到的实际请求与帧。
 *
 * 流程：登录页输入并提交（页面执行 WebCrypto 摘要）→ 自动跳转控制台 →
 * 点击按钮（页面发 CSRF 启动请求）→ 自动跳转 Viewer → 页面创建 Worker 与 WebSocket。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const electronPackageDir = dirname(require.resolve('electron/package.json'));
const electronPathFile = join(electronPackageDir, 'path.txt');
if (!existsSync(electronPathFile)) {
  console.error('Electron 二进制未安装：缺少 node_modules/electron/path.txt');
  process.exit(1);
}
const electronBinary = join(
  electronPackageDir,
  'dist',
  readFileSync(electronPathFile, 'utf8').trim(),
);
if (!existsSync(electronBinary)) {
  console.error(`Electron 二进制不存在：${electronBinary}`);
  process.exit(1);
}

const successMarker = 'mock kvm browser flow e2e passed';
const appDir = mkdtempSync(join(tmpdir(), 'mock-kvm-browser-e2e-'));

async function main() {
  // 把 Mock KVM 服务器（TypeScript 源码）打包成临时 app 可用的 ESM 模块。
  await build({
    entryPoints: [join(rootDir, 'src/core/mock-kvm/createMockKvmServer.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'mock-kvm-server.mjs'),
  });
  writeFileSync(
    join(appDir, 'main.mjs'),
    readFileSync(join(here, 'mock-kvm-browser-flow-main.mjs')),
  );
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify({ name: 'mock-kvm-browser-e2e', main: 'main.mjs' }, null, 2)}\n`,
  );

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH;
  childEnv.ELECTRON_DISABLE_SANDBOX = '1';

  await new Promise(resolve => {
    const child = spawn(electronBinary, [appDir, '--no-sandbox', '--disable-gpu'], {
      cwd: rootDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      console.error('Mock KVM 浏览器流程 E2E 超时');
      process.exitCode = 1;
      resolve();
    }, 60000);

    child.on('error', error => {
      clearTimeout(timeout);
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      resolve();
    });

    child.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0 || !output.includes(successMarker)) {
        console.error(
          output.includes(successMarker)
            ? `Mock KVM 浏览器流程 E2E 退出码 ${code}`
            : 'Mock KVM 浏览器流程 E2E 退出但未出现成功标记',
        );
        process.exitCode = 1;
      }
      resolve();
    });
  });
}

try {
  await main();
} finally {
  rmSync(appDir, { recursive: true, force: true });
}
