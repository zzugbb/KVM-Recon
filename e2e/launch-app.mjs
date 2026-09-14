import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let child = null;
let appDir = '';
const timeout = setTimeout(() => {
  // 捕获 Electron 解析、临时目录准备或应用启动超时
  // 策略：终止已启动进程并清理目录，保证本机和 CI 都能在 45 秒内返回
  child?.kill('SIGKILL');
  console.error('Electron 启动烟测超时');
  cleanup().finally(() => process.exit(1));
}, 45000);

const electronPackageDir = dirname(require.resolve('electron/package.json'));
const electronPathFile = join(electronPackageDir, 'path.txt');
if (!existsSync(electronPathFile)) {
  clearTimeout(timeout);
  console.error(
    'Electron 二进制未安装：缺少 node_modules/electron/path.txt，请先运行 npm run electron:install',
  );
  process.exit(1);
}
const electronBinary = join(
  electronPackageDir,
  'dist',
  readFileSync(electronPathFile, 'utf8').trim(),
);
if (!existsSync(electronBinary)) {
  clearTimeout(timeout);
  console.error(`Electron 二进制不存在：${electronBinary}`);
  process.exit(1);
}
const mainEntry = join(rootDir, 'dist/main/index.js');
const preloadEntry = join(rootDir, 'dist/preload/index.cjs');
const rendererEntry = join(rootDir, 'dist/renderer/index.html');

if (!existsSync(mainEntry) || !existsSync(preloadEntry) || !existsSync(rendererEntry)) {
  console.error('缺少 dist 构建产物，请先运行 npm run build');
  process.exit(1);
}

appDir = await mkdtemp(join(tmpdir(), 'kvm-recon-e2e-'));
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

child = spawn(
  electronBinary,
  [appDir, '--e2e-smoke', '--no-sandbox', '--disable-gpu'],
  {
    cwd: appDir,
    env: childEnv,
    stdio: 'inherit',
  },
);

async function cleanup() {
  if (!appDir) return;
  await rm(appDir, { recursive: true, force: true }).catch(error => {
    // 捕获烟测临时目录删除失败：不影响已得到的退出码
    // 策略：只打日志，避免掩盖 Electron 成功/失败结果
    console.error('清理 e2e 临时目录失败', error);
  });
}

child.on('exit', code => {
  clearTimeout(timeout);
  cleanup().finally(() => process.exit(code === 0 ? 0 : code ?? 1));
});
