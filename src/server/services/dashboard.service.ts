import { Application } from '@nocobase/server';
import { LogReaderService } from './log-reader.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export class DashboardService {
  private app: Application;
  private readerService: LogReaderService;
  private slowQueriesCache: any[] = [];

  constructor(app: Application, readerService: LogReaderService) {
    this.app = app;
    this.readerService = readerService;
  }

  recordSlowQuery(item: { sql: string; durationMs: number; time: Date; error?: string }) {
    this.slowQueriesCache.unshift(item);
    if (this.slowQueriesCache.length > 50) {
      this.slowQueriesCache.pop();
    }
  }

  /**
   * 单条聚合 SQL 取回今日 / 近 7 天计数与活跃榜 Top5，
   * 替代原先「今日 3 次 count + 7 天 14 次 count + 2 次 find(limit 1000)」的写法。
   */
  private async aggregateAuditStats(startOfToday: Date, weekStart: Date, dialect: string, dayCount = 7) {
    const sequelize = this.app.db.sequelize;
    const repo = this.app.db.getRepository('logger_audit_logs');
    const tableName = (repo?.collection as any)?.model?.tableName || 'logger_audit_logs';
    // 表名来自 collection 定义（非用户输入），校验标识符后再插值
    if (!sequelize || !/^[A-Za-z0-9_$]+$/.test(tableName)) return null;

    const q = (name: string) => (dialect === 'mysql' || dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`);
    const inToday = `${q('createdAt')} >= :start AND ${q('createdAt')} < :end`;
    try {
      const [rows]: any = await sequelize.query(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN ${inToday} THEN 1 ELSE 0 END) AS todayTotal,
           SUM(CASE WHEN ${inToday} AND ${q('statusCode')} >= 400 THEN 1 ELSE 0 END) AS todayErrors
         FROM ${q(tableName)}`,
        {
          replacements: {
            start: startOfToday.toISOString(),
            end: new Date(startOfToday.getTime() + DAY_MS).toISOString(),
            weekStart: weekStart.toISOString(),
          },
        },
      );

      const [trendRows]: any = await sequelize.query(
        `SELECT ${q('createdAt')} AS t, ${q('statusCode')} AS s FROM ${q(tableName)}
         WHERE ${q('createdAt')} >= :weekStart ORDER BY ${q('createdAt')} ASC`,
        { replacements: { weekStart: weekStart.toISOString() } },
      );

      const [userRows]: any = await sequelize.query(
        `SELECT ${q('userUsername')} AS name, COUNT(*) AS c FROM ${q(tableName)}
         WHERE ${q('createdAt')} >= :weekStart AND ${q('userUsername')} IS NOT NULL
         GROUP BY ${q('userUsername')} ORDER BY c DESC LIMIT 5`,
        { replacements: { weekStart: weekStart.toISOString() } },
      );

      const [collectionRows]: any = await sequelize.query(
        `SELECT ${q('collectionName')} AS name, COUNT(*) AS c FROM ${q(tableName)}
         WHERE ${q('createdAt')} >= :weekStart AND ${q('collectionName')} IS NOT NULL AND ${q('collectionName')} <> ''
         GROUP BY ${q('collectionName')} ORDER BY c DESC LIMIT 5`,
        { replacements: { weekStart: weekStart.toISOString() } },
      );

      const head = (rows && rows[0]) || {};
      return {
        total: Number(head.total || 0),
        todayTotal: Number(head.todayTotal || 0),
        todayErrors: Number(head.todayErrors || 0),
        trendRows: (trendRows || []) as Array<{ t: string | Date; s: number }>,
        userRows: (userRows || []) as Array<{ name: any; c: any }>,
        collectionRows: (collectionRows || []) as Array<{ name: any; c: any }>,
        dayCount,
      };
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] Dashboard aggregate failed, falling back to ORM: ${err.message}`);
      return null;
    }
  }

  async getOverview() {
    const auditRepo = this.app.db.getRepository('logger_audit_logs');
    const alertRepo = this.app.db.getRepository('logger_alert_logs');

    // 1. 获取日志文件列表与总大小
    const files = await this.readerService.listFiles();
    const totalSizeBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);

    // 2. 时间窗口
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekStart = new Date(startOfToday.getTime() - 6 * DAY_MS);
    const dialect = this.app.db.sequelize?.getDialect?.() || 'sqlite';

    let todayAuditCount = 0;
    let todayErrorCount = 0;
    let todayAlertCount = 0;
    let totalAuditCount = 0;
    const trendDays: { date: string; requests: number; errors: number; audits: number }[] = [];
    let topUsers: { username: string; count: number }[] = [];
    let topCollections: { collection: string; count: number }[] = [];

    const agg = auditRepo ? await this.aggregateAuditStats(startOfToday, weekStart, dialect) : null;

    if (agg) {
      totalAuditCount = agg.total;
      todayAuditCount = agg.todayTotal;
      todayErrorCount = agg.todayErrors;

      // 按自然日归桶：请求数 + 4xx/5xx 错误数
      const buckets = new Map<number, { requests: number; errors: number }>();
      for (let i = 6; i >= 0; i--) {
        buckets.set(startOfToday.getTime() - i * DAY_MS, { requests: 0, errors: 0 });
      }
      for (const row of agg.trendRows) {
        const ts = new Date(row.t).getTime();
        if (!Number.isFinite(ts)) continue;
        const dayStart = new Date(ts);
        dayStart.setHours(0, 0, 0, 0);
        const bucket = buckets.get(dayStart.getTime());
        if (!bucket) continue;
        bucket.requests++;
        if (Number(row.s) >= 400) bucket.errors++;
      }
      for (const [dayTs, stat] of buckets.entries()) {
        const d = new Date(dayTs);
        trendDays.push({
          date: `${d.getMonth() + 1}/${d.getDate()}`,
          requests: stat.requests,
          errors: stat.errors,
          audits: stat.requests,
        });
      }

      topUsers = agg.userRows.map((r) => ({ username: String(r.name), count: Number(r.c) || 0 }));
      topCollections = agg.collectionRows.map((r) => ({ collection: String(r.name), count: Number(r.c) || 0 }));
    } else if (auditRepo) {
      // ORM 兜底（聚合 SQL 方言不兼容时）
      totalAuditCount = await auditRepo.count();
      const todayFilter = { createdAt: { $gte: startOfToday } };
      todayAuditCount = await auditRepo.count({ filter: todayFilter });
      todayErrorCount = await auditRepo.count({ filter: { ...todayFilter, statusCode: { $gte: 400 } } });

      for (let i = 6; i >= 0; i--) {
        const dayStart = new Date(startOfToday.getTime() - i * DAY_MS);
        const dayEnd = new Date(dayStart.getTime() + DAY_MS);
        const dateStr = `${dayStart.getMonth() + 1}/${dayStart.getDate()}`;
        const [dayAudits, dayErrors] = await Promise.all([
          auditRepo.count({ filter: { createdAt: { $gte: dayStart, $lt: dayEnd } } }),
          auditRepo.count({ filter: { createdAt: { $gte: dayStart, $lt: dayEnd }, statusCode: { $gte: 400 } } }),
        ]);
        trendDays.push({ date: dateStr, requests: dayAudits, errors: dayErrors, audits: dayAudits });
      }
    }

    if (alertRepo) {
      try {
        todayAlertCount = await alertRepo.count({ filter: { createdAt: { $gte: startOfToday } } });
      } catch {}
    }

    // 3. 日志分类占比
    const categoryMap: Record<string, number> = {};
    for (const file of files) {
      categoryMap[file.category] = (categoryMap[file.category] || 0) + file.sizeBytes;
    }

    const categoryStats = Object.entries(categoryMap).map(([name, value]) => ({
      name,
      value,
      formatted: (value / (1024 * 1024)).toFixed(2) + ' MB',
    }));

    return {
      summary: {
        totalLogFiles: files.length,
        totalDiskBytes: totalSizeBytes,
        totalDiskFormatted: (totalSizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
        todayAuditCount,
        todayErrorCount,
        todayAlertCount,
        totalAuditCount,
      },
      trend: trendDays,
      categoryStats,
      topSlowQueries: this.slowQueriesCache.slice(0, 10),
      topUsers,
      topCollections,
    };
  }
}
