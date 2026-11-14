import { Application } from '@nocobase/server';
import { CONFIG_KEYS, DEFAULT_CONFIGS } from '../constants';

export class LogConfigService {
  private app: Application;
  private cache: Map<string, string> = new Map();
  private origSqlLogging?: any;

  constructor(app: Application) {
    this.app = app;
  }

  async init() {
    try {
      const repo = this.app.db.getRepository('logger_configs');
      if (!repo) return;

      const records = await repo.find();
      const existingKeys = new Set<string>();

      for (const rec of records) {
        this.cache.set(rec.key, rec.value);
        existingKeys.add(rec.key);
      }

      // 初始化默认配置
      const toCreate: Array<{ key: string; value: string; description: string }> = [];
      for (const [key, value] of Object.entries(DEFAULT_CONFIGS)) {
        if (!existingKeys.has(key)) {
          this.cache.set(key, value);
          toCreate.push({ key, value, description: `Default config for ${key}` });
        }
      }

      if (toCreate.length > 0) {
        await repo.createMany({ records: toCreate });
      }

      // 应用初始日志级别
      this.applyLogLevel(this.get(CONFIG_KEYS.LOGGER_LEVEL, 'info'));
      // 应用初始 SQL 日志联动
      this.applySqlLogging(this.getBoolean(CONFIG_KEYS.SQL_LOGGING, true));
    } catch (err: any) {
      if (err.message && (err.message.includes('no such table') || err.message.includes("doesn't exist"))) {
        return;
      }
      this.app.logger?.warn?.(`[LoggerPro] Failed to init log configs: ${err.message}`);
    }
  }

  get(key: string, defaultValue = ''): string {
    const val = this.cache.get(key);
    return val !== undefined && val !== null ? val : ((DEFAULT_CONFIGS as any)[key] ?? defaultValue);
  }

  getConfig(key?: string, defaultValue = ''): any {
    if (!key) {
      return this.getAll();
    }
    return this.get(key, defaultValue);
  }

  getBoolean(key: string, defaultValue = false): boolean {
    const defaultValStr = (DEFAULT_CONFIGS as any)[key] ?? (defaultValue ? 'true' : 'false');
    const val = this.get(key, defaultValStr);
    return val === 'true' || val === '1';
  }

  getNumber(key: string, defaultValue = 0): number {
    const defaultValNum = (DEFAULT_CONFIGS as any)[key] !== undefined ? Number((DEFAULT_CONFIGS as any)[key]) : defaultValue;
    const val = this.cache.get(key);
    if (val === undefined || val === null || val === '') return defaultValNum;
    const num = Number(val);
    return isNaN(num) ? defaultValNum : num;
  }

  getJson<T = any>(key: string, defaultValue: T = [] as any): T {
    try {
      const val = this.get(key);
      return val ? JSON.parse(val) : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  async set(key: string, value: string, description?: string) {
    this.cache.set(key, value);
    const repo = this.app.db.getRepository('logger_configs');
    if (repo) {
      const existing = await repo.findOne({ filter: { key } });
      if (existing) {
        await repo.update({ filterByTk: existing.id, values: { value, ...(description ? { description } : {}) } });
      } else {
        await repo.create({ values: { key, value, description: description || '' } });
      }
    }

    if (key === CONFIG_KEYS.LOGGER_LEVEL) {
      this.applyLogLevel(value);
    } else if (key === CONFIG_KEYS.SQL_LOGGING) {
      const enabled = value === 'true' || value === '1' || value === (true as any);
      this.applySqlLogging(enabled);
    }
  }

  async getAll(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, defVal] of Object.entries(DEFAULT_CONFIGS)) {
      result[key] = this.get(key, defVal);
    }
    return result;
  }

  async updateAll(values: Record<string, any>) {
    for (const [key, val] of Object.entries(values)) {
      const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
      await this.set(key, strVal);
    }
  }

  public applyLogLevel(level: string) {
    if (!level || typeof level !== 'string') return;
    const visited = new Set<any>();

    const safeUpdate = (loggerInstance: any, name: string) => {
      if (!loggerInstance) return;
      try {
        this.updateLoggerRecursively(loggerInstance, level, visited);
      } catch (err: any) {
        this.app.logger?.warn?.(`[LoggerPro] Failed to apply log level for ${name}: ${err?.message || err}`);
      }
    };

    // 1. 系统主 Logger 及别名（独立隔离）
    safeUpdate(this.app.logger, 'app.logger');
    safeUpdate((this.app as any)._logger, 'app._logger');
    safeUpdate((this.app as any).log, 'app.log');

    // 2. HTTP 请求日志 Logger（独立隔离）
    safeUpdate(this.app.requestLogger, 'app.requestLogger');

    // 3. SQL 日志 Logger（独立隔离）
    safeUpdate((this.app as any)._sqlLogger, 'app._sqlLogger');
    safeUpdate((this.app as any).sqlLogger, 'app.sqlLogger');
  }

