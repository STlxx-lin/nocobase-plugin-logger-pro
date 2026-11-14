import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MockServer, createMockServer } from '@nocobase/test';
import PluginLoggerProServer from '../index';
import { LogConfigService } from '../services/log-config.service';
import { LogReaderService } from '../services/log-reader.service';
import { LogRetentionService } from '../services/log-retention.service';
import { AlertService } from '../services/alert.service';
import { DashboardService } from '../services/dashboard.service';
import { AuditExportService } from '../services/audit-export.service';
import { TraceService } from '../services/trace.service';
import { AIAnalyzerService } from '../services/ai-analyzer.service';

describe('PluginLoggerProServer load & smoke test', () => {
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

  test('1. MockServer 成功初始化，能够双向检索插件实例', () => {
    const pluginByClass = app.pm.get(PluginLoggerProServer);
    const pluginByName = app.pm.get('logger-pro');

    expect(pluginByClass).toBeDefined();
    expect(pluginByName).toBeDefined();
    expect(pluginByClass).toBe(pluginByName);
    expect(pluginByName.name).toBe('logger-pro');
    expect(pluginByName.enabled).toBe(true);
  });

  test('2. 验证 8 大核心服务全部正确装配与实例化', () => {
    expect(plugin.configService).toBeDefined();
    expect(plugin.configService).toBeInstanceOf(LogConfigService);

    expect(plugin.readerService).toBeDefined();
    expect(plugin.readerService).toBeInstanceOf(LogReaderService);

    expect(plugin.retentionService).toBeDefined();
    expect(plugin.retentionService).toBeInstanceOf(LogRetentionService);

    expect(plugin.alertService).toBeDefined();
    expect(plugin.alertService).toBeInstanceOf(AlertService);

    expect(plugin.dashboardService).toBeDefined();
    expect(plugin.dashboardService).toBeInstanceOf(DashboardService);

    expect(plugin.auditExportService).toBeDefined();
    expect(plugin.auditExportService).toBeInstanceOf(AuditExportService);

    expect(plugin.traceService).toBeDefined();
    expect(plugin.traceService).toBeInstanceOf(TraceService);

    expect(plugin.aiAnalyzerService).toBeDefined();
    expect(plugin.aiAnalyzerService).toBeInstanceOf(AIAnalyzerService);
  });

  test('3. 验证 5 张数据表模型在 app.db 中成功注册', () => {
    const expectedCollections = [
      'logger_configs',
      'logger_audit_logs',
      'logger_alert_rules',
      'logger_alert_logs',
      'logger_ai_records',
    ];

    for (const name of expectedCollections) {
      expect(app.db.hasCollection(name)).toBe(true);
      const col = app.db.getCollection(name);
      expect(col).toBeDefined();
      expect(col.model).toBeDefined();
    }
  });

  test('4. 真实的 HTTP 请求测试，/api/loggerPro:dashboard 正常响应 HTTP 200 及概览结构', async () => {
    const res = await app.agent().get('/api/loggerPro:dashboard');
    expect(res.status).toBe(200);

    const data = res.body?.data || res.body;
    expect(data).toBeDefined();
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.totalLogFiles).toBe('number');
    expect(typeof data.summary.totalDiskBytes).toBe('number');
    expect(Array.isArray(data.trend)).toBe(true);
    expect(Array.isArray(data.categoryStats)).toBe(true);
    expect(Array.isArray(data.topSlowQueries)).toBe(true);
    expect(Array.isArray(data.topUsers)).toBe(true);
    expect(Array.isArray(data.topCollections)).toBe(true);
  });
});
