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

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ASAR;
childEnv.ELECTRON_DISABLE_SANDBOX = '1';

const child = spawn(
  electronBinary,
  [join(rootDir, 'e2e/popup-native-window-main.mjs'), '--no-sandbox', '--disable-gpu'],
  {
    cwd: rootDir,
    env: childEnv,
    stdio: 'inherit',
  },
);

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
  console.error('Electron 原生弹窗集成测试超时');
  process.exit(1);
}, 30000);

child.on('exit', code => {
  clearTimeout(timeout);
  process.exit(code === 0 ? 0 : code ?? 1);
});
