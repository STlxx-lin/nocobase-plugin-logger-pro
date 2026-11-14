import { Application } from '@nocobase/server';
import { LogConfigService } from '../services/log-config.service';
import { AlertService } from '../services/alert.service';
import { DashboardService } from '../services/dashboard.service';
import { CONFIG_KEYS, ALERT_RULE_TYPES } from '../constants';

// 本插件自身的表读写属于"监控反射"：纳入统计会自我放大（审计写库 -> 慢查询 -> 告警 -> 告警写库）
const INTERNAL_TABLE_PATTERN = /logger_configs|logger_audit_logs|logger_alert_logs|logger_alert_rules|logger_ai_records/i;

// 为 options 对象做完成标记，防止同一对象因多次 afterQuery（如批量流程）被重复计时
const QUERY_TIMED_FLAG = Symbol('loggerProQueryTimed');

function extractSqlText(options: any, query: any): string {
  if (typeof options?.sql === 'string' && options.sql) return options.sql;
  if (typeof query?.sql === 'string' && query.sql) return query.sql;
  if (typeof query?.query === 'string' && query.query) return query.query;
  if (typeof query === 'string' && query) return query;
  if (typeof options?.query === 'string' && options.query) return options.query;
  if (typeof options?.originalQuery === 'string' && options.originalQuery) return options.originalQuery;
  if (typeof options?.raw === 'string' && options.raw) return options.raw;
  if (options?.type && options?.model?.name) return `${options.type} FROM ${options.model.name}`;
  return 'SQL Query';
}

export function setupSlowQueryMonitor(
  app: Application,
  configService: LogConfigService,
  alertService: AlertService,
  dashboardService: DashboardService,
) {
  try {
    const sequelize = app.db?.sequelize;
    if (!sequelize) return;

    const queryStartTimes = new WeakMap<object, number>();

    sequelize.addHook('beforeQuery', (options: any) => {
      if (options && typeof options === 'object') {
        queryStartTimes.set(options, Date.now());
      }
    });

    sequelize.addHook('afterQuery', (options: any, query: any) => {
      if (!options || typeof options !== 'object') return;
      if ((options as any)[QUERY_TIMED_FLAG]) return;

      const startTime = queryStartTimes.get(options);
      if (!startTime) return;
      queryStartTimes.delete(options);
      (options as any)[QUERY_TIMED_FLAG] = true;

      // 先读开关再算耗时口径，关闭时零额外开销
      const isSlowQueryEnabled = configService.getBoolean(CONFIG_KEYS.SLOW_QUERY_ENABLED, true);
      if (!isSlowQueryEnabled) return;

      const durationMs = Date.now() - startTime;
      const threshold = configService.getNumber(CONFIG_KEYS.SLOW_QUERY_THRESHOLD_MS, 500);
      if (durationMs < threshold) return;

      const sqlText = extractSqlText(options, query);
      if (INTERNAL_TABLE_PATTERN.test(sqlText)) {
        return;
      }

      dashboardService.recordSlowQuery({
        sql: sqlText,
        durationMs,
        time: new Date(),
      });

      // 触发慢查询告警
      alertService.checkAndTrigger(ALERT_RULE_TYPES.SLOW_SQL, {
        title: `[慢 SQL 告警] 执行耗时 ${durationMs}ms 超过阈值 (${threshold}ms)`,
        message: `执行 SQL 耗时达 ${durationMs}ms`,
        sql: sqlText,
        durationMs,
      });
    });
  } catch (err) {
    app.logger?.warn?.(`[LoggerPro] Failed to setup slow query monitor: ${err.message}`);
  }
}
