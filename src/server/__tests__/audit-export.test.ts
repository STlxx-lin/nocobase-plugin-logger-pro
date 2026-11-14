import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MockServer, createMockServer } from '@nocobase/test';
import { Context } from 'koa';
import PluginLoggerProServer from '../index';
import {
  AuditExportService,
  normalizeFilter,
  LEGACY_FIELD_ALIASES,
  ALL_AUDIT_EXPORT_FIELDS,
} from '../services/audit-export.service';

/**
 * 构造轻量 Mock Koa Context，用于快速单元测试
 */
function createMockKoaContext(params: any = {}) {
  const headers: Record<string, string> = {};
  return {
    params,
    query: params,
    request: { query: params, body: params },
    headers,
    set(key: string, val: string) {
      headers[key.toLowerCase()] = val;
    },
    get(key: string) {
      return headers[key.toLowerCase()];
    },
    attachment(filename: string) {
      headers['content-disposition'] = `attachment; filename="${filename}"`;
    },
    throw(status: number, message: string) {
      const err = new Error(message) as any;
      err.status = status;
      throw err;
    },
    body: null as any,
    status: 200,
  } as any;
}

/**
 * 构造轻量 Mock Repository
 */
function createMockRepo(records: any[]) {
  return {
    find: async (opts: any = {}) => {
      let filtered = [...records];
      if (opts.filter?.id?.$gt) {
        filtered = filtered.filter((r) => r.id > opts.filter.id.$gt);
      }
      const limit = opts.limit || filtered.length;
      return filtered.slice(0, limit);
    },
  };
}

