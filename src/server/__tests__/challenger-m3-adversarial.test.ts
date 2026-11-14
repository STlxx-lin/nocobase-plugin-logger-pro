import { describe, test, expect, vi, beforeEach } from 'vitest';
import { LogConfigService } from '../services/log-config.service';
import { CONFIG_KEYS } from '../constants';

describe('Milestone M3 对抗性极限压力与攻击断言套件 (Challenger Adversarial Suite)', () => {
  let mockApp: any;
  let configService: LogConfigService;

  beforeEach(() => {
    mockApp = {
      name: 'adversarial-app',
      logger: {
        level: 'info',
        transports: [{ level: 'info' }],
      },
      requestLogger: {
        level: 'info',
        transports: [{ level: 'info' }],
      },
      _sqlLogger: {
        level: 'info',
        silent: false,
        transports: [{ level: 'info', silent: false }],
        debug: vi.fn(),
      },
      sqlLogger: {
        level: 'info',
        silent: false,
        transports: [{ level: 'info', silent: false }],
        debug: vi.fn(),
      },
      context: { reqId: 'adv-req-999' },
      db: {
        sequelize: {
          options: {
            logging: vi.fn(),
          },
        },
        options: {
          logging: vi.fn(),
        },
        getRepository: vi.fn().mockReturnValue({
          find: vi.fn().mockResolvedValue([]),
          findOne: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({}),
          createMany: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([1]),
        }),
      },
      dataSourceManager: {
        dataSources: new Map(),
      },
    };
    configService = new LogConfigService(mockApp);
  });

  describe('【对抗断言 1】LogConfigService.applyLogLevel(level) 深度穿透、循环引用与畸变对象防御', () => {
    test('1.1 十层深层原型继承体系 (Deep Prototype Chain) 完整穿透，逐层断言', () => {
      // 构造 10 层原型链：L9 -> L8 -> ... -> L1 -> L0
      const levels: any[] = [];
      let currentProto: any = {
        level: 'level-0',
        transports: [{ level: 'level-0', id: 0 }],
      };
      levels.push(currentProto);

      for (let i = 1; i < 10; i++) {
        const nextLayer = Object.create(currentProto);
        nextLayer.level = `level-${i}`;
        nextLayer.transports = [{ level: `level-${i}`, id: i }];
        levels.push(nextLayer);
        currentProto = nextLayer;
      }

      mockApp.logger = currentProto; // 顶层 L9

      // 执行穿透
      configService.applyLogLevel('debug');

      // 断言每一层原型链对象及其 transports 均已被同步为 'debug'
      for (let i = 0; i < 10; i++) {
        expect(levels[i].level).toBe('debug');
        expect(levels[i].transports[0].level).toBe('debug');
      }
    });

    test('1.2 复杂多节点复式网状循环引用拓扑，验证毫秒级终止且绝不爆栈 (No Stack Overflow)', () => {
      const nodeA: any = { level: 'info', name: 'A' };
      const nodeB: any = { level: 'info', name: 'B' };
      const nodeC: any = { level: 'info', name: 'C' };

      const transport1: any = { level: 'info', name: 'T1' };
      const transport2: any = { level: 'info', name: 'T2' };
      const transport3: any = { level: 'info', name: 'T3' };

      // 构造复杂的网状交叉循环拓扑
      nodeA.transports = [transport1];
      transport1.logger = nodeB;

      nodeB.transports = [transport2];
      transport2.errorLogger = nodeC;

      nodeC.transports = [transport3];
      transport3.logger = nodeA; // 环状回到 A
      transport3.errorLogger = nodeB; // 交叉指向 B

      // 自身自环
      transport2.logger = nodeB;

      mockApp.logger = nodeA;

      const startTime = performance.now();
      expect(() => {
        configService.applyLogLevel('warn');
      }).not.toThrow();
      const duration = performance.now() - startTime;

      // 毫秒级返回
      expect(duration).toBeLessThan(50);

      // 所有环路节点均已更新
      expect(nodeA.level).toBe('warn');
      expect(nodeB.level).toBe('warn');
      expect(nodeC.level).toBe('warn');
      expect(transport1.level).toBe('warn');
      expect(transport2.level).toBe('warn');
      expect(transport3.level).toBe('warn');
    });

    test('1.3 200 层嵌套子 Logger/Transport 极限纵深链路穿透测试', () => {
      // 构造 200 层深的包装链：transport.logger.transports[0].logger...
      const rootLogger: any = { level: 'info', transports: [] };
      let curr = rootLogger;
      const allLoggers = [rootLogger];

      for (let i = 0; i < 200; i++) {
        const innerLogger = { level: 'info', transports: [] };
        allLoggers.push(innerLogger);
        const trans: any = { level: 'info', logger: innerLogger };
        curr.transports.push(trans);
        curr = innerLogger;
      }

      mockApp.logger = rootLogger;

      expect(() => {
        configService.applyLogLevel('error');
      }).not.toThrow();

      // 随机抽查与首尾断言
      expect(allLoggers[0].level).toBe('error');
      expect(allLoggers[50].level).toBe('error');
      expect(allLoggers[100].level).toBe('error');
      expect(allLoggers[199].level).toBe('error');
      expect(allLoggers[200].level).toBe('error');
    });

    test('1.4 畸变与恶意对象注入（含 null、undefined、非对象、冻结对象、只读 getter）无崩溃运行', () => {
      const frozenTransport = Object.freeze({ level: 'info' });
      const readOnlyLogger: any = {};
      Object.defineProperty(readOnlyLogger, 'level', {
        get() {
          return 'immutable';
        },
        set() {
          throw new Error('Denied! Object is read-only');
        },
        configurable: false,
      });

      const poisonLogger: any = {
        level: 'info',
        transports: [
          null,
          undefined,
          12345,
          'bad-transport',
          true,
          [],
          {},
          frozenTransport,
          {
            level: 'info',
            logger: null,
            errorLogger: undefined,
          },
          {
            level: 'info',
            logger: 'not-an-object',
            errorLogger: 999,
          },
          {
            level: 'info',
            logger: readOnlyLogger,
          },
        ],
      };

      // 原型为 Object.create(null) 的极端对象
      const nullProto = Object.create(null);
      nullProto.level = 'info';
      nullProto.transports = [{ level: 'info' }];
      const childOfNull = Object.create(nullProto);
      childOfNull.level = 'info';

      mockApp.logger = poisonLogger;
      (mockApp as any)._logger = childOfNull;

      expect(() => {
        configService.applyLogLevel('debug');
      }).not.toThrow();

      expect(poisonLogger.level).toBe('debug');
      expect(nullProto.level).toBe('debug');
    });

    test('1.5 非法 level 参数（空串、布尔、数字、null、超大字符串、特殊字符）安全处理', () => {
      const initialLevel = mockApp.logger.level;

      // 无效输入不产生变更
      (configService as any).applyLogLevel('');
      expect(mockApp.logger.level).toBe(initialLevel);

      (configService as any).applyLogLevel(null);
      expect(mockApp.logger.level).toBe(initialLevel);

      (configService as any).applyLogLevel(undefined);
      expect(mockApp.logger.level).toBe(initialLevel);

      (configService as any).applyLogLevel(9999);
      expect(mockApp.logger.level).toBe(initialLevel);

      (configService as any).applyLogLevel(false);
      expect(mockApp.logger.level).toBe(initialLevel);

      // 特殊字符串能被容纳（例如标准 winston 兼容）
      configService.applyLogLevel('silly');
      expect(mockApp.logger.level).toBe('silly');

      configService.applyLogLevel('custom_level_#@!');
      expect(mockApp.logger.level).toBe('custom_level_#@!');
    });
  });

  describe('【对抗断言 2】LogConfigService.applySqlLogging(enabled) 高频震荡、状态对称与多数据源毒化隔离', () => {
    test('2.1 2000 次高频反复翻转震荡测试：断言 options.logging 与 silent 状态严格对称，绝不沦为布尔值 true', () => {
      const origFn = vi.fn();
      mockApp.db.sequelize.options.logging = origFn;
      mockApp.db.options.logging = origFn;

      for (let i = 0; i < 2000; i++) {
        const toggle = i % 2 === 0; // false, true, false, true...
        configService.applySqlLogging(toggle);

        const currentSeqLogging = mockApp.db.sequelize.options.logging;
        const currentDbLogging = mockApp.db.options.logging;
        const isSqlSilent = mockApp._sqlLogger.silent;
        const isTransportSilent = mockApp._sqlLogger.transports[0].silent;

        if (toggle) {
          // 开启时：必须为函数，绝不能是布尔值 true
          expect(typeof currentSeqLogging).toBe('function');
          expect(currentSeqLogging).not.toBe(true);
          expect(typeof currentDbLogging).toBe('function');
          expect(isSqlSilent).toBe(false);
          expect(isTransportSilent).toBe(false);
        } else {
          // 关闭时：必须为 false，绝不能为 true 或函数
          expect(currentSeqLogging).toBe(false);
          expect(currentDbLogging).toBe(false);
          expect(isSqlSilent).toBe(true);
          expect(isTransportSilent).toBe(true);
        }
      }
    });

    test('2.2 多数据源注入毒化 (Multi-DataSource Poisoning) 与异常隔离测试', () => {
      // 准备好 6 个损坏的畸变数据源与 2 个健康数据源
      const healthyFn1 = vi.fn();
      const healthyFn2 = vi.fn();

      const healthyDs1 = {
        collectionManager: {
          db: {
            sequelize: { options: { logging: healthyFn1 } },
            options: { logging: healthyFn1 },
          },
        },
      };

      const healthyDs2 = {
        collectionManager: {
          db: {
            sequelize: { options: { logging: healthyFn2 } },
            options: { logging: healthyFn2 },
          },
        },
      };

      // 毒化数据源集合
      const poisonedMap = new Map<string, any>([
        ['ds-healthy-1', healthyDs1],
        ['ds-null', null],
        ['ds-undefined', undefined],
        ['ds-no-cm', {}],
        ['ds-null-cm', { collectionManager: null }],
        ['ds-null-db', { collectionManager: { db: null } }],
        ['ds-null-seq', { collectionManager: { db: { sequelize: null } } }],
        ['ds-null-opts', { collectionManager: { db: { sequelize: { options: null } } } }],
        ['ds-healthy-2', healthyDs2],
      ]);

      mockApp.dataSourceManager.dataSources = poisonedMap;

      // 执行禁用
      expect(() => {
        configService.applySqlLogging(false);
      }).not.toThrow();

      // 断言健康数据源被正确联动禁用
      expect(healthyDs1.collectionManager.db.sequelize.options.logging).toBe(false);
      expect(healthyDs2.collectionManager.db.sequelize.options.logging).toBe(false);

      // 执行恢复
      expect(() => {
        configService.applySqlLogging(true);
      }).not.toThrow();

      // 断言健康数据源被正确恢复为函数，且不为 true
      expect(typeof healthyDs1.collectionManager.db.sequelize.options.logging).toBe('function');
      expect(healthyDs1.collectionManager.db.sequelize.options.logging).not.toBe(true);
      expect(typeof healthyDs2.collectionManager.db.sequelize.options.logging).toBe('function');
      expect(healthyDs2.collectionManager.db.sequelize.options.logging).not.toBe(true);
    });

    test('2.3 模拟数据源 options 抛出致命异常时的宿主保护隔离测试', () => {
      const explosiveDs = {
        collectionManager: {
          db: {
            sequelize: {
              get options() {
                throw new Error('Database connection exploded while inspecting options!');
              },
            },
          },
        },
      };

      mockApp.dataSourceManager.dataSources = new Map([['explosive', explosiveDs]]);

      // 验证外层 try/catch 兜底，绝不崩溃
      expect(() => {
        configService.applySqlLogging(false);
      }).not.toThrow();

      expect(() => {
        configService.applySqlLogging(true);
      }).not.toThrow();
    });

    test('2.4 createSqlLoggingCallback 极端畸变参数与 1MB 超大 SQL 压力注入', () => {
      // 清空原始回调强行触发 createSqlLoggingCallback
      mockApp.db.sequelize.options.logging = false;
      mockApp.db.options.logging = false;

      configService.applySqlLogging(true);
      const callback = mockApp.db.sequelize.options.logging;
      expect(typeof callback).toBe('function');

      // 1. 传入各种非字符串或畸形输入
      expect(() => {
        callback(null);
        callback(undefined);
        callback(12345);
        callback({ complex: 'object' });
        callback([1, 2, 3]);
      }).not.toThrow();

      // 2. 超大 1MB SQL 语句，包含大量连续空白符与换行
      const largeFragment = 'SELECT col FROM table WHERE x = 1 \r\n\t   ';
      const hugeSql = largeFragment.repeat(25000); // 约 1MB
      const startTime = performance.now();
      expect(() => {
        callback(hugeSql, 42);
      }).not.toThrow();
      const elapsed = performance.now() - startTime;
      expect(elapsed).toBeLessThan(500); // 500ms 内完成正则压缩与传递，验证无 ReDoS 灾难性回溯

      // 3. 巨量 INSERT INTO 自动截断至 2000 字符加省略号
      const hugeInsert = 'INSERT INTO very_large_table (data) VALUES (' + 'x'.repeat(100000) + ')';
      callback(hugeInsert, 88);
      const calls = mockApp._sqlLogger.debug.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.message.length).toBeLessThanOrEqual(2003);
      expect(lastCall.message.endsWith('...')).toBe(true);
      expect(lastCall.executeTime).toBe(88);
      expect(lastCall.app).toBe('adversarial-app');
      expect(lastCall.reqId).toBe('adv-req-999');
    });

    test('2.5 _sqlLogger 为 null 或 debug 方法不可用时的静默容错', () => {
      mockApp.db.sequelize.options.logging = false;
      mockApp._sqlLogger = null;
      mockApp.sqlLogger = null;

      configService.applySqlLogging(true);
      const callback = mockApp.db.sequelize.options.logging;
      expect(typeof callback).toBe('function');

      expect(() => {
        callback('SELECT 1', 1);
      }).not.toThrow();
    });
  });
});
