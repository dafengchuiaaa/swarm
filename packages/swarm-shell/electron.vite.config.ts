import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

/**
 * 独立蜂群的构建入口：只编译本包自己的 main / preload / renderer。
 */
export default defineConfig({
  main: {
    build: {
      outDir: resolve(__dirname, 'out/main'),
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.js',
      },
      rollupOptions: {
        external: ['electron', 'node:sqlite'],
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      outDir: resolve(__dirname, 'out/preload'),
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.js',
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
