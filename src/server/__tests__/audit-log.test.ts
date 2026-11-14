import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MockServer, createMockServer } from '@nocobase/test';
import PluginLoggerProServer from '../index';
import { CONFIG_KEYS } from '../constants';

function parseJsonField(val: any) {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

describe('AuditLog Middleware & ZeroDiffSkip Suite', () => {
  let app: MockServer;
  let plugin: PluginLoggerProServer;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: [[PluginLoggerProServer, { name: 'logger-pro' }]],
      resourcer: {
        prefix: '/api',
      },
    });

    // 注册测试用业务数据表
    app.db.collection({
      name: 'test_articles',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'text', name: 'content' },
        { type: 'password', name: 'password' },
      ],
    });

    await app.load();
    await app.db.sync();
    plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;
  });

  afterAll(async () => {
    if (app) {
      if (plugin?.retentionService) {
        plugin.retentionService.stopScheduler();
      }
      try {
        if (app.db) {
          await app.db.clean({ drop: true });
        }
        await app.destroy();
      } catch (e) {
        // ignore cleanup error
      }
    }
  });

  test('1. 正常 Create 写操作能够生成审计日志及快照', async () => {
    const auditRepo = app.db.getRepository('logger_audit_logs');

    const res = await app.agent().resource('test_articles').create({
      values: {
        title: 'Initial Title',
        content: 'Article content',
        password: 'my-secret-password',
      },
    });

    expect(res.status).toBe(200);
    const createdId = res.body?.data?.id || res.body?.id;
    expect(createdId).toBeDefined();

    const latestLogs = await auditRepo.find({
      filter: { collectionName: 'test_articles', actionName: 'create' },
      sort: ['-createdAt'],
    });

    expect(latestLogs.length).toBeGreaterThan(0);
    const log = latestLogs[0];
    expect(log.collectionName).toBe('test_articles');
    expect(log.actionName).toBe('create');
    expect(log.statusCode).toBe(200);
    const afterData = parseJsonField(log.afterData);
    expect(afterData?.title).toBe('Initial Title');
    // 敏感字段脱敏检查
    expect(afterData?.password).toBe('******');
  });

  test('2. 正常 Update 操作有字段变更时能够正确生成 Diff 对比记录', async () => {
    const articlesRepo = app.db.getRepository('test_articles');
    const auditRepo = app.db.getRepository('logger_audit_logs');

    const article = await articlesRepo.create({
      values: { title: 'Version 1', content: 'Content 1' },
    });

    const res = await app.agent().resource('test_articles').update({
      filterByTk: article.id,
      values: { title: 'Version 2' },
    });

    expect(res.status).toBe(200);

    const updateLogs = await auditRepo.find({
      filter: {
        collectionName: 'test_articles',
        actionName: 'update',
        recordId: String(article.id),
      },
      sort: ['-createdAt'],
    });

    expect(updateLogs.length).toBeGreaterThan(0);
    const log = updateLogs[0];
    const diff = parseJsonField(log.diff);
    expect(diff).toBeDefined();
    expect(diff.title).toBeDefined();
    expect(diff.title.old).toBe('Version 1');
    expect(diff.title.new).toBe('Version 2');
    const beforeData = parseJsonField(log.beforeData);
    const afterData = parseJsonField(log.afterData);
    expect(beforeData?.title).toBe('Version 1');
    expect(afterData?.title).toBe('Version 2');
  });

  test('3. 【核心验证】开启 zeroDiffSkip 且无字段变更时，绝不抛出 next() called multiple times 崩溃，且跳过保存', async () => {
    const articlesRepo = app.db.getRepository('test_articles');
    const auditRepo = app.db.getRepository('logger_audit_logs');

    // 确保开启 zeroDiffSkip
    await plugin.configService.set(CONFIG_KEYS.AUDIT_ZERO_DIFF_SKIP, 'true');

    const article = await articlesRepo.create({
      values: { title: 'Stable Title', content: 'Stable Content' },
    });

    const countBefore = await auditRepo.count({
      filter: { recordId: String(article.id), actionName: 'update' },
    });

    // 发起无业务字段差异的更新请求（传入与现有值完全相同的属性）
    const res = await app.agent().resource('test_articles').update({
      filterByTk: article.id,
      values: { title: 'Stable Title' },
    });

    // 关键断言 1: 请求必须成功返回 200，绝不可因二次调用 next() 导致 500 或崩溃
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();

    // 关键断言 2: zeroDiffSkip 生效，审计日志未新增条目
    const countAfter = await auditRepo.count({
      filter: { recordId: String(article.id), actionName: 'update' },
    });
    expect(countAfter).toBe(countBefore);
  });

  test('4. 关闭 zeroDiffSkip 时，无字段差异的更新仍然会保存审计记录', async () => {
    const articlesRepo = app.db.getRepository('test_articles');
    const auditRepo = app.db.getRepository('logger_audit_logs');

    // 关闭 zeroDiffSkip
    await plugin.configService.set(CONFIG_KEYS.AUDIT_ZERO_DIFF_SKIP, 'false');

    const article = await articlesRepo.create({
      values: { title: 'NoSkip Title', content: 'NoSkip Content' },
    });

    const countBefore = await auditRepo.count({
      filter: { recordId: String(article.id), actionName: 'update' },
    });

    // 发起相同的更新请求
    const res = await app.agent().resource('test_articles').update({
      filterByTk: article.id,
      values: { title: 'NoSkip Title' },
    });

    expect(res.status).toBe(200);

    // 断言日志已保存
    const countAfter = await auditRepo.count({
      filter: { recordId: String(article.id), actionName: 'update' },
    });
    expect(countAfter).toBe(countBefore + 1);

    // 恢复配置
    await plugin.configService.set(CONFIG_KEYS.AUDIT_ZERO_DIFF_SKIP, 'true');
  });

  test('5. Destroy 删除操作记录修改前快照', async () => {
    const articlesRepo = app.db.getRepository('test_articles');
    const auditRepo = app.db.getRepository('logger_audit_logs');

    const article = await articlesRepo.create({
      values: { title: 'To Delete', content: 'Will be deleted' },
    });

    const res = await app.agent().resource('test_articles').destroy({
      filterByTk: article.id,
    });

    expect(res.status).toBe(200);

    const destroyLogs = await auditRepo.find({
      filter: {
        collectionName: 'test_articles',
        actionName: 'destroy',
        recordId: String(article.id),
      },
    });

    expect(destroyLogs.length).toBeGreaterThan(0);
    const beforeData = parseJsonField(destroyLogs[0].beforeData);
    expect(beforeData?.title).toBe('To Delete');
  });

  test('6. 内部排除集合与自定义排除配置正常生效', async () => {
    const auditRepo = app.db.getRepository('logger_audit_logs');
    const initialCount = await auditRepo.count({ filter: { collectionName: 'logger_configs' } });

    // 对内部排除表执行操作
    await app.agent().resource('logger_configs').create({
      values: { key: 'test_key', value: 'test_val' },
    });

    const countAfter = await auditRepo.count({ filter: { collectionName: 'logger_configs' } });
    expect(countAfter).toBe(initialCount);
  });
});
