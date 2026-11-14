import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MockServer, createMockServer } from '@nocobase/test';
import PluginLoggerProServer from '../index';
import { CONFIG_KEYS } from '../constants';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';

describe('Challenger M2 Stress & Adversarial Test Suite', () => {
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

    // 注册压力测试用业务数据表
    app.db.collection({
      name: 'stress_articles',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'integer', name: 'counter' },
        { type: 'json', name: 'meta' },
        { type: 'date', name: 'publishedAt' },
        { type: 'password', name: 'secretKey' },
      ],
    });

    await app.load();
    await app.db.sync();
    plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;

    testLogDir = plugin.readerService.getLogBasePath();
    await fsp.mkdir(testLogDir, { recursive: true });
    await fsp.writeFile(path.join(testLogDir, 'stress-audit.log'), 'audit line 1\n', 'utf-8');
  });

  afterAll(async () => {
    if (app) {
      if (plugin?.retentionService) {
        plugin.retentionService.stopScheduler();
      }
      try {
        const testFile = path.join(testLogDir, 'stress-audit.log');
        if (fs.existsSync(testFile)) await fsp.unlink(testFile);

        if (app.db) {
          await app.db.clean({ drop: true });
        }
        await app.destroy();
      } catch (e) {
        // ignore cleanup error
      }
    }
  });

  describe('1. zeroDiffSkip 并发与稳定性压力测试 (Concurrent ZeroDiff & Koa next)', () => {
    test('1.1 单次零差异更新与快速连续并发零差异更新，绝不触发 next() called multiple times 且零差异被准确跳过', async () => {
      const repo = app.db.getRepository('stress_articles');
      const auditRepo = app.db.getRepository('logger_audit_logs');

      // 确保 zeroDiffSkip 开启
      await plugin.configService.set(CONFIG_KEYS.AUDIT_ZERO_DIFF_SKIP, 'true');

      const initial = await repo.create({
        values: {
          title: 'Concurrent Title',
          counter: 100,
        },
      });

      // 先做单次零差异更新，确认 diffKeys 是否为 0
      const singleRes = await app.agent().resource('stress_articles').update({
        filterByTk: initial.id,
        values: {
          title: 'Concurrent Title',
          counter: 100,
        },
      });
      expect(singleRes.status).toBe(200);

      const singleLogs = await auditRepo.find({
        filter: { collectionName: 'stress_articles', recordId: String(initial.id), actionName: 'update' },
      });
      console.log('Single update audit logs count:', singleLogs.length, 'logs:', JSON.stringify(singleLogs));
      expect(singleLogs.length).toBe(0);

      // 验证在 SQLite 单连接事务保护下，快速连续 10 次零差异更新
      const allResponses: any[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await app.agent().resource('stress_articles').update({
          filterByTk: initial.id,
          values: {
            title: 'Concurrent Title',
            counter: 100,
          },
        });
        allResponses.push(res);
      }

      // 验证每一个请求都是 200 OK，绝无 next() called multiple times 崩溃
      for (const res of allResponses) {
        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();
        // 关键断言：绝对不能包含 next() called multiple times 错误
        const errStr = (res.text || '') + JSON.stringify(res.body || '');
        expect(errStr).not.toContain('next() called multiple times');
      }

      // 验证零差异跳过生效，auditRepo 没有新增任何无差异日志
      const countAfter = await auditRepo.count({
        filter: { collectionName: 'stress_articles', recordId: String(initial.id), actionName: 'update' },
      });
      expect(countAfter).toBe(0);
    });

    test('1.2 混合连续更新（部分有差异、部分零差异），差异识别与跳过准确无误', async () => {
      const repo = app.db.getRepository('stress_articles');
      const auditRepo = app.db.getRepository('logger_audit_logs');

      const itemZero = await repo.create({ values: { title: 'ZeroItem', counter: 1 } });
      const itemDiff = await repo.create({ values: { title: 'DiffItem', counter: 1 } });

      const countBefore = await auditRepo.count({
        filter: { collectionName: 'stress_articles', actionName: 'update' },
      });

      // 混合批量更新：5 次零差异，5 次有差异
      for (let i = 0; i < 5; i++) {
        const resZero = await app.agent().resource('stress_articles').update({
          filterByTk: itemZero.id,
          values: { title: 'ZeroItem' },
        });
        expect(resZero.status).toBe(200);

        const resDiff = await app.agent().resource('stress_articles').update({
          filterByTk: itemDiff.id,
          values: { counter: 10 + i },
        });
        expect(resDiff.status).toBe(200);
      }

      const countAfter = await auditRepo.count({
        filter: { collectionName: 'stress_articles', actionName: 'update' },
      });
      // 5 个有差异的更新必须全部被审计记录，5 个无差异的更新必须全被跳过
      expect(countAfter - countBefore).toBe(5);
    });
  });

  describe('2. 下游异常穿透与不被吞噬实证 (Downstream Error Propagation)', () => {
    test('2.1 下游业务钩子抛出异常时，错误完整透传至客户端，绝不被 finally / zeroDiffSkip 吞没', async () => {
      const repo = app.db.getRepository('stress_articles');
      const auditRepo = app.db.getRepository('logger_audit_logs');

      const item = await repo.create({ values: { title: 'Safe Title', counter: 10 } });

      // 在 Sequelize Model 层注入会抛错的钩子
      const model = repo.model;
      const hookName = 'challenger_error_hook';
      model.addHook('beforeUpdate', hookName, (instance: any) => {
        if (instance.title === 'TRIGGER_DOWNSTREAM_ERROR') {
          throw new Error('Downstream critical business exception: DB constraint violated');
        }
      });

      try {
        // 发起触发异常的更新请求
        const res = await app.agent().resource('stress_articles').update({
          filterByTk: item.id,
          values: { title: 'TRIGGER_DOWNSTREAM_ERROR' },
        });

        expect(res.status).toBe(500);

        // 验证审计日志记录了该失败事件，且记录了 errorMessage
        const allFailedLogs = await auditRepo.find({
          filter: {
            collectionName: 'stress_articles',
            recordId: String(item.id),
            actionName: 'update',
          },
          sort: ['-createdAt'],
        });
        expect(allFailedLogs.length).toBeGreaterThan(0);
        expect(allFailedLogs[0].errorMessage).toContain('Downstream critical business exception: DB constraint violated');
      } finally {
        model.removeHook('beforeUpdate', hookName);
      }
    });

    test('2.2 当请求值与原值相同但下游强制报错时，原始错误仍然正确抛出，不被 zeroDiffSkip 误跳过', async () => {
      const repo = app.db.getRepository('stress_articles');

      const item = await repo.create({ values: { title: 'Identical Title', counter: 99 } });

      const model = repo.model;
      const hookName = 'challenger_identical_error_hook';
      model.addHook('beforeUpdate', hookName, (instance: any) => {
        if (instance.counter === -999) {
          throw new Error('Downstream fail on zero diff condition');
        }
      });

      try {
        const res = await app.agent().resource('stress_articles').update({
          filterByTk: item.id,
          values: { title: 'Identical Title', counter: -999 },
        });

        // 验证即使字段尝试修改但下游抛错，请求仍被判定为 500，绝不因 zeroDiffSkip 而被吞没成 200
        expect(res.status).toBe(500);
      } finally {
        model.removeHook('beforeUpdate', hookName);
      }
    });
  });

  describe('3. 复杂类型与极端数据 Diff 计算稳定性 (Complex Types & Diff Stress)', () => {
    test('3.1 嵌套对象、数组、日期、Null/Undefined 等复合结构的 Diff 计算与更新', async () => {
      const repo = app.db.getRepository('stress_articles');
      const auditRepo = app.db.getRepository('logger_audit_logs');

      const item = await repo.create({
        values: {
          title: 'Complex Item',
          counter: 1,
          meta: {
            nested: { level1: { level2: { key: 'initial' } } },
            tags: ['dev', 'test'],
            numList: [1, 2, 3],
          },
          publishedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });

      // 更新嵌套对象与日期
      const res = await app.agent().resource('stress_articles').update({
        filterByTk: item.id,
        values: {
          meta: {
            nested: { level1: { level2: { key: 'updated' } } },
            tags: ['dev', 'prod'],
            numList: [1, 2, 3, 4],
          },
          publishedAt: new Date('2026-11-13T12:00:00.000Z'),
        },
      });

      expect(res.status).toBe(200);

      const logs = await auditRepo.find({
        filter: { collectionName: 'stress_articles', recordId: String(item.id), actionName: 'update' },
        sort: ['-createdAt'],
      });

      expect(logs.length).toBeGreaterThan(0);
      const diff = typeof logs[0].diff === 'string' ? JSON.parse(logs[0].diff) : logs[0].diff;
      expect(diff).toBeDefined();
      expect(diff.meta).toBeDefined();
      expect(diff.publishedAt).toBeDefined();
    });

    test('3.2 超长字符串 (> 300 字符) 与 Base64 媒体串的脱敏与截断保护', async () => {
      const repo = app.db.getRepository('stress_articles');
      const auditRepo = app.db.getRepository('logger_audit_logs');

      const item = await repo.create({ values: { title: 'Short' } });

      const hugeString = 'X'.repeat(500);
      const fakeBase64 = 'data:image/png;base64,' + 'A'.repeat(600);

      const res = await app.agent().resource('stress_articles').update({
        filterByTk: item.id,
        values: {
          title: hugeString,
          meta: { avatar: fakeBase64 },
        },
      });

      expect(res.status).toBe(200);

      const logs = await auditRepo.find({
        filter: { collectionName: 'stress_articles', recordId: String(item.id), actionName: 'update' },
        sort: ['-createdAt'],
      });

      expect(logs.length).toBeGreaterThan(0);
      const diff = typeof logs[0].diff === 'string' ? JSON.parse(logs[0].diff) : logs[0].diff;
      expect(diff.title.new).toContain('... [Total 500 chars]');
      expect(diff.meta.new.avatar).toContain('[Base64 Media Data');
    });

    test('3.3 复合类型字段零差异识别：传入完全等价的深层结构能够准确跳过审计', async () => {
      const repo = app.db.getRepository('stress_articles');
      const auditRepo = app.db.getRepository('logger_audit_logs');

      const complexPayload = {
        title: 'Deep Stable',
        meta: { config: { flag: true, scores: [10, 20] } },
      };

      const item = await repo.create({ values: complexPayload });

      const countBefore = await auditRepo.count({
        filter: { collectionName: 'stress_articles', recordId: String(item.id), actionName: 'update' },
      });

      // 发起完全等价深层结构的更新
      const res = await app.agent().resource('stress_articles').update({
        filterByTk: item.id,
        values: complexPayload,
      });

      expect(res.status).toBe(200);

      const countAfter = await auditRepo.count({
        filter: { collectionName: 'stress_articles', recordId: String(item.id), actionName: 'update' },
      });
      // 零差异跳过成功生效
      expect(countAfter).toBe(countBefore);
    });
  });

  describe('4. Compat Logger 异常与边界攻防测试 (/api/logger:list & /api/logger:download)', () => {
    test('4.1 download: 空入参、null、畸形结构输入防御', async () => {
      // 畸形 1: 空对象
      const res1 = await app.agent().post('/api/logger:download').send({});
      expect(res1.status).toBe(400);

      // 畸形 2: values 为 null
      const res2 = await app.agent().post('/api/logger:download').send({ values: null });
      expect(res2.status).toBe(400);

      // 畸形 3: values 为普通字符串
      const res3 = await app.agent().post('/api/logger:download').send({ values: 'not_an_object' });
      expect(res3.status).toBe(400);

      // 畸形 4: files 为非数组
      const res4 = await app.agent().post('/api/logger:download').send({ values: { files: 12345 } });
      expect(res4.status).toBe(400);
    });

    test('4.2 download: 路径穿越攻击防御 (Path Traversal Attack)', async () => {
      const traversalAttempts = [
        '../../secret.log',
        '..\\..\\secret.log',
        '/etc/passwd',
        'C:\\Windows\\System32\\drivers\\etc\\hosts',
        'sub/../../outside.log',
        '....//....//etc/passwd',
      ];

      for (const attackPath of traversalAttempts) {
        const res = await app.agent().post('/api/logger:download').send({
          values: { files: [attackPath] },
        });

        // 必须被拦截并返回 500 错误状态，绝不可返回 200 泄露文件或导致进程崩溃
        expect(res.status).toBe(500);
      }
    });

    test('4.3 download: 不存在的文件请求返回合规错误状态，不引起服务器崩溃', async () => {
      const res = await app.agent().post('/api/logger:download').send({
        values: { files: ['totally_non_existent_file_99999.log'] },
      });

      // 验证未找到文件时受控抛出 500 状态，且服务进程保持稳定
      expect(res.status).toBe(500);
    });

    test('4.4 list: 目录中存在嵌套目录、空目录及非 .log 文件时的健全过滤', async () => {
      // 创建空子目录及非 log 文件
      const emptySub = path.join(testLogDir, 'empty_dir');
      const ignoreFile = path.join(testLogDir, 'ignore_me.tmp');
      await fsp.mkdir(emptySub, { recursive: true });
      await fsp.writeFile(ignoreFile, 'not a log file', 'utf-8');

      try {
        const res = await app.agent().get('/api/logger:list');
        expect(res.status).toBe(200);

        const list = res.body?.data || res.body;
        expect(Array.isArray(list)).toBe(true);

        // 验证非 .log 文件已被过滤
        const hasTmp = list.some((item: any) => item === 'ignore_me.tmp');
        expect(hasTmp).toBe(false);

        // 验证空子目录没有无用条目
        const hasEmptyDir = list.some((item: any) => typeof item === 'object' && item.name === 'empty_dir');
        expect(hasEmptyDir).toBe(false);

        // 验证合规的 stress-audit.log 正常列出
        expect(list).toContain('stress-audit.log');
      } finally {
        if (fs.existsSync(ignoreFile)) await fsp.unlink(ignoreFile);
        if (fs.existsSync(emptySub)) await fsp.rmdir(emptySub);
      }
    });

    test('4.5 collect: 畸形前端上报结构容错与打包正常返回', async () => {
      // 畸形 1: error 为 null
      const res1 = await app.agent().post('/api/logger:collect').send({
        values: { error: null },
      });
      expect(res1.status).toBe(200);
      expect(res1.headers['content-disposition']).toContain('logs.tar.gz');

      // 畸形 2: values 为空对象
      const res2 = await app.agent().post('/api/logger:collect').send({});
      expect(res2.status).toBe(200);
      expect(res2.headers['content-disposition']).toContain('logs.tar.gz');
    });
  });
});
