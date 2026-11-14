import { describe, test, expect, vi, beforeEach } from 'vitest';
import winston from 'winston';
import { LogConfigService } from '../services/log-config.service';
import { CONFIG_KEYS } from '../constants';

describe('LogConfigService Suite (Feature 8 & Feature 9)', () => {
  let mockApp: any;
  let mockRepo: any;
  let configService: LogConfigService;

  beforeEach(() => {
    // 构造深层嵌套的 Winston 模拟结构（贴合 SystemLoggerTransport 真实行为）
    const sysInnerLogger = {
      level: 'info',
      transports: [{ level: 'info' }],
    };
    const sysInnerErrorLogger = {
      level: 'info',
      transports: [{ level: 'info' }],
    };
    const systemTransport = {
      level: 'info',
      logger: sysInnerLogger,
      errorLogger: sysInnerErrorLogger,
    };

    // 系统外层 Logger（模拟 child logger 原型链）
    const rootLogger = {
      level: 'info',
      transports: [systemTransport],
    };
    const childAppLogger = Object.create(rootLogger);
    childAppLogger.level = 'info';

    // HTTP 请求 Logger
    const requestLogger = {
      level: 'info',
      transports: [{ level: 'info' }],
    };

    // SQL 日志 Logger
    const sqlLogger = {
      level: 'debug',
      silent: false,
      transports: [{ level: 'debug', silent: false }],
      debug: vi.fn(),
    };

    // 默认 Sequelize logging 回调
    const origLoggingFn = vi.fn();

    // 模拟数据源
    const extraDsDb = {
      sequelize: { options: { logging: origLoggingFn } },
      options: { logging: origLoggingFn },
    };

    mockRepo = {
      find: vi.fn().mockResolvedValue([
        { key: CONFIG_KEYS.LOGGER_LEVEL, value: 'info' },
        { key: CONFIG_KEYS.SQL_LOGGING, value: 'true' },
      ]),
      findOne: vi.fn().mockImplementation(({ filter }) => {
        return Promise.resolve({ id: 1, key: filter.key, value: 'old' });
      }),
      update: vi.fn().mockResolvedValue([1]),
      create: vi.fn().mockResolvedValue({ id: 2 }),
      createMany: vi.fn().mockResolvedValue([]),
    };

    mockApp = {
      name: 'main',
      logger: childAppLogger,
      _logger: childAppLogger,
      log: childAppLogger,
      requestLogger,
      _sqlLogger: sqlLogger,
      sqlLogger,
      context: { reqId: 'test-req-123' },
      db: {
        sequelize: {
          options: {
            logging: origLoggingFn,
          },
        },
        options: {
          logging: origLoggingFn,
        },
        getRepository: vi.fn().mockReturnValue(mockRepo),
      },
      dataSourceManager: {
        dataSources: new Map([['extra-ds', { collectionManager: { db: extraDsDb } }]]),
      },
    };

    configService = new LogConfigService(mockApp);
  });

  describe('Feature 8: 日志级别全链路深度递归穿透 (applyLogLevel)', () => {
    test('8.1 穿透外层 app.logger、transports 与原型链', () => {
      configService.applyLogLevel('debug');

      // 外层 logger 实例与原型
      expect(mockApp.logger.level).toBe('debug');
      const proto = Object.getPrototypeOf(mockApp.logger);
      expect(proto.level).toBe('debug');

      // transports 级别同步
      const sysTransport = proto.transports[0];
      expect(sysTransport.level).toBe('debug');
    });

    test('8.2 穿透 SystemLoggerTransport 内部真实 Winston logger 与 errorLogger 实例', () => {
      configService.applyLogLevel('warn');

      const sysTransport = mockApp.logger.transports[0];
      expect(sysTransport.level).toBe('warn');

      // 内部包装的真实 Winston 实例
      expect(sysTransport.logger.level).toBe('warn');
      expect(sysTransport.logger.transports[0].level).toBe('warn');

      // 内部包装的 errorLogger 实例
      expect(sysTransport.errorLogger.level).toBe('warn');
      expect(sysTransport.errorLogger.transports[0].level).toBe('warn');
    });

    test('8.3 深度穿透 app.requestLogger 与 app._sqlLogger 及其各 transports', () => {
      configService.applyLogLevel('error');

      // requestLogger
      expect(mockApp.requestLogger.level).toBe('error');
      expect(mockApp.requestLogger.transports[0].level).toBe('error');

      // _sqlLogger 与 sqlLogger
      expect(mockApp._sqlLogger.level).toBe('error');
      expect(mockApp._sqlLogger.transports[0].level).toBe('error');
      expect(mockApp.sqlLogger.level).toBe('error');
    });

    test('8.4 面对循环引用对象时安全终止（visited Set 保护，不爆栈）', () => {
      const circularLogger: any = { level: 'info' };
      circularLogger.transports = [circularLogger]; // 自身循环引用
      mockApp.logger = circularLogger;

      expect(() => {
        configService.applyLogLevel('debug');
      }).not.toThrow();

      expect(circularLogger.level).toBe('debug');
    });

    test('8.5 空值或非法参数安全防御，不抛出异常', () => {
      expect(() => {
        (configService as any).applyLogLevel(null);
        (configService as any).applyLogLevel(undefined);
        (configService as any).applyLogLevel(123 as any);
      }).not.toThrow();
    });

    test('8.6 真实 Winston Child Logger 与类原型安全拦截（不触发 pipes getter 异常且成功穿透）', () => {
      const warnSpy = vi.fn();
      const realRootLogger = winston.createLogger({
        level: 'info',
        transports: [new winston.transports.Console({ level: 'info' })],
      });
      const realChildLogger = realRootLogger.child({ module: 'test-child' });

      const testApp: any = {
        logger: realChildLogger,
        requestLogger: winston.createLogger({ level: 'info', transports: [new winston.transports.Console()] }),
        _sqlLogger: winston.createLogger({ level: 'info', transports: [new winston.transports.Console()] }),
      };
      testApp.logger.warn = warnSpy;

      const testConfigService = new LogConfigService(testApp);
      testConfigService.applyLogLevel('debug');

      // 验证不发生任何告警
      expect(warnSpy).not.toHaveBeenCalled();

      // 验证 child 与 root 实例及其 transports 的 level 均成功穿透同步
      expect(realChildLogger.level).toBe('debug');
      expect(realRootLogger.level).toBe('debug');
      expect(realRootLogger.transports[0].level).toBe('debug');

      // 验证后续的 requestLogger 与 _sqlLogger 均成功穿透
      expect(testApp.requestLogger.level).toBe('debug');
      expect(testApp._sqlLogger.level).toBe('debug');
    });

    test('8.7 直接传入 winston.Logger.prototype 时安全防御，不抛出异常', () => {
      const visited = new Set<any>();
      expect(() => {
        (configService as any).updateLoggerRecursively(winston.Logger.prototype, 'warn', visited);
      }).not.toThrow();
    });

    test('8.8 子 Logger 独立穿透隔离性：前置 Logger 抛错不阻断后续 requestLogger 与 _sqlLogger', () => {
      const brokenLogger = new Proxy({}, {
        get(target, prop) {
          if (prop === 'transports' || prop === 'level') {
            throw new Error('Fatal error inside broken logger');
          }
          return undefined;
        },
      });

      const testApp: any = {
        logger: brokenLogger,
        requestLogger: { level: 'info', transports: [{ level: 'info' }] },
        _sqlLogger: { level: 'info', transports: [{ level: 'info' }] },
      };

      const testConfigService = new LogConfigService(testApp);
      expect(() => {
        testConfigService.applyLogLevel('error');
      }).not.toThrow();

      // 验证 requestLogger 和 _sqlLogger 仍然被成功穿透设置为 error
      expect(testApp.requestLogger.level).toBe('error');
      expect(testApp.requestLogger.transports[0].level).toBe('error');
      expect(testApp._sqlLogger.level).toBe('error');
      expect(testApp._sqlLogger.transports[0].level).toBe('error');
    });
  });

  describe('Feature 9: SQL 日志开关联动 (applySqlLogging)', () => {
    test('9.1 applySqlLogging(false): 将 Sequelize logging 设为 false，并静音 _sqlLogger', () => {
      configService.applySqlLogging(false);

      // Sequelize options.logging 被置为 false
      expect(mockApp.db.sequelize.options.logging).toBe(false);
      expect(mockApp.db.options.logging).toBe(false);

      // _sqlLogger 及其 transports 状态静音
      expect(mockApp._sqlLogger.silent).toBe(true);
      expect(mockApp._sqlLogger.transports[0].silent).toBe(true);

      // 外部数据源同步禁用
      const extraDs = mockApp.dataSourceManager.dataSources.get('extra-ds');
      expect(extraDs.collectionManager.db.sequelize.options.logging).toBe(false);
    });

    test('9.2 applySqlLogging(true): 恢复标准回调函数，解禁 _sqlLogger，且严禁设为布尔值 true', () => {
      // 先关闭（触发备份原始回调）
      configService.applySqlLogging(false);
      expect(mockApp.db.sequelize.options.logging).toBe(false);

      // 再开启
      configService.applySqlLogging(true);

      // 必须是函数，绝对不能是布尔值 true（避免 Sequelize console.log 弃用告警与终端污染）
      expect(typeof mockApp.db.sequelize.options.logging).toBe('function');
      expect(mockApp.db.sequelize.options.logging).not.toBe(true);

      // _sqlLogger 解除静音
      expect(mockApp._sqlLogger.silent).toBe(false);
      expect(mockApp._sqlLogger.transports[0].silent).toBe(false);

      // 外部数据源同样恢复函数
      const extraDs = mockApp.dataSourceManager.dataSources.get('extra-ds');
      expect(typeof extraDs.collectionManager.db.sequelize.options.logging).toBe('function');
      expect(extraDs.collectionManager.db.sequelize.options.logging).not.toBe(true);
    });

    test('9.3 无原始回调时的兜底回调 (createSqlLoggingCallback): 正常格式化并输出到 _sqlLogger.debug', () => {
      // 清空原始回调
      mockApp.db.sequelize.options.logging = false;
      mockApp.db.options.logging = false;

      configService.applySqlLogging(true);
      const callback = mockApp.db.sequelize.options.logging;
      expect(typeof callback).toBe('function');

      // 执行常规 SELECT 回调模拟 Sequelize 输出
      callback('SELECT * FROM users\nWHERE id = 1', 15);

      expect(mockApp._sqlLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'SELECT * FROM users WHERE id = 1',
          executeTime: 15,
          app: 'main',
          reqId: 'test-req-123',
        }),
      );

      // 短 INSERT 绝不误伤截断测试（长度远小于 2000，断言精确等于原 SQL 且末尾绝对不以 ... 结尾）
      const shortInsert = 'INSERT INTO users (id, name) VALUES (1, "Alice")';
      callback(shortInsert, 5);
      const shortCallArg = mockApp._sqlLogger.debug.mock.calls[mockApp._sqlLogger.debug.mock.calls.length - 1][0];
      expect(shortCallArg.message).toBe('INSERT INTO users (id, name) VALUES (1, "Alice")');
      expect(shortCallArg.message.endsWith('...')).toBe(false);
      expect(shortCallArg.executeTime).toBe(5);

      // 恰好 2000 字符的 INSERT：不截断、不追加省略号
      const prefix = 'INSERT INTO boundary (v) VALUES (';
      const suffix = ')';
      const exact2000Sql = prefix + 'x'.repeat(2000 - prefix.length - suffix.length) + suffix;
      expect(exact2000Sql.length).toBe(2000);
      callback(exact2000Sql, 8);
      const exactCallArg = mockApp._sqlLogger.debug.mock.calls[mockApp._sqlLogger.debug.mock.calls.length - 1][0];
      expect(exactCallArg.message).toBe(exact2000Sql);
      expect(exactCallArg.message.endsWith('...')).toBe(false);
      expect(exactCallArg.message.length).toBe(2000);

      // 超长 INSERT 截断保护测试（长度 > 2000 时截取前 2000 字符并追加 ...，断言长度为 2003 且以 ... 结尾）
      const longSql = 'INSERT INTO logs (data) VALUES (' + 'a'.repeat(3000) + ')';
      callback(longSql, 20);
      const lastCallArg = mockApp._sqlLogger.debug.mock.calls[mockApp._sqlLogger.debug.mock.calls.length - 1][0];
      expect(lastCallArg.message.length).toBe(2003);
      expect(lastCallArg.message.endsWith('...')).toBe(true);
      expect(lastCallArg.message.startsWith('INSERT INTO logs (data) VALUES (')).toBe(true);
    });

    test('9.4 set() 方法对 LOGGER_LEVEL 与 SQL_LOGGING 的动态触发联动', async () => {
      const applyLevelSpy = vi.spyOn(configService, 'applyLogLevel');
      const applySqlSpy = vi.spyOn(configService, 'applySqlLogging');

      // 变更日志级别
      await configService.set(CONFIG_KEYS.LOGGER_LEVEL, 'debug');
      expect(applyLevelSpy).toHaveBeenCalledWith('debug');

      // 变更 SQL 开关为关闭
      await configService.set(CONFIG_KEYS.SQL_LOGGING, 'false');
      expect(applySqlSpy).toHaveBeenCalledWith(false);

      // 变更 SQL 开关为开启
      await configService.set(CONFIG_KEYS.SQL_LOGGING, '1');
      expect(applySqlSpy).toHaveBeenCalledWith(true);
    });

    test('9.5 init() 方法自动初始化默认级别与 SQL 日志联动', async () => {
      const applyLevelSpy = vi.spyOn(configService, 'applyLogLevel');
      const applySqlSpy = vi.spyOn(configService, 'applySqlLogging');

      await configService.init();

      expect(applyLevelSpy).toHaveBeenCalledWith('info');
      expect(applySqlSpy).toHaveBeenCalledWith(true);
    });
  });
});
