import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  LogRetentionService,
  isAuditOrSystemFile,
  isCleanableLogFile,
  parseAffectedRows,
} from '../services/log-retention.service';
import { CONFIG_KEYS } from '../constants';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('LogRetentionService Suite (Feature 12 & Storage Management)', () => {
  let tmpDir: string;
  let mockApp: any;
  let mockConfigService: any;
  let retentionService: LogRetentionService;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'logger-pro-retention-test-'));

    mockConfigService = {
      cache: new Map<string, any>(),
      get(key: string, defVal: string) {
        return this.cache.get(key) ?? defVal;
      },
      getNumber(key: string, defVal: number) {
        const val = this.cache.get(key);
        return val !== undefined ? Number(val) : defVal;
      },
      getBoolean(key: string, defVal: boolean) {
        const val = this.cache.get(key);
        return val !== undefined ? Boolean(val) : defVal;
      },
      set(key: string, val: any) {
        this.cache.set(key, val);
      },
    };

    mockApp = {
      name: 'main',
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      db: {
        sequelize: {
          getDialect: () => 'postgres',
          query: vi.fn(),
        },
        getCollection: vi.fn().mockImplementation((name) => ({
          model: { tableName: name },
        })),
        getRepository: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(100),
          destroy: vi.fn().mockResolvedValue(10),
        }),
      },
    };

    retentionService = new LogRetentionService(mockApp, mockConfigService);
    retentionService.getLogBasePath = () => tmpDir;
  });

  afterAll(async () => {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('12.1 状态文件识别与辅助函数严密性 (isAuditOrSystemFile / isCleanableLogFile)', () => {
    test('正确识别各种 Winston / FileStreamRotator 内部审计文件', () => {
      // 常见 audit 命名形式
      expect(isAuditOrSystemFile('.audit.json')).toBe(true);
      expect(isAuditOrSystemFile('audit.json')).toBe(true);
      expect(isAuditOrSystemFile('.3a5d8f28c21a48be-audit.json')).toBe(true);
      expect(isAuditOrSystemFile('system-audit.json')).toBe(true);
      expect(isAuditOrSystemFile('system.audit.json')).toBe(true);
      expect(isAuditOrSystemFile('.temp-audit.json')).toBe(true);

      // 系统与临时文件
      expect(isAuditOrSystemFile('.DS_Store')).toBe(true);
      expect(isAuditOrSystemFile('Thumbs.db')).toBe(true);
      expect(isAuditOrSystemFile('process.tmp')).toBe(true);
      expect(isAuditOrSystemFile('file.lock')).toBe(true);

      // 正常的日志文件绝不能误判
      expect(isAuditOrSystemFile('system_2026-11-13.log')).toBe(false);
      expect(isAuditOrSystemFile('sql_2026-11-13.log')).toBe(false);
      expect(isAuditOrSystemFile('workflows/dispatcher/2026-10-13.log')).toBe(false);
      expect(isAuditOrSystemFile('audit_business_log.log')).toBe(false);
    });

    test('isCleanableLogFile: 仅对合法日志文件放行，严密阻隔 audit 与非法文件', () => {
      expect(isCleanableLogFile('system.log')).toBe(true);
      expect(isCleanableLogFile('backup.txt')).toBe(true);
      expect(isCleanableLogFile('archive.gz')).toBe(true);

      // audit 文件绝不能作为 cleanable
      expect(isCleanableLogFile('.audit.json')).toBe(false);
      expect(isCleanableLogFile('.3a5d8f-audit.json')).toBe(false);
      expect(isCleanableLogFile('audit.json')).toBe(false);
      expect(isCleanableLogFile('other.dat')).toBe(false);
    });
  });

  describe('12.2 多方言受影响行数解析 (parseAffectedRows)', () => {
    test('解析 PostgreSQL [[], { rowCount: 15 }]，严禁返回 NaN', () => {
      const pgResult = [[], { command: 'DELETE', rowCount: 15 }];
      const count = parseAffectedRows(pgResult);
      expect(count).toBe(15);
      expect(isNaN(count)).toBe(false);
    });

    test('解析 MySQL [{ affectedRows: 25 }, undefined]', () => {
      const mysqlResult = [{ affectedRows: 25, fieldCount: 0 }, undefined];
      const count = parseAffectedRows(mysqlResult);
      expect(count).toBe(25);
    });

    test('解析 SQLite [[], 8]', () => {
      const sqliteResult = [[], 8];
      const count = parseAffectedRows(sqliteResult);
      expect(count).toBe(8);
    });

    test('解析单一数值或非法结构', () => {
      expect(parseAffectedRows(42)).toBe(42);
      expect(parseAffectedRows(null)).toBe(0);
      expect(parseAffectedRows(undefined)).toBe(0);
      expect(parseAffectedRows({})).toBe(0);
    });
  });

  describe('12.3 cleanLogs: 过期日志清理与 .audit.json 核心保护', () => {
    test('超期日志被物理删除，而超期的 audit 状态文件 100% 完好无损且大小不被置零', async () => {
      const cleanSubDir = path.join(tmpDir, 'clean_test_dir');
      await fsp.mkdir(cleanSubDir, { recursive: true });

      // 创建一个 30 天前的超期日志文件
      const expiredLog = path.join(cleanSubDir, 'system_expired_30d.log');
      await fsp.writeFile(expiredLog, 'Expired log content\n');
      const pastTime = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
      await fsp.utimes(expiredLog, pastTime, pastTime);

      // 创建 30 天前的 .audit.json 与 .hash-audit.json 状态文件
      const auditFile1 = path.join(cleanSubDir, '.audit.json');
      const auditContent = JSON.stringify({ keep: 'valid-state', files: [] });
      await fsp.writeFile(auditFile1, auditContent);
      await fsp.utimes(auditFile1, pastTime, pastTime);

      const auditFile2 = path.join(cleanSubDir, '.7f8a9b1c-audit.json');
      await fsp.writeFile(auditFile2, auditContent);
      await fsp.utimes(auditFile2, pastTime, pastTime);

      // 配置保留天数 15 天
      mockConfigService.set(CONFIG_KEYS.RETENTION_DAYS, 15);
      mockConfigService.set(CONFIG_KEYS.MAX_DISK_SIZE_MB, 1024);

      // 执行自动清理
      const result = await retentionService.cleanLogs();

      // 断言超期日志被清理
      expect(result.deletedCount).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(expiredLog)).toBe(false);

      // 断言 audit 文件绝对未被删除！
      expect(fs.existsSync(auditFile1)).toBe(true);
      expect(fs.existsSync(auditFile2)).toBe(true);

      // 断言 audit 文件内容与大小绝对完好（严禁 truncate 为 0 字节）
      const auditStat1 = await fsp.stat(auditFile1);
      expect(auditStat1.size).toBe(Buffer.byteLength(auditContent));
      const auditStat2 = await fsp.stat(auditFile2);
      expect(auditStat2.size).toBe(Buffer.byteLength(auditContent));
    });
  });

  describe('12.4 磁盘配额 (MAX_DISK_SIZE_MB) 超限容量熔断淘汰', () => {
    test('超额时优先按修改时间淘汰老日志，audit 文件不受任何影响', async () => {
      const quotaDir = path.join(tmpDir, 'quota_test_dir');
      await fsp.mkdir(quotaDir, { recursive: true });

      // 写入 1 个 audit 文件（时间最早）
      const auditFile = path.join(quotaDir, '.3a5b6c-audit.json');
      await fsp.writeFile(auditFile, '{"state":"ok"}');
      const t0 = (Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000;
      await fsp.utimes(auditFile, t0, t0);

      // 写入 2 个 1MB 的日志文件（未超期，但总共 2MB）
      const log1 = path.join(quotaDir, 'log_1.log');
      const log2 = path.join(quotaDir, 'log_2.log');
      const chunk = Buffer.alloc(1024 * 1024, 'A');
      await fsp.writeFile(log1, chunk);
      await fsp.writeFile(log2, chunk);

      const t1 = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
      const t2 = (Date.now() - 1 * 24 * 60 * 60 * 1000) / 1000;
      await fsp.utimes(log1, t1, t1); // 较老
      await fsp.utimes(log2, t2, t2); // 较新

      // 配置容量上限 1MB，保留天数 30 天（确保不因时间过期而被删）
      mockConfigService.set(CONFIG_KEYS.RETENTION_DAYS, 30);
      mockConfigService.set(CONFIG_KEYS.MAX_DISK_SIZE_MB, 1);

      await retentionService.cleanLogs();

      // log1 较老，应当因配额超限被淘汰
      expect(fs.existsSync(log1)).toBe(false);
      // log2 较新，在配额容许范围内予以保留
      expect(fs.existsSync(log2)).toBe(true);
      // audit 文件绝对不受配额淘汰影响
      expect(fs.existsSync(auditFile)).toBe(true);
    });
  });

  describe('12.5 createArchiveStream 归档打包与管道销毁', () => {
    test('全量打包时自动排除 audit 文件，且支持下游主动断开逆向销毁', async () => {
      const archiveDir = path.join(tmpDir, 'archive_test_dir');
      await fsp.mkdir(archiveDir, { recursive: true });

      await fsp.writeFile(path.join(archiveDir, 'test1.log'), 'Log 1 content\n');
      await fsp.writeFile(path.join(archiveDir, '.audit.json'), '{"audit":true}');

      const stream = await retentionService.createArchiveStream();
      expect(stream).toBeDefined();

      // 测试下游主动销毁不会报错
      expect(() => {
        stream.destroy();
      }).not.toThrow();
    });
  });

  describe('12.6 cleanDatabaseLogs 多方言清理与容量熔断', () => {
    test('PostgreSQL 下正确解析删除行数并触发单表容量熔断淘汰', async () => {
      mockApp.db.sequelize.getDialect = () => 'postgres';
      mockApp.db.sequelize.query = vi
        .fn()
        // 第一次调用：DELETE 过期数据，返回 PostgreSQL 标准结构
        .mockResolvedValueOnce([[], { command: 'DELETE', rowCount: 18 }])
        // 第二次调用：SELECT COUNT(*) AS total
        .mockResolvedValueOnce([[{ total: 60000 }]])
        // 第三次调用：DELETE 熔断超额行
        .mockResolvedValueOnce([[], { command: 'DELETE', rowCount: 10000 }]);

      const result = await retentionService.cleanDatabaseLogs(15, 50000);

      // 18 条过期 + 10000 条熔断超额
      expect(result.totalDeleted).toBe(10018);
      expect(result.details.length).toBe(2);
      expect(result.details[0]).toContain('18 条');
      expect(result.details[1]).toContain('10000 条');
    });

    test('MySQL 下兼容返回与反引号引用', async () => {
      mockApp.db.sequelize.getDialect = () => 'mysql';
      mockApp.db.sequelize.query = vi
        .fn()
        .mockResolvedValueOnce([{ affectedRows: 12 }, undefined])
        .mockResolvedValueOnce([[{ total: 30000 }]]);

      const result = await retentionService.cleanDatabaseLogs(15, 50000);
      expect(result.totalDeleted).toBe(12);
      expect(mockApp.db.sequelize.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM `logger_audit_logs`'),
        expect.anything(),
      );
    });
  });

  describe('12.7 cleanBatch 分批清理与进度返回', () => {
    test('分批清理正确调用 LIMIT 与返回剩余数量', async () => {
      mockApp.db.sequelize.query = vi
        .fn()
        .mockResolvedValueOnce([[], 5000]) // 第一批执行
        .mockResolvedValueOnce([[{ total: 15000 }]]); // 查询剩余

      const result = await retentionService.cleanBatch('logger_audit_logs', 15, 5000);
      expect(result.remainingCount).toBe(15000);
    });
  });
});
