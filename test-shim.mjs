// @nocobase/test 发布包的 module/exports 入口指向不存在的文件（src/index.ts、es/index.mjs），
// 且其 CJS 产物的导出方式无法被静态分析。这里通过 createRequire 在运行时加载，
// 以显式具名导出提供给 vitest 的别名解析使用。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nocobaseTest = require('@nocobase/test');

export const MockServer = nocobaseTest.MockServer;
export const createMockServer = nocobaseTest.createMockServer;
export const mockServer = nocobaseTest.mockServer;
export const getConfig = nocobaseTest.getConfig;
export const supertest = nocobaseTest.supertest;
export default nocobaseTest;
