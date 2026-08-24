import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const mainEntry = join(rootDir, 'dist/main/index.js');
const preloadEntry = join(rootDir, 'dist/preload/index.js');
const rendererEntry = join(rootDir, 'dist/renderer/index.html');

if (!existsSync(mainEntry) || !existsSync(preloadEntry) || !existsSync(rendererEntry)) {
  console.error('缺少 dist 构建产物，请先运行 npm run build');
  process.exit(1);
}

const appDir = await mkdtemp(join(tmpdir(), 'kvm-recon-e2e-'));
await cp(join(rootDir, 'dist'), join(appDir, 'dist'), { recursive: true });
await writeFile(
  join(appDir, 'package.json'),
  JSON.stringify({
    name: 'kvm-recon-e2e',
    private: true,
    type: 'module',
    main: 'dist/main/index.js',
  }),
);

const childEnv = { ...process.env };
// Cursor / VS Code 等宿主会带上 ELECTRON_RUN_AS_NODE，导致 Electron 二进制被当成 Node 执行主进程
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ASAR;
childEnv.KVM_RECON_E2E = '1';
childEnv.ELECTRON_DISABLE_SANDBOX = '1';

const child = spawn(
  electronBinary,
  [appDir, '--e2e-smoke', '--no-sandbox', '--disable-gpu'],
  {
    cwd: appDir,
    env: childEnv,
    stdio: 'inherit',
  },
);

async function cleanup() {
  await rm(appDir, { recursive: true, force: true }).catch(error => {
    // 捕获烟测临时目录删除失败：不影响已得到的退出码
    // 策略：只打日志，避免掩盖 Electron 成功/失败结果
    console.error('清理 e2e 临时目录失败', error);
  });
}

const timeout = setTimeout(() => {
  // 捕获 Electron 烟测超时：主窗口未在限定时间内加载完成
  // 策略：强制结束进程并以非零退出，避免 CI 挂死
  child.kill('SIGKILL');
  console.error('Electron 启动烟测超时');
  cleanup().finally(() => process.exit(1));
}, 45000);

child.on('exit', code => {
  clearTimeout(timeout);
  cleanup().finally(() => process.exit(code === 0 ? 0 : code ?? 1));
});
