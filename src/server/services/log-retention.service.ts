import { Application } from '@nocobase/server';
import { getLoggerFilePath } from '@nocobase/logger';
import { LogConfigService } from './log-config.service';
import { CONFIG_KEYS } from '../constants';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import stream from 'stream';
import zlib from 'zlib';
import { CronJob } from 'cron';

let tarFsInstance: any = null;
function getTarFs() {
  if (!tarFsInstance) {
    try {
      tarFsInstance = require('tar-fs');
    } catch (e) {
      try {
        const localPath = path.resolve(__dirname, '../../../dist/node_modules/tar-fs');
        if (fs.existsSync(localPath)) {
          tarFsInstance = require(localPath);
        }
      } catch (err) {}
    }
  }
  return tarFsInstance;
}

// 清理接口（cleanTableData/cleanBatch/getCleanTotalCount）允许操作的数据表白名单：
// 仅限本插件自身的 logger_* 数据表，防止持有插件权限的角色清空任意业务表
const CLEANABLE_COLLECTIONS = new Set([
  'logger_audit_logs',
  'logger_alert_logs',
  'logger_ai_records',
  'logger_alert_rules',
  'logger_configs',
]);

/**
 * 严格判断是否为 Winston / FileStreamRotator 内部状态文件或系统临时文件
 * 绝对禁止被当作过期日志删除、截断或归档打包
 */
export function isAuditOrSystemFile(fileName: string): boolean {
  if (!fileName || typeof fileName !== 'string') return true;
  const base = path.basename(fileName).toLowerCase();

  // 1. winston-daily-rotate-file 隐藏哈希审计文件: .<hash>-audit.json
  // 2. 默认审计文件: .audit.json, audit.json
  // 3. 具名审计文件: <name>-audit.json, <name>.audit.json
  if (
    base === '.audit.json' ||
    base === 'audit.json' ||
    base.endsWith('-audit.json') ||
    base.endsWith('.audit.json') ||
    /^\.[a-f0-9]+-audit\.json$/i.test(base) ||
    /\.?([a-f0-9]+-)?audit\.json$/i.test(base)
  ) {
    return true;
  }

  // 排除常见操作系统与临时锁文件
  if (base === '.ds_store' || base === 'thumbs.db' || base.endsWith('.tmp') || base.endsWith('.lock')) {
    return true;
  }

  return false;
}

/**
 * 判断是否为允许清理和配额管理的日志文件
 */
export function isCleanableLogFile(fileName: string): boolean {
  if (isAuditOrSystemFile(fileName)) return false;
  const base = path.basename(fileName).toLowerCase();
  return base.endsWith('.log') || base.endsWith('.txt') || base.endsWith('.gz');
}

/**
 * 统一跨方言解析 Sequelize query(DELETE/UPDATE) 返回的受影响行数
 * 解决 PostgreSQL 下返回 [[], { rowCount }] 导致 Number({ rowCount }) 产生 NaN 的缺陷
 */
export function parseAffectedRows(queryResult: any): number {
  if (!queryResult) return 0;
  const [results, metadata] = Array.isArray(queryResult) ? queryResult : [queryResult, null];

  if (typeof metadata === 'number') return metadata;
  if (metadata && typeof metadata.rowCount === 'number') return metadata.rowCount;
  if (metadata && typeof metadata.affectedRows === 'number') return metadata.affectedRows;

  if (typeof results === 'number') return results;
  if (results && typeof results.affectedRows === 'number') return results.affectedRows;
  if (results && typeof results.rowCount === 'number') return results.rowCount;

  return 0;
}

export class LogRetentionService {
  private app: Application;
  private configService: LogConfigService;
  private cronJob: CronJob | null = null;

  constructor(app: Application, configService: LogConfigService) {
    this.app = app;
    this.configService = configService;
  }

  getLogBasePath(): string {
    return getLoggerFilePath(this.app.name || 'main');
  }

  /**
   * 解析白名单集合的真实表名：仅接受已注册集合，且表名通过标识符校验后才允许进入原生 SQL
   */
  private resolveTableName(collectionName: string): string | null {
    if (!CLEANABLE_COLLECTIONS.has(collectionName)) return null;
    const collection = this.app.db.getCollection(collectionName);
    if (!collection) return null;
    const tableName = (collection as any)?.model?.tableName || collectionName;
    return /^[A-Za-z0-9_$]+$/.test(tableName) ? tableName : null;
  }

