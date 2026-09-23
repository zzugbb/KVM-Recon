/**
 * 阶段 2：Mock KVM + 协议无关采集落盘对照 E2E 运行器。
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

const successMarker = 'mock kvm collector e2e passed';
const appDir = mkdtempSync(join(tmpdir(), 'mock-kvm-collector-e2e-'));

async function main() {
  await build({
    entryPoints: [join(rootDir, 'src/core/mock-kvm/createMockKvmServer.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'mock-kvm-server.mjs'),
  });
  await build({
    entryPoints: [join(rootDir, 'src/core/collector/createCaptureSession.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'capture-session.mjs'),
  });
  // Viewer 自动收尾看门狗 + 信号识别（会话级自动收尾断言用）
  await build({
    entryPoints: [join(rootDir, 'src/main/capture/viewerAutoStopWatchdog.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'viewer-autostop-watchdog.mjs'),
  });
  await build({
    entryPoints: [join(rootDir, 'src/core/collector/viewerActivity.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'viewer-activity.mjs'),
  });
  // NetLog 源（Electron 内建模块外置，运行时由 Electron 主进程解析）：
  // §20 场景 1 要求导出 COMPLETE——包内有 HTTP 事务时 netlog journal
  // 不得为空（not-captured 兜底会被 RAW_JOURNAL_EMPTY 门禁拒绝）
  await build({
    entryPoints: [join(rootDir, 'src/main/capture/electronNetlogSource.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'electron-netlog-source.mjs'),
    external: ['electron'],
  });
  // §20 验收场景 1 端到端闭环——完整会话导出
  // exportJobWorkspaceZip 后断言 COMPLETE + KVM_REACHED。
  // banner 注入 require：yazl/yauzl 等 CJS 依赖的 require('fs') 在 ESM
  // 输出里没有 require 可用（Dynamic require of "fs" is not supported）
  await build({
    entryPoints: [join(rootDir, 'src/core/export/exportJobWorkspaceZip.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'export-job-zip.mjs'),
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
  });
  // 阶段 4 断言从导出 ZIP（回放客户端消费的交付物）读取派生物：
  // readZipEntries 复用生产采集 E2E 的 ZIP 读取器
  await build({
    entryPoints: [join(rootDir, 'src/main/capture/runProductionCaptureE2e.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    outfile: join(appDir, 'production-capture-e2e.mjs'),
    external: ['electron'],
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
  });
  writeFileSync(join(appDir, 'main.mjs'), readFileSync(join(here, 'mock-kvm-collector-flow-main.mjs')));
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify({ name: 'mock-kvm-collector-e2e', main: 'main.mjs' }, null, 2)}\n`,
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
      console.error('Mock KVM 采集器 E2E 超时');
      process.exitCode = 1;
      resolve();
    }, 90000);

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
            ? `Mock KVM 采集器 E2E 退出码 ${code}`
            : 'Mock KVM 采集器 E2E 退出但未出现成功标记',
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
