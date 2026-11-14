import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 注意：vite 会把配置打包到临时文件执行，import.meta.url 指向临时目录不可靠；
// 请在插件目录下运行 vitest（cwd 即插件根目录）。
const pluginRoot = process.cwd();

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@nocobase\/test$/,
        replacement: path.resolve(pluginRoot, 'test-shim.mjs'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ['src/**/__tests__/**/*.test.ts'],
    fileParallelism: false,
  },
});
