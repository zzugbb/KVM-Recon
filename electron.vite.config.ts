import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: resolve(rootDir, 'dist/main'),
      // 把 jszip 打进主进程包，安装包 files 不含 node_modules 时导出 zip 仍可用
      externalizeDeps: {
        exclude: ['jszip'],
      },
    },
  },
  preload: {
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
    root: resolve(rootDir, 'src/renderer'),
    build: {
      outDir: resolve(rootDir, 'dist/renderer'),
      emptyOutDir: true,
    },
  },
});
