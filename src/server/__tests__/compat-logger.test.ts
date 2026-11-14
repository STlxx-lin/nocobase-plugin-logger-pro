import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MockServer, createMockServer } from '@nocobase/test';
import PluginLoggerProServer from '../index';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';

describe('Compat Logger Resource Suite (/api/logger:*)', () => {
  let app: MockServer;
  let plugin: PluginLoggerProServer;
  let testLogDir: string;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: [[PluginLoggerProServer, { name: 'logger-pro' }]],
      resourcer: {
        prefix: '/api',
      },
    });

    await app.load();
    await app.db.sync();
    plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;

    testLogDir = plugin.readerService.getLogBasePath();
    await fsp.mkdir(testLogDir, { recursive: true });

    // 准备测试日志文件与子目录日志文件
    await fsp.writeFile(path.join(testLogDir, 'compat-test.log'), 'test line 1\ntest line 2\n', 'utf-8');
    const subDir = path.join(testLogDir, 'subsystem');
    await fsp.mkdir(subDir, { recursive: true });
    await fsp.writeFile(path.join(subDir, 'child.log'), 'child line 1\n', 'utf-8');
  });

  afterAll(async () => {
    if (app) {
      if (plugin?.retentionService) {
        plugin.retentionService.stopScheduler();
      }
      try {
        // 清理测试日志
        const testFile = path.join(testLogDir, 'compat-test.log');
        if (fs.existsSync(testFile)) await fsp.unlink(testFile);
        const childFile = path.join(testLogDir, 'subsystem', 'child.log');
        if (fs.existsSync(childFile)) await fsp.unlink(childFile);
        const subDir = path.join(testLogDir, 'subsystem');
        if (fs.existsSync(subDir)) await fsp.rmdir(subDir);

        if (app.db) {
          await app.db.clean({ drop: true });
        }
        await app.destroy();
      } catch (e) {
        // ignore
      }
    }
  });

  test('1. 验证 compat-logger 资源成功在 resourcer 中注册', () => {
    expect(app.resourcer.isDefined('logger')).toBe(true);
    const resource = app.resourcer.getResource('logger');
    expect(resource).toBeDefined();
  });

  test('2. GET /api/logger:list 成功响应并返回日志目录树', async () => {
    const res = await app.agent().get('/api/logger:list');
    expect(res.status).toBe(200);

    const body = res.body?.data || res.body;
    expect(Array.isArray(body)).toBe(true);

    // 检查顶层日志文件
    const hasCompatTestLog = body.some(
      (item: any) => typeof item === 'string' && item === 'compat-test.log',
    );
    expect(hasCompatTestLog).toBe(true);

    // 检查子目录嵌套结构
    const subDirItem = body.find(
      (item: any) => typeof item === 'object' && item.name === 'subsystem',
    );
    expect(subDirItem).toBeDefined();
    expect(Array.isArray(subDirItem.files)).toBe(true);
    expect(subDirItem.files).toContain('child.log');
  });

  test('3. POST /api/logger:download 未指定 files 时应返回 400 校验错误', async () => {
    const res = await app.agent().post('/api/logger:download').send({
      values: { files: [] },
    });

    expect(res.status).toBe(400);
  });

  test('4. POST /api/logger:download 指定有效文件时返回 tar.gz 流', async () => {
    const res = await app.agent().post('/api/logger:download').send({
      values: { files: ['compat-test.log'] },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('logs.tar.gz');
  });

  test('5. POST /api/logger:collect 上报诊断信息并返回打包流', async () => {
    const res = await app.agent().post('/api/logger:collect').send({
      values: {
        error: { message: 'Compat Frontend Test Error', stack: 'TestStack:1:1' },
        browser: 'Chrome Test Runner',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('logs.tar.gz');
  });
});