describe('AuditExportService & normalizeFilter Test Suite (Feature 15 & 18)', () => {
  // =========================================================================
  // 1. normalizeFilter 深度递归与别名映射单元测试
  // =========================================================================
  describe('1. normalizeFilter 单元测试', () => {
    test('1.1 基本字段别名映射 (username -> userUsername 等)', () => {
      const input = {
        username: 'alice',
        nickname: 'Ali',
        ua: 'Mozilla/5.0',
        diffSummary: 'summary',
        previousData: { old: 1 },
        newData: { new: 2 },
      };
      const result = normalizeFilter(input);
      expect(result).toEqual({
        userUsername: 'alice',
        userNickname: 'Ali',
        userAgent: 'Mozilla/5.0',
        diff: 'summary',
        beforeData: { old: 1 },
        afterData: { new: 2 },
      });
    });

    test('1.2 嵌套操作符别名映射 (如 { username: { $includes: "al" } })', () => {
      const input = {
        username: { $includes: 'al' },
        collectionName: 'users',
      };
      const result = normalizeFilter(input);
      expect(result).toEqual({
        userUsername: { $includes: 'al' },
        collectionName: 'users',
      });
    });

    test('1.3 逻辑操作符复合嵌套 ($and, $or, $not 数组递归)', () => {
      const input = {
        $and: [
          { username: { $includes: 'admin' } },
          {
            $or: [
              { nickname: 'SuperAdmin' },
              { ua: { $includes: 'Chrome' } },
            ],
          },
        ],
        $not: {
          username: 'guest',
        },
      };
      const result = normalizeFilter(input);
      expect(result).toEqual({
        $and: [
          { userUsername: { $includes: 'admin' } },
          {
            $or: [
              { userNickname: 'SuperAdmin' },
              { userAgent: { $includes: 'Chrome' } },
            ],
          },
        ],
        $not: {
          userUsername: 'guest',
        },
      });
    });

    test('1.4 边界值保护 (null, undefined, 原始类型, Date, RegExp 保持不变)', () => {
      expect(normalizeFilter(null)).toBeNull();
      expect(normalizeFilter(undefined)).toBeUndefined();
      expect(normalizeFilter('test')).toBe('test');
      expect(normalizeFilter(12345)).toBe(12345);
      expect(normalizeFilter(true)).toBe(true);

      const now = new Date();
      const reg = /test/i;
      expect(normalizeFilter(now)).toBe(now);
      expect(normalizeFilter(reg)).toBe(reg);

      const complex = {
        createdAt: { $gte: now },
        title: reg,
      };
      const res = normalizeFilter(complex);
      expect(res.createdAt.$gte).toBe(now);
      expect(res.title).toBe(reg);
    });
  });

  // =========================================================================
  // 2. CSV 导出与公式防注入安全测试
  // =========================================================================
  describe('2. CSV 格式与公式注入防护安全测试', () => {
    test('2.1 CSV 导出必须携带 UTF-8 BOM (\\uFEFF) 且首行为中文表头', async () => {
      const mockRecords = [
        {
          id: 1,
          createdAt: new Date('2026-11-13T10:00:00Z'),
          userUsername: 'admin',
          ip: '127.0.0.1',
          method: 'POST',
          path: '/api/test',
        },
      ];
      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo(mockRecords),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'csv',
        fields: ['createdAt', 'userUsername', 'ip', 'method', 'path'],
      });

      const body = ctx.body as string;
      expect(typeof body).toBe('string');
      // 验证 UTF-8 BOM
      expect(body.charCodeAt(0)).toBe(0xfeff);
      expect(body.startsWith('\uFEFF')).toBe(true);

      // 验证表头中文映射
      const firstLine = body.split('\r\n')[0];
      expect(firstLine).toContain('发生时间');
      expect(firstLine).toContain('操作用户名');
      expect(firstLine).toContain('客户端IP');
      expect(firstLine).toContain('请求方法');
      expect(firstLine).toContain('请求路径');

      // 验证 Content-Type 与 Attachment 响应头
      expect(ctx.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(ctx.headers['content-disposition']).toMatch(/attachment; filename="audit_logs_.*\.csv"/);
    });

    test('2.2 CSV 公式注入严格防御 (=, +, -, @, \\t, \\r 开头单引号转义)', async () => {
      const maliciousRecords = [
        {
          id: 1,
          userUsername: '=cmd|\' /C calc\'!A0',
          ip: '+12345678',
          method: '-5+3',
          path: '@SUM(A1:A10)',
          userAgent: '\tTabInjectedUA',
          actionName: '\rCRInjectedAction',
          collectionName: 'normal_collection', // 正常字符串不转义
        },
      ];
      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo(maliciousRecords),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'csv',
        fields: ['userUsername', 'ip', 'method', 'path', 'userAgent', 'actionName', 'collectionName'],
      });

      const csv = ctx.body as string;
      const dataRow = csv.split('\r\n')[1];

      // 等号开头转义
      expect(dataRow).toContain('\'=cmd|\' /C calc\'!A0');
      // 加号开头转义
      expect(dataRow).toContain('\'+12345678');
      // 减号开头转义
      expect(dataRow).toContain('\'-5+3');
      // @ 符号开头转义
      expect(dataRow).toContain('\'@SUM(A1:A10)');
      // \t 制表符开头转义
      expect(dataRow).toContain('\'\tTabInjectedUA');
      // \r 回车符开头转义
      expect(dataRow).toContain('\'\rCRInjectedAction');
      // 正常字符串不增加前缀单引号
      expect(dataRow).toContain('"normal_collection"');
      expect(dataRow).not.toContain('\'normal_collection');
    });

    test('2.3 单元格内容超长 (32KB) 截断保护', async () => {
      const hugeJson: Record<string, string> = {};
      for (let i = 0; i < 2000; i++) {
        hugeJson[`key_${i}`] = '0123456789abcdefghijklmnopqrstuvwxyz';
      }
      const record = {
        id: 1,
        userUsername: 'tester',
        beforeData: hugeJson,
      };
      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo([record]),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'csv',
        fields: ['userUsername', 'beforeData'],
      });

      const csv = ctx.body as string;
      expect(csv).toContain('... [truncated]');
    });
  });

  // =========================================================================
  // 3. Excel XML (SpreadsheetML) 导出格式测试
  // =========================================================================
  describe('3. Excel XML 格式与特殊字符转义测试', () => {
    test('3.1 Excel XML 导出头部命名空间与样式完整性', async () => {
      const records = [
        {
          id: 1,
          createdAt: new Date('2026-11-13T12:00:00Z'),
          userUsername: 'excel_user',
          statusCode: 200,
          durationMs: 45,
          method: 'GET',
        },
      ];
      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo(records),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'xlsx',
        fields: ['createdAt', 'userUsername', 'statusCode', 'durationMs', 'method'],
      });

      const xml = ctx.body as string;
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(xml).toContain('<Workbook');
      expect(xml).toContain('xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"');
      expect(xml).toContain('<Worksheet ss:Name="审计操作记录">');
      expect(xml).toContain('操作用户名');

      // 数值类型断言
      expect(xml).toContain('<Data ss:Type="Number">200</Data>');
      expect(xml).toContain('<Data ss:Type="Number">45</Data>');

      // 响应头断言
      expect(ctx.headers['content-type']).toBe('application/vnd.ms-excel; charset=utf-8');
      expect(ctx.headers['content-disposition']).toMatch(/attachment; filename="audit_logs_.*\.xls"/);
    });

    test('3.2 Excel XML 特殊 XML 字符实体转义 (&, <, >, ")', async () => {
      const records = [
        {
          id: 1,
          userUsername: '<script>alert("XSS")</script>',
          path: '/api/v1?a=1&b=2',
          errorMessage: 'Value > 100 && Value < 200 "Error"',
        },
      ];
      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo(records),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'xlsx',
        fields: ['userUsername', 'path', 'errorMessage'],
      });

      const xml = ctx.body as string;
      // 必须完成实体转义，不得出现未转义的原始 <script> 等
      expect(xml).toContain('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
      expect(xml).toContain('/api/v1?a=1&amp;b=2');
      expect(xml).toContain('Value &gt; 100 &amp;&amp; Value &lt; 200 &quot;Error&quot;');
      expect(xml).not.toContain('<script>');
    });
  });

  // =========================================================================
  // 4. JSON 导出功能测试
  // =========================================================================
  describe('4. JSON 格式导出测试', () => {
    test('4.1 导出标准 JSON 数组与正确响应头', async () => {
      const records = [
        {
          id: 1,
          userUsername: 'json_user',
          ip: '192.168.1.100',
          statusCode: 200,
          diff: JSON.stringify({ title: { old: 'A', new: 'B' } }),
          params: JSON.stringify({ page: 1, pageSize: 20 }),
        },
      ];
      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo(records),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'json',
        fields: ['userUsername', 'ip', 'statusCode', 'diff', 'params'],
      });

      expect(ctx.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(ctx.headers['content-disposition']).toMatch(/attachment; filename="audit_logs_.*\.json"/);

      const parsed = JSON.parse(ctx.body);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].userUsername).toBe('json_user');
      expect(parsed[0].ip).toBe('192.168.1.100');
      expect(parsed[0].statusCode).toBe(200);
      // JSON 快照字段应被反序列化为结构化对象
      expect(parsed[0].diff).toEqual({ title: { old: 'A', new: 'B' } });
      expect(parsed[0].params).toEqual({ page: 1, pageSize: 20 });
    });
  });

  // =========================================================================
  // 5. 边界与容错测试
  // =========================================================================
  describe('5. 边界与容错测试', () => {
    test('5.1 空记录导出 (无数据时不抛异常且格式规范)', async () => {
      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo([]),
        },
      };
      const service = new AuditExportService(mockApp);

      // CSV 空记录
      const ctxCsv = createMockKoaContext();
      await service.exportLogs(ctxCsv, { format: 'csv' });
      expect(ctxCsv.body.startsWith('\uFEFF')).toBe(true);
      expect(ctxCsv.body.split('\r\n').length).toBe(1);

      // JSON 空记录
      const ctxJson = createMockKoaContext();
      await service.exportLogs(ctxJson, { format: 'json' });
      expect(ctxJson.body).toBe('[]');
    });

    test('5.2 Limit 截断保护 (超出 MAX_EXPORT_LIMIT 自动截断至 50000，负数截断至 1)', async () => {
      let queriedLimit = 0;
      const mockApp: any = {
        db: {
          getRepository: () => ({
            find: async (opts: any) => {
              queriedLimit = opts.limit;
              return [];
            },
          }),
        },
      };
      const service = new AuditExportService(mockApp);

      const ctxOver = createMockKoaContext();
      await service.exportLogs(ctxOver, { limit: 999999, format: 'json' });
      expect(queriedLimit).toBe(2000); // 批量拉取单批为 2000

      const ctxNeg = createMockKoaContext();
      await service.exportLogs(ctxNeg, { limit: -10, format: 'json' });
      expect(queriedLimit).toBe(1); // 负数修正为 1
    });
  });

  // =========================================================================
  // 6. MockServer 真实数据库与 API 端到端集成测试 (SQLite)
  // =========================================================================
  describe('6. MockServer 端到端集成测试 (真实数据库与别名映射)', () => {
    let app: MockServer;
    let plugin: PluginLoggerProServer;

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

      // 向真实数据库插入两条特定用户测试数据
      const auditRepo = app.db.getRepository('logger_audit_logs');
      await auditRepo.create({
        values: {
          reqId: 'req_test_001',
          userUsername: 'export_target_user_alice',
          userNickname: 'Alice Wonderland',
          collectionName: 'articles',
          actionName: 'publish',
          statusCode: 200,
          ip: '10.0.0.1',
          method: 'POST',
          path: '/api/articles:publish',
        },
      });

      await auditRepo.create({
        values: {
          reqId: 'req_test_002',
          userUsername: 'export_other_user_bob',
          userNickname: 'Bob Builder',
          collectionName: 'articles',
          actionName: 'draft',
          statusCode: 200,
          ip: '10.0.0.2',
          method: 'POST',
          path: '/api/articles:draft',
        },
      });
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

    test('6.1 通过 API 发起导出并携带历史别名 { username: ... } 成功匹配真实数据', async () => {
      const res = await app.agent().post('/api/loggerPro:exportAuditLogs').send({
        format: 'csv',
        filter: {
          username: { $includes: 'alice' },
        },
        fields: ['userUsername', 'actionName', 'statusCode'],
      });

      expect(res.status).toBe(200);
      const csv = res.text;
      expect(csv.startsWith('\uFEFF')).toBe(true);
      // 成功包含目标用户
      expect(csv).toContain('export_target_user_alice');
      // 绝不包含未匹配的其他用户
      expect(csv).not.toContain('export_other_user_bob');
    });

    test('6.2 通过 API 发起 JSON 格式导出与复合条件查询', async () => {
      const res = await app.agent().post('/api/loggerPro:exportAuditLogs').send({
        format: 'json',
        filter: {
          $and: [
            { username: 'export_other_user_bob' },
            { actionName: 'draft' },
          ],
        },
        fields: ['userUsername', 'actionName', 'ip'],
      });

      expect(res.status).toBe(200);
      const list = JSON.parse(res.text);
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(1);
      expect(list[0].userUsername).toBe('export_other_user_bob');
      expect(list[0].actionName).toBe('draft');
      expect(list[0].ip).toBe('10.0.0.2');
    });
  });
});