  startScheduler() {
    this.stopScheduler();

    const enabled = this.configService.getBoolean(CONFIG_KEYS.AUTO_CLEAN_ENABLED, true);
    if (!enabled) return;

    const cronExp = this.configService.get(CONFIG_KEYS.AUTO_CLEAN_CRON, '0 2 * * *');

    try {
      // 第三个参数 true = 立即 start()（CronJob 默认不自动启动；配合上方循环避免每次保存配置都叠加调度）
      this.cronJob = new CronJob(cronExp, async () => {
        this.app.logger?.info?.('[LoggerPro] Auto clean log task started...');
        try {
          const result = await this.cleanLogs();
          this.app.logger?.info?.(
            `[LoggerPro] Auto clean log completed: deleted ${result.deletedCount} files (freed ${result.freedFormatted}), cleaned ${result.dbDeletedCount || 0} expired DB audit rows`,
          );
        } catch (err: any) {
          this.app.logger?.error?.(`[LoggerPro] Auto clean log failed: ${err.message}`);
        }
      }, null, true);
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] Failed to start log retention cron job: ${err.message}`);
    }
  }

  stopScheduler() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * 自动清理过期日志文件与数据库历史审计记录
   */
  async cleanLogs(): Promise<{
    deletedCount: number;
    freedBytes: number;
    freedFormatted: string;
    dbDeletedCount: number;
    details: string[];
  }> {
    const basePath = this.getLogBasePath();
    const retentionDays = this.configService.getNumber(CONFIG_KEYS.RETENTION_DAYS, 15);
    const maxDiskMb = this.configService.getNumber(CONFIG_KEYS.MAX_DISK_SIZE_MB, 2048);
    const maxDiskBytes = maxDiskMb * 1024 * 1024;

    const now = Date.now();
    const expireMs = retentionDays * 24 * 60 * 60 * 1000;

    let deletedCount = 0;
    let freedBytes = 0;
    const details: string[] = [];

    // 1. 扫描所有日志文件
    const fileList: { fullPath: string; relName: string; size: number; mtimeMs: number }[] = [];

    const scan = async (dir: string, rel = '') => {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relName = rel ? path.join(rel, entry.name) : entry.name;
          if (entry.isDirectory()) {
            await scan(fullPath, relName);
          } else if (entry.isFile()) {
            if (isAuditOrSystemFile(entry.name) || !isCleanableLogFile(entry.name)) {
              continue;
            }
            const stat = await fsp.stat(fullPath);
            fileList.push({ fullPath, relName, size: stat.size, mtimeMs: stat.mtimeMs });
          }
        }
      } catch (err: any) {
        this.app.logger?.warn?.(`[LoggerPro] Clean scan error: ${err.message}`);
      }
    };

    await scan(basePath);

    // 2. 按过期天数清理日志文件
    const remainingFiles: typeof fileList = [];
    for (const file of fileList) {
      const ageMs = now - file.mtimeMs;
      if (retentionDays > 0 && ageMs > expireMs) {
        try {
          await fsp.unlink(file.fullPath);
          deletedCount++;
          freedBytes += file.size;
          details.push(`Expired Log File: ${file.relName} (${(file.size / 1024).toFixed(1)} KB)`);
        } catch (err: any) {
          if (err.code === 'EBUSY' || err.code === 'EPERM') {
            await fsp.truncate(file.fullPath, 0);
            deletedCount++;
            freedBytes += file.size;
            details.push(`Expired Log File (Truncated): ${file.relName}`);
          } else {
            this.app.logger?.warn?.(`[LoggerPro] Failed to delete expired file ${file.relName}: ${err.message}`);
          }
        }
      } else {
        remainingFiles.push(file);
      }
    }

    // 3. 检查总磁盘容量限制
    let currentTotalSize = remainingFiles.reduce((acc, f) => acc + f.size, 0);
    if (maxDiskBytes > 0 && currentTotalSize > maxDiskBytes) {
      remainingFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

      for (const file of remainingFiles) {
        if (currentTotalSize <= maxDiskBytes) break;
        try {
          await fsp.unlink(file.fullPath);
          deletedCount++;
          freedBytes += file.size;
          currentTotalSize -= file.size;
          details.push(`Over-quota Log File: ${file.relName} (${(file.size / 1024).toFixed(1)} KB)`);
        } catch (err: any) {
          if (err.code === 'EBUSY' || err.code === 'EPERM') {
            await fsp.truncate(file.fullPath, 0);
            deletedCount++;
            freedBytes += file.size;
            currentTotalSize -= file.size;
            details.push(`Over-quota Log File (Truncated): ${file.relName}`);
          } else {
            this.app.logger?.warn?.(`[LoggerPro] Failed to delete quota exceeded file ${file.relName}: ${err.message}`);
          }
        }
      }
    }

    // 4. 清理数据库中的过期审计与诊断记录
    let dbDeletedCount = 0;
    try {
      const dbCleanResult = await this.cleanDatabaseLogs(retentionDays, 50000);
      dbDeletedCount = dbCleanResult.totalDeleted;
      if (dbDeletedCount > 0) {
        details.push(...dbCleanResult.details);
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] Clean DB audit logs error: ${err.message}`);
    }

    return {
      deletedCount,
      freedBytes,
      freedFormatted: this.formatBytes(freedBytes),
      dbDeletedCount,
      details,
    };
  }

  /**
   * 物理清理数据库中的过期审计记录，并执行最大行数熔断限制（纯数据原生 SQL，绝不触发重启与变量溢出）
   */
  async cleanDatabaseLogs(
    retentionDays = 15,
    maxAuditRows = 50000,
  ): Promise<{ totalDeleted: number; details: string[] }> {
    let totalDeleted = 0;
    const details: string[] = [];
    const days = Math.max(Number(retentionDays) || 0, 0);
    const expireIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const dialect = this.app.db.sequelize?.getDialect?.() || 'sqlite';
    const rowLimit = Math.max(Number(maxAuditRows) || 0, 0);

    // 1. 清理 logger_audit_logs 过期记录（时间条件走参数绑定，不做字符串拼接）
    try {
      const auditRepo = this.app.db.getRepository('logger_audit_logs');
      const tableName = this.resolveTableName('logger_audit_logs');
      if (auditRepo && tableName) {
        const q = (name: string) => (dialect === 'mysql' || dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`);

        const queryResult: any = await this.app.db.sequelize.query(
          `DELETE FROM ${q(tableName)} WHERE ${q('createdAt')} < :expireIso`,
          { replacements: { expireIso } },
        );
        const deletedFromExpire = parseAffectedRows(queryResult);
        if (deletedFromExpire > 0) {
          totalDeleted += deletedFromExpire;
          details.push(`清理过期操作审计记录: ${deletedFromExpire} 条 (< ${days} 天)`);
        }

        // 容量熔断保护：仅在配置了上限时生效
        if (rowLimit > 0) {
          const [countRows]: any = await this.app.db.sequelize.query(
            `SELECT COUNT(*) AS total FROM ${q(tableName)}`,
          );
          const afterCount = Number(countRows?.[0]?.total ?? countRows?.[0]?.count ?? 0);
          const excess = afterCount - rowLimit;
          if (excess > 0) {
            if (dialect === 'mysql' || dialect === 'mariadb') {
              await this.app.db.sequelize.query(
                `DELETE FROM ${q(tableName)} ORDER BY ${q('createdAt')} ASC LIMIT ${Math.floor(excess)}`,
              );
            } else {
              await this.app.db.sequelize.query(
                `DELETE FROM ${q(tableName)} WHERE ${q('id')} IN (SELECT ${q('id')} FROM ${q(tableName)} ORDER BY ${q('createdAt')} ASC LIMIT ${Math.floor(excess)})`,
              );
            }
            totalDeleted += excess;
            details.push(`容量熔断淘汰超额审计记录: ${excess} 条 (保持单表不超过 ${rowLimit} 条)`);
          }
        }
      }
    } catch (e: any) {
      this.app.logger?.warn?.(`[LoggerPro] Clean logger_audit_logs error: ${e.message}`);
    }

    // 2. 清理 logger_alert_logs 与 logger_ai_records 过期记录
    for (const collection of ['logger_alert_logs', 'logger_ai_records']) {
      try {
        const repo = this.app.db.getRepository(collection);
        const tableName = this.resolveTableName(collection);
        if (!repo || !tableName) continue;
        const q = (name: string) => (dialect === 'mysql' || dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`);
        await this.app.db.sequelize.query(`DELETE FROM ${q(tableName)} WHERE ${q('createdAt')} < :expireIso`, {
          replacements: { expireIso },
        });
      } catch (e: any) {
        this.app.logger?.warn?.(`[LoggerPro] Clean ${collection} error: ${e.message}`);
      }
    }

    return { totalDeleted, details };
  }

  /**
   * 按指定天数一键清理过期审计记录
   */
  async cleanExpiredAuditLogs(days: number) {
    const targetDays = Math.max(days || 15, 1);
    const result = await this.cleanDatabaseLogs(targetDays, 50000);
    return {
      success: true,
      deletedCount: result.totalDeleted,
      message: `成功清理 ${targetDays} 天前的历史审计与诊断数据共 ${result.totalDeleted} 条`,
      details: result.details,
    };
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /**
   * 校验待归档文件是否安全：必须严格位于日志根目录内（含路径分隔符边界），
   * 仅允许 .log/.txt 日志文本文件，并通过 realpath 防止符号链接逃逸。
   * 返回归档用的相对路径，非法或不存在时返回 null。
   */
  private async resolveSafeArchiveEntry(basePath: string, fileName: string): Promise<string | null> {
    if (typeof fileName !== 'string' || !fileName.trim()) {
      return null;
    }
    let normalizedName = fileName.trim();
    try {
      normalizedName = decodeURIComponent(normalizedName);
    } catch {}
    normalizedName = normalizedName.replace(/^[\\/]+/, '');
    if (!normalizedName) {
      return null;
    }
    const resolved = path.resolve(basePath, normalizedName);
    // 词法边界：防止 "x/../../secret" 类嵌入式穿越；带分隔符比较防止兄弟目录前缀绕过
    if (resolved === basePath || !resolved.startsWith(basePath + path.sep)) {
      return null;
    }
    if (isAuditOrSystemFile(resolved) || !/\.(log|txt)$/i.test(resolved)) {
      return null;
    }
    try {
      // 真实路径边界：防止日志目录内的符号链接指向外部文件
      const [realEntry, realBase] = await Promise.all([fsp.realpath(resolved), fsp.realpath(basePath)]);
      if (realEntry !== realBase && !realEntry.startsWith(realBase + path.sep)) {
        return null;
      }
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) {
        return null;
      }
    } catch {
      return null;
    }
    return path.relative(basePath, resolved).replace(/\\/g, '/');
  }

  async createArchiveStream(fileNames?: string[]): Promise<stream.Readable> {
    const basePath = this.getLogBasePath();
    let entries: string[] = [];

    if (fileNames && fileNames.length > 0) {
      const validated: string[] = [];
      for (const f of fileNames) {
        const entry = await this.resolveSafeArchiveEntry(basePath, f);
        if (entry) {
          validated.push(entry);
        } else {
          this.app.logger?.warn?.(`[LoggerPro] Skipped illegal or missing log file for archive: ${f}`);
        }
      }
      if (validated.length === 0) {
        throw new Error('No valid log files available for archive.');
      }
      entries = validated;
    } else {
      const allFiles: string[] = [];
      const scan = async (dir: string, rel = '') => {
        const list = await fsp.readdir(dir, { withFileTypes: true });
        for (const item of list) {
          const relName = rel ? path.join(rel, item.name) : item.name;
          if (item.isDirectory()) {
            await scan(path.join(dir, item.name), relName);
          } else if (item.isFile() && !isAuditOrSystemFile(item.name) && (item.name.endsWith('.log') || item.name.endsWith('.txt'))) {
            allFiles.push(relName.replace(/\\/g, '/'));
          }
        }
      };
      await scan(basePath);
      entries = allFiles;
    }

    if (entries.length === 0) {
      throw new Error('No log files available for archive.');
    }

    const passthrough = new stream.PassThrough();
    const gz = zlib.createGzip();

    const tarFs = getTarFs();
    if (!tarFs || !tarFs.pack) {
      throw new Error('tar-fs module is not available in the current environment.');
    }

    const tarPack = tarFs.pack(basePath, {
      entries,
    });

    tarPack.on('error', (err) => {
      gz.emit('error', err);
    });
    gz.on('error', (err) => {
      passthrough.emit('error', err);
    });

    // 下游连接断开或关闭时，向上游广播销毁，释放文件描述符
    passthrough.on('close', () => {
      try {
        if (!gz.destroyed) gz.destroy();
        if (tarPack && !tarPack.destroyed) (tarPack as any).destroy?.();
      } catch {}
    });

    tarPack.pipe(gz).pipe(passthrough);

    return passthrough;
  }

  // 统计本插件的所有数据与存储占用 (日志文件 + 数据库表)
  async getPluginStorageStats() {
    const basePath = this.getLogBasePath();
    const retentionDays = this.configService.getNumber(CONFIG_KEYS.RETENTION_DAYS, 15);

    // 1. 日志文件占用统计
    let totalFiles = 0;
    let totalFileBytes = 0;
    const catStats = {
      requestLogs: { count: 0, sizeBytes: 0, formatted: '0 B' },
      systemLogs: { count: 0, sizeBytes: 0, formatted: '0 B' },
      sqlLogs: { count: 0, sizeBytes: 0, formatted: '0 B' },
      otherLogs: { count: 0, sizeBytes: 0, formatted: '0 B' },
    };

    const scanFiles = async (dir: string) => {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanFiles(fullPath);
          } else if (entry.isFile()) {
            if (isAuditOrSystemFile(entry.name) || !isCleanableLogFile(entry.name)) {
              continue;
            }
            const stat = await fsp.stat(fullPath);
            totalFiles++;
            totalFileBytes += stat.size;

            const name = entry.name.toLowerCase();
            if (name.startsWith('request')) {
              catStats.requestLogs.count++;
              catStats.requestLogs.sizeBytes += stat.size;
            } else if (name.startsWith('system')) {
              catStats.systemLogs.count++;
              catStats.systemLogs.sizeBytes += stat.size;
            } else if (name.startsWith('sql')) {
              catStats.sqlLogs.count++;
              catStats.sqlLogs.sizeBytes += stat.size;
            } else {
              catStats.otherLogs.count++;
              catStats.otherLogs.sizeBytes += stat.size;
            }
          }
        }
      } catch {}
    };

    await scanFiles(basePath);

    catStats.requestLogs.formatted = this.formatBytes(catStats.requestLogs.sizeBytes);
    catStats.systemLogs.formatted = this.formatBytes(catStats.systemLogs.sizeBytes);
    catStats.sqlLogs.formatted = this.formatBytes(catStats.sqlLogs.sizeBytes);
    catStats.otherLogs.formatted = this.formatBytes(catStats.otherLogs.sizeBytes);

    // 2. 数据库数据表占用统计（精简后单行预估仅约 200~300 字节）
    const tableDefinitions = [
      { collection: 'logger_audit_logs', title: '全链路操作审计记录', avgBytesPerRow: 250 },
      { collection: 'logger_ai_records', title: 'AI 错误日志诊断记录', avgBytesPerRow: 1200 },
      { collection: 'logger_alert_logs', title: '告警通知发送记录', avgBytesPerRow: 350 },
      { collection: 'logger_alert_rules', title: '智能告警规则', avgBytesPerRow: 300 },
      { collection: 'logger_configs', title: '日志系统配置', avgBytesPerRow: 200 },
    ];

    let totalDbRows = 0;
    let totalDbBytes = 0;
    const tablesResult: Array<{
      collection: string;
      title: string;
      count: number;
      estimatedSizeBytes: number;
      estimatedFormatted: string;
    }> = [];

    for (const def of tableDefinitions) {
      let count = 0;
      try {
        const repo = this.app.db.getRepository(def.collection);
        if (repo) {
          count = await repo.count();
        }
      } catch {}

      const estBytes = count * def.avgBytesPerRow;
      totalDbRows += count;
      totalDbBytes += estBytes;

      tablesResult.push({
        collection: def.collection,
        title: def.title,
        count,
        estimatedSizeBytes: estBytes,
        estimatedFormatted: this.formatBytes(estBytes),
      });
    }

    const totalSizeBytes = totalFileBytes + totalDbBytes;

    return {
      fileStats: {
        totalFiles,
        totalSizeBytes: totalFileBytes,
        totalSizeFormatted: this.formatBytes(totalFileBytes),
        categories: catStats,
      },
      dbStats: {
        totalRows: totalDbRows,
        estimatedSizeBytes: totalDbBytes,
        estimatedSizeFormatted: this.formatBytes(totalDbBytes),
        tables: tablesResult,
      },
      totalSizeBytes,
      totalSizeFormatted: this.formatBytes(totalSizeBytes),
      retentionDays,
    };
  }

  // 清空指定表数据以释放空间（纯数据原生清理，绝不触发 Schema 重建与服务重启）
  async cleanTableData(collectionName: string) {
    if (!collectionName || typeof collectionName !== 'string') {
      throw new Error('collectionName is required');
    }
    const tableName = this.resolveTableName(collectionName);
    if (!tableName) {
      throw new Error(`Collection ${collectionName} is not allowed to be cleaned`);
    }
    const repo = this.app.db.getRepository(collectionName);
    const dialect = this.app.db.sequelize?.getDialect?.() || 'sqlite';

    try {
      if (dialect === 'mysql' || dialect === 'mariadb') {
        await this.app.db.sequelize.query(`TRUNCATE TABLE \`${tableName}\`;`);
      } else if (dialect === 'postgres') {
        await this.app.db.sequelize.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY;`);
      } else {
        // SQLite 及其他：纯数据 DELETE，0.01 秒完成，保留表结构，绝不触发 Schema Sync 与看门狗重启
        await this.app.db.sequelize.query(`DELETE FROM "${tableName}";`);
      }
    } catch {
      // 兜底降级
      if (repo) {
        await repo.destroy({ filter: {} });
      }
    }

    return { success: true, message: `已成功清空数据表 ${collectionName}` };
  }

  /**
   * 获取待清理的数据总量（原生 SQL 精准计数，时间条件参数绑定）
   */
  async getCleanTotalCount(collectionName = 'logger_audit_logs', days?: number): Promise<{ totalCount: number }> {
    const tableName = this.resolveTableName(collectionName);
    if (!tableName) {
      return { totalCount: 0 };
    }
    const repo = this.app.db.getRepository(collectionName);
    const dialect = this.app.db.sequelize?.getDialect?.() || 'sqlite';
    const isExpireMode = typeof days === 'number' && !isNaN(days) && days > 0;
    const q = (name: string) => (dialect === 'mysql' || dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`);

    try {
      const sql = isExpireMode
        ? `SELECT COUNT(*) AS total FROM ${q(tableName)} WHERE ${q('createdAt')} < :expireIso`
        : `SELECT COUNT(*) AS total FROM ${q(tableName)}`;
      const [results]: any = await this.app.db.sequelize.query(
        sql,
        isExpireMode
          ? { replacements: { expireIso: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() } }
          : undefined,
      );
      const total = Number(results?.[0]?.total ?? results?.[0]?.count ?? 0);
      return { totalCount: total };
    } catch {
      if (repo) {
        try {
          if (isExpireMode) {
            const expireDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            const total = await repo.count({ filter: { createdAt: { $lt: expireDate } } });
            return { totalCount: total };
          }
          const total = await repo.count();
          return { totalCount: total };
        } catch {
          return { totalCount: 0 };
        }
      }
      return { totalCount: 0 };
    }
  }

  /**
   * 分批极速清理数据（返回本批删除状态与剩余总量，供前端推进进度条）
   */
  async cleanBatch(
    collectionName = 'logger_audit_logs',
    days?: number,
    limit = 20000,
  ): Promise<{ remainingCount: number }> {
    const tableName = this.resolveTableName(collectionName);
    if (!tableName) {
      throw new Error(`Collection ${collectionName} is not allowed to be cleaned`);
    }
    const repo = this.app.db.getRepository(collectionName);
    const dialect = this.app.db.sequelize?.getDialect?.() || 'sqlite';
    // 批量上限夹紧，避免超大 LIMIT 一次锁表过久
    const batchLimit = Math.min(Math.max(Number(limit) || 20000, 1000), 50000);
    const q = (name: string) => (dialect === 'mysql' || dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`);

    const isExpireMode = typeof days === 'number' && !isNaN(days) && days > 0;
    const expireIso = isExpireMode ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

    try {
      if (isExpireMode && expireIso) {
        if (dialect === 'mysql' || dialect === 'mariadb') {
          await this.app.db.sequelize.query(
            `DELETE FROM ${q(tableName)} WHERE ${q('createdAt')} < :expireIso LIMIT ${batchLimit}`,
            { replacements: { expireIso } },
          );
        } else {
          await this.app.db.sequelize.query(
            `DELETE FROM ${q(tableName)} WHERE ${q('id')} IN (SELECT ${q('id')} FROM ${q(tableName)} WHERE ${q('createdAt')} < :expireIso LIMIT ${batchLimit})`,
            { replacements: { expireIso } },
          );
        }
      } else {
        // 清空全部模式：纯数据秒级清空，绝不重建表结构
        await this.app.db.sequelize.query(`DELETE FROM ${q(tableName)};`);
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] cleanBatch error: ${err.message}`);
    }

    const { totalCount: remainingCount } = await this.getCleanTotalCount(collectionName, days);
    return {
      remainingCount,
    };
  }
}
