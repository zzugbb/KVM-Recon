import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const mainEntry = join(rootDir, 'dist/main/index.js');
if (!existsSync(mainEntry)) {
  console.error('缺少 dist 构建产物，请先运行 npm run build');
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ASAR;
childEnv.KVM_RECON_E2E_CAPTURE = '1';
childEnv.ELECTRON_DISABLE_SANDBOX = '1';

const child = spawn(
  electronBinary,
  [mainEntry, '--e2e-capture-controller', '--no-sandbox', '--disable-gpu'],
  {
    cwd: rootDir,
    env: childEnv,
    stdio: 'inherit',
  },
);

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
  console.error('生产采集 Controller E2E 超时');
  process.exit(1);
}, 45000);

child.on('exit', code => {
  clearTimeout(timeout);
  process.exit(code === 0 ? 0 : code ?? 1);
});
