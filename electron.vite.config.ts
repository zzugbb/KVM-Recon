import { defineConfig } from 'electron-vite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

function resolveBuildId() {
  const supplied = process.env.KVM_RECON_BUILD_ID || process.env.GITHUB_SHA;
  if (supplied) return supplied.slice(0, 16);
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    return `${commit}${dirty ? '-dirty' : ''}`;
  } catch (error) {
    // 捕获源码包或无 Git 环境中的构建标识读取失败
    // 策略：写入明确 fallback，版本号仍可区分安装包，不阻断构建
    void error;
    return 'source-build';
  }
}

const define = {
  __KVM_RECON_BUILD_ID__: JSON.stringify(resolveBuildId()),
};

export default defineConfig({
  main: {
    define,
    build: {
      outDir: resolve(rootDir, 'dist/main'),
      // 把 zip 读写库打进主进程包，安装包 files 不含 node_modules 时导出 zip 仍可用
      externalizeDeps: {
        exclude: ['yazl', 'yauzl', 'ajv', 'stream-json'],
      },
    },
  },
  preload: {
    define,
    build: {
      outDir: resolve(rootDir, 'dist/preload'),
      rollupOptions: {
        output: {
          // package.json 是 "type": "module"，.js 会被当成 ESM；
          // 沙箱预加载必须是 CJS，用 .cjs 才能在安装包里挂上 window.kvmRecon
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name].cjs',
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    define,
    root: resolve(rootDir, 'src/renderer'),
    build: {
      outDir: resolve(rootDir, 'dist/renderer'),
      emptyOutDir: true,
    },
  },
});