  private updateLoggerRecursively(logger: any, level: string, visited: Set<any>) {
    if (!logger || (typeof logger !== 'object' && typeof logger !== 'function') || visited.has(logger)) {
      return;
    }
    visited.add(logger);

    // 设置自身 level
    try {
      if ('level' in logger) {
        logger.level = level;
      }
    } catch {}

    // 安全遍历 transports (防止 Winston 原型或代理 getter 抛错)
    let transports: any;
    try {
      transports = logger.transports;
    } catch {
      transports = undefined;
    }

    if (Array.isArray(transports)) {
      for (const transport of transports) {
        if (!transport || typeof transport !== 'object') continue;

        try {
          transport.level = level;
        } catch {}

        // 深度穿透 SystemLoggerTransport 的真实内部 Winston 实例
        try {
          if (transport.logger) {
            this.updateLoggerRecursively(transport.logger, level, visited);
          }
        } catch {}
        try {
          if (transport.errorLogger) {
            this.updateLoggerRecursively(transport.errorLogger, level, visited);
          }
        } catch {}
      }
    }

    // 穿透原型链 (child logger 代理原型)
    let proto: any = null;
    try {
      proto = Object.getPrototypeOf(logger);
    } catch {
      proto = null;
    }

    // 安全终止条件：
    // 1. 原型不存在
    // 2. 原型为根 Object.prototype 或 Function.prototype
    // 3. 原型为类/构造函数的 prototype 对象本身 (proto.constructor?.prototype === proto)
    // 4. 原型已被访问过
    if (
      proto &&
      proto !== Object.prototype &&
      proto !== Function.prototype &&
      !(proto.constructor && proto.constructor.prototype === proto) &&
      !visited.has(proto)
    ) {
      let hasRelevantProps = false;
      try {
        hasRelevantProps = 'transports' in proto || 'level' in proto;
      } catch {}

      if (hasRelevantProps) {
        this.updateLoggerRecursively(proto, level, visited);
      }
    }
  }

  public applySqlLogging(enabled: boolean) {
    try {
      // 1. 同步 _sqlLogger 与 sqlLogger 的 silent 状态
      const sqlLoggers = [(this.app as any)._sqlLogger, (this.app as any).sqlLogger].filter(Boolean);
      for (const sqlLogger of sqlLoggers) {
        sqlLogger.silent = !enabled;
        if (Array.isArray(sqlLogger.transports)) {
          for (const transport of sqlLogger.transports) {
            if (transport) {
              transport.silent = !enabled;
            }
          }
        }
      }

      // 2. 切换主库 Sequelize options.logging
      const db = this.app.db;
      const sequelize = db?.sequelize as any;
      if (sequelize?.options) {
        if (!enabled) {
          if (typeof sequelize.options.logging === 'function') {
            this.origSqlLogging = sequelize.options.logging;
          }
          sequelize.options.logging = false;
          if (db.options) {
            db.options.logging = false;
          }
        } else {
          const loggingFn = typeof this.origSqlLogging === 'function'
            ? this.origSqlLogging
            : this.createSqlLoggingCallback();
          sequelize.options.logging = loggingFn;
          if (db.options) {
            db.options.logging = loggingFn;
          }
        }
      }

      // 3. 同步其他已注册的数据源
      if ((this.app as any).dataSourceManager?.dataSources) {
        for (const [, ds] of (this.app as any).dataSourceManager.dataSources) {
          const dsDb = (ds as any)?.collectionManager?.db;
          const dsSequelize = dsDb?.sequelize as any;
          if (dsSequelize?.options) {
            if (!enabled) {
              dsSequelize.options.logging = false;
              if (dsDb.options) dsDb.options.logging = false;
            } else {
              const loggingFn = typeof this.origSqlLogging === 'function'
                ? this.origSqlLogging
                : this.createSqlLoggingCallback();
              dsSequelize.options.logging = loggingFn;
              if (dsDb.options) dsDb.options.logging = loggingFn;
            }
          }
        }
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] Failed to apply sql logging: ${err?.message || err}`);
    }
  }

  private createSqlLoggingCallback() {
    return (...args: any[]) => {
      let msg = args[0];
      if (typeof msg === 'string') {
        msg = msg.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (typeof msg === 'string' && msg.includes('INSERT INTO') && msg.length > 2000) {
        msg = msg.substring(0, 2000) + '...';
      }
      const content: any = {
        message: msg,
        app: this.app.name,
        reqId: (this.app as any).context?.reqId,
      };
      if (args[1] && typeof args[1] === 'number') {
        content.executeTime = args[1];
      }
      const sqlLogger = (this.app as any)._sqlLogger || (this.app as any).sqlLogger;
      if (sqlLogger && typeof sqlLogger.debug === 'function') {
        sqlLogger.debug(content);
      }
    };
  }
}
