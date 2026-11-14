import { Context, Next } from '@nocobase/actions';
import { PassThrough } from 'stream';
import { LogReaderService } from '../services/log-reader.service';
import { LogConfigService } from '../services/log-config.service';
import { LogRetentionService } from '../services/log-retention.service';
import { AlertService } from '../services/alert.service';
import { DashboardService } from '../services/dashboard.service';
import { AuditExportService } from '../services/audit-export.service';
import { TraceService } from '../services/trace.service';
import { AIAnalyzerService } from '../services/ai-analyzer.service';

function getParams(ctx: Context): Record<string, any> {
  const query = ctx.query || ctx.request?.query || {};
  const actionParams = ctx.action?.params || {};
  const values = actionParams.values || {};
  const body = (typeof ctx.request?.body === 'object' && ctx.request.body) ? (ctx.request.body as Record<string, any>) : {};

  return {
    ...query,
    ...actionParams,
    ...values,
    ...body,
  };
}

export function createLoggerProResource(
  readerService: LogReaderService,
  configService: LogConfigService,
  retentionService: LogRetentionService,
  alertService: AlertService,
  dashboardService: DashboardService,
  auditExportService: AuditExportService,
  traceService: TraceService,
  aiAnalyzerService: AIAnalyzerService,
) {
  return {
    name: 'loggerPro',
    actions: {
      dashboard: async (ctx: Context, next: Next) => {
        const data = await dashboardService.getOverview();
        ctx.body = data;
        await next();
      },

      files: async (ctx: Context, next: Next) => {
        const files = await readerService.listFiles();
        ctx.body = files;
        await next();
      },

      readLines: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { fileName, lines, keyword, level, isRegex, reverse } = params;
        if (!fileName) {
          ctx.throw(400, 'fileName is required');
        }
        const data = await readerService.readLogLines({
          fileName: String(fileName),
          lines: lines ? Number(lines) : 500,
          keyword: keyword ? String(keyword) : undefined,
          level: level ? String(level) : undefined,
          isRegex: isRegex === true || isRegex === 'true',
          reverse: reverse === true || reverse === 'true',
        });
        ctx.body = data;
        await next();
      },

      tail: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { fileName, offsetBytes, maxBytes } = params;
        if (!fileName) {
          ctx.throw(400, 'fileName is required');
        }
        const data = await readerService.tailLog({
          fileName: String(fileName),
          offsetBytes: offsetBytes ? Number(offsetBytes) : 0,
          maxBytes: maxBytes ? Number(maxBytes) : 256 * 1024,
        });
        ctx.body = data;
        await next();
      },

      clearFile: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { fileName } = params;
        if (!fileName) {
          ctx.throw(400, 'fileName is required');
        }
        await readerService.clearFile(String(fileName));
        ctx.body = { success: true };
        await next();
      },

      deleteFile: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { fileName } = params;
        if (!fileName) {
          ctx.throw(400, 'fileName is required');
        }
        await readerService.deleteFile(String(fileName));
        ctx.body = { success: true };
        await next();
      },

      download: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { files = [] } = params;
        const fileList = Array.isArray(files)
          ? files
          : typeof files === 'string' && files.trim()
            ? files.split(',').map((s) => s.trim()).filter(Boolean)
            : [];

        try {
          (ctx as any).withoutDataWrapping = true;
          ctx.attachment(`logs_${Date.now()}.tar.gz`);
          ctx.set('Content-Type', 'application/gzip');
          ctx.body = await retentionService.createArchiveStream(fileList.length > 0 ? fileList : undefined);
        } catch (err: any) {
          ctx.throw(500, `Download logs failed: ${err.message}`);
        }
        await next();
      },

      cleanLogs: async (ctx: Context, next: Next) => {
        const result = await retentionService.cleanLogs();
        ctx.body = result;
        await next();
      },

      getConfigs: async (ctx: Context, next: Next) => {
        const configs = await configService.getAll();
        ctx.body = configs;
        await next();
      },

      updateConfigs: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const values = ctx.action?.params?.values || ctx.request?.body || params;
        await configService.updateAll(values);
        // 如果修改了定时清理配置，重启调度器
        retentionService.startScheduler();
        ctx.body = await configService.getAll();
        await next();
      },

      testAlert: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const ruleData = ctx.action?.params?.values || ctx.request?.body || params;
        const result = await alertService.testAlert(ruleData);
        ctx.body = result;
        await next();
      },

      getCollections: async (ctx: Context, next: Next) => {
        const collections = Array.from(ctx.app.db.collections.values()).map((col: any) => ({
          name: col.name,
          title: col.options?.title || col.name,
        }));
        ctx.body = collections;
        await next();
      },

      getCollectionFields: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { collectionName } = params;
        if (!collectionName) {
          ctx.throw(400, 'collectionName is required');
        }
        const collection = ctx.app.db.getCollection(String(collectionName));
        if (!collection) {
          ctx.body = {};
          await next();
          return;
        }

        const I18N_DICT: Record<string, string> = {
          'id': 'ID',
          'ID': 'ID',
          'Created at': '创建时间',
          'Updated at': '更新时间',
          'Created by': '创建人',
          'Updated by': '更新人',
          'createdById': '创建人 ID',
          'updatedById': '更新人 ID',
          'createdAt': '创建时间',
          'updatedAt': '更新时间',
        };

        const parseFieldTitle = (raw: any, fieldName: string): string => {
          if (typeof raw !== 'string' || !raw.trim()) {
            return I18N_DICT[fieldName] || fieldName;
          }
          const match = raw.match(/\{\{\s*t\(\s*["'](.*?)["']\s*\)\s*\}\}/);
          if (match && match[1]) {
            return I18N_DICT[match[1]] || match[1];
          }
          return I18N_DICT[raw] || raw;
        };

        const fieldsMap: Record<string, { title: string; type?: string; uiSchema?: any }> = {};
        if (collection.fields) {
          for (const [name, field] of collection.fields.entries()) {
            const rawTitle =
              (field.options as any)?.uiSchema?.title ||
              (field.options as any)?.title ||
              name;
            fieldsMap[name] = {
              title: parseFieldTitle(rawTitle, name),
              type: field.type || (field.options as any)?.type,
              uiSchema: (field.options as any)?.uiSchema,
            };
          }
        }
        ctx.body = fieldsMap;
        await next();
      },

      exportAuditLogs: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const format = (params.format as 'csv' | 'xlsx') || 'xlsx';
        const limit = params.limit ? Number(params.limit) : 10000;
        let fields: string[] | undefined = undefined;
        if (params.fields) {
          fields = Array.isArray(params.fields) ? params.fields : typeof params.fields === 'string' ? params.fields.split(',') : undefined;
        }
        let filter: any = {};
        if (params.filter) {
          try {
            filter = typeof params.filter === 'string' ? JSON.parse(params.filter) : params.filter;
          } catch {
            filter = {};
          }
        }
        await auditExportService.exportLogs(ctx, {
          format,
          fields,
          filter,
          limit,
        });
        return;
      },

      getTrace: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { reqId } = params;
        const result = await traceService.getTrace(String(reqId || ''));
        ctx.body = result;
        await next();
      },

      getRecentTraces: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { limit } = params;
        const result = await traceService.getRecentTraces(limit ? Number(limit) : 20);
        ctx.body = result;
        await next();
      },

      getAIEmployees: async (ctx: Context, next: Next) => {
        const list = await aiAnalyzerService.getAvailableEmployees();
        ctx.body = list;
        await next();
      },

      getLLMServices: async (ctx: Context, next: Next) => {
        const list = await aiAnalyzerService.getAvailableLLMServices();
        ctx.body = list;
        await next();
      },

      analyzeErrorLog: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { logText, employeeName, llmSelection, context, sanitize, forceHeuristic } = params;
        const result = await aiAnalyzerService.analyzeLog({
          logText: String(logText || ''),
          employeeName: employeeName ? String(employeeName) : undefined,
          llmSelection: typeof llmSelection === 'object' ? llmSelection : undefined,
          context: typeof context === 'object' ? context : undefined,
          sanitize: sanitize === undefined ? undefined : sanitize === true || sanitize === 'true',
          forceHeuristic: forceHeuristic === true || forceHeuristic === 'true',
        });
        ctx.body = result;
        await next();
      },

      analyzeErrorLogStream: async (ctx: Context) => {
        const params = getParams(ctx);
        const { logText, employeeName, llmSelection, context, sanitize, forceHeuristic } = params;
        const stream = new PassThrough();
        (ctx as any).withoutDataWrapping = true;
        ctx.status = 200;
        ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
        ctx.set('Cache-Control', 'no-cache, no-transform');
        ctx.set('Connection', 'keep-alive');
        ctx.set('X-Accel-Buffering', 'no');
        ctx.body = stream;

        const writeEvent = (payload: any) => {
          if (!stream.writableEnded) {
            stream.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        };

        aiAnalyzerService
          .analyzeLogStream(
            {
              logText: String(logText || ''),
              employeeName: employeeName ? String(employeeName) : undefined,
              llmSelection: typeof llmSelection === 'object' ? llmSelection : undefined,
              context: typeof context === 'object' ? context : undefined,
              sanitize: sanitize === undefined ? undefined : sanitize === true || sanitize === 'true',
              forceHeuristic: forceHeuristic === true || forceHeuristic === 'true',
            },
            {
              onMeta: (meta) => writeEvent({ type: 'meta', ...meta }),
              onReasoning: (content) => writeEvent({ type: 'reasoning', content }),
              onChunk: (content) => writeEvent({ type: 'chunk', content }),
              onDone: (result) => {
                writeEvent({ type: 'done', ...result });
                if (!stream.writableEnded) stream.end();
              },
              onError: (err: any) => {
                writeEvent({ type: 'error', message: err.message, errorCode: err?.code || 'LLM_CALL_FAILED' });
                if (!stream.writableEnded) stream.end();
              },
            },
          )
          .catch((err: any) => {
            writeEvent({ type: 'error', message: err?.message || 'Stream error', errorCode: err?.code || 'LLM_CALL_FAILED' });
            if (!stream.writableEnded) stream.end();
          });
      },

      previewSanitizedLog: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { logText, sanitize } = params;
        const shouldSanitize = sanitize === undefined ? true : sanitize === true || sanitize === 'true';
        const result = aiAnalyzerService.prepareLogForAI(String(logText || ''), shouldSanitize);
        ctx.body = result;
        await next();
      },

      aiFollowUp: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { recordId, question, messages, logText, employeeName, llmSelection, sanitize, forceHeuristic } = params;
        const result = await aiAnalyzerService.followUpChat({
          recordId,
          question: String(question || ''),
          messages: Array.isArray(messages) ? messages : undefined,
          logText: logText ? String(logText) : undefined,
          employeeName: employeeName ? String(employeeName) : undefined,
          llmSelection: typeof llmSelection === 'object' ? llmSelection : undefined,
          sanitize: sanitize === undefined ? undefined : sanitize === true || sanitize === 'true',
          forceHeuristic: forceHeuristic === true || forceHeuristic === 'true',
        });
        ctx.body = result;
        await next();
      },

      aiFollowUpStream: async (ctx: Context) => {
        const params = getParams(ctx);
        const { recordId, question, messages, logText, employeeName, llmSelection, sanitize, forceHeuristic } = params;
        const stream = new PassThrough();
        (ctx as any).withoutDataWrapping = true;
        ctx.status = 200;
        ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
        ctx.set('Cache-Control', 'no-cache, no-transform');
        ctx.set('Connection', 'keep-alive');
        ctx.set('X-Accel-Buffering', 'no');
        ctx.body = stream;

        const writeEvent = (payload: any) => {
          if (!stream.writableEnded) {
            stream.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        };

        aiAnalyzerService
          .followUpChatStream(
            {
              recordId,
              question: String(question || ''),
              messages: Array.isArray(messages) ? messages : undefined,
              logText: logText ? String(logText) : undefined,
              employeeName: employeeName ? String(employeeName) : undefined,
              llmSelection: typeof llmSelection === 'object' ? llmSelection : undefined,
              sanitize: sanitize === undefined ? undefined : sanitize === true || sanitize === 'true',
              forceHeuristic: forceHeuristic === true || forceHeuristic === 'true',
            },
            {
              onReasoning: (content) => writeEvent({ type: 'reasoning', content }),
              onChunk: (content) => writeEvent({ type: 'chunk', content }),
              onDone: (result) => {
                writeEvent({ type: 'done', ...result });
                if (!stream.writableEnded) stream.end();
              },
              onError: (err: any) => {
                writeEvent({ type: 'error', message: err.message, errorCode: err?.code || 'LLM_CALL_FAILED' });
                if (!stream.writableEnded) stream.end();
              },
            },
          )
          .catch((err: any) => {
            writeEvent({ type: 'error', message: err?.message || 'Follow-up stream error', errorCode: err?.code || 'LLM_CALL_FAILED' });
            if (!stream.writableEnded) stream.end();
          });
      },

      clusterErrorLogs: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { fileName, lines, logLines } = params;
        let targetLines: string[] = Array.isArray(logLines) ? logLines.map(String) : [];

        if (targetLines.length === 0) {
          let targetFile = fileName ? String(fileName) : '';
          if (!targetFile) {
            const files = await readerService.listFiles().catch(() => []);
            const errFile = files.find((f) => f.category === 'Error') || files.find((f) => f.category === 'System') || files[0];
            targetFile = errFile?.relativePath || errFile?.name || '';
          }
          if (targetFile) {
            const readRes = await readerService
              .readLogLines({ fileName: targetFile, lines: lines ? Number(lines) : 1000 })
              .catch(() => ({ lines: [] as string[] }));
            targetLines = readRes.lines || [];
          }
        }

        const clusters = aiAnalyzerService.clusterLogs(targetLines);
        ctx.body = {
          clusters,
          totalClusters: clusters.length,
          scannedLines: targetLines.length,
        };
        await next();
      },

      healthInspection: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { llmSelection, forceHeuristic } = params;
        const overview = await dashboardService.getOverview();
        const files = await readerService.listFiles().catch(() => []);
        const errFile = files.find((f) => f.category === 'Error') || files.find((f) => f.category === 'System') || files[0];
        let clusters: any[] = [];
        if (errFile) {
          const readRes = await readerService.readLogLines({ fileName: errFile.relativePath || errFile.name, lines: 500 }).catch(() => ({ lines: [] }));
          clusters = aiAnalyzerService.clusterLogs(readRes.lines || []);
        }
        const result = await aiAnalyzerService.runHealthInspection(
          overview,
          clusters,
          typeof llmSelection === 'object' ? llmSelection : undefined,
          { forceHeuristic: forceHeuristic === true || forceHeuristic === 'true' },
        );
        ctx.body = result;
        await next();
      },

      healthInspectionStream: async (ctx: Context) => {
        const params = getParams(ctx);
        const { llmSelection, forceHeuristic } = params;
        const stream = new PassThrough();
        (ctx as any).withoutDataWrapping = true;
        ctx.status = 200;
        ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
        ctx.set('Cache-Control', 'no-cache, no-transform');
        ctx.set('Connection', 'keep-alive');
        ctx.set('X-Accel-Buffering', 'no');
        ctx.body = stream;

        const writeEvent = (payload: any) => {
          if (!stream.writableEnded) {
            stream.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        };

        (async () => {
          const overview = await dashboardService.getOverview();
          const files = await readerService.listFiles().catch(() => []);
          const errFile = files.find((f) => f.category === 'Error') || files.find((f) => f.category === 'System') || files[0];
          let clusters: any[] = [];
          if (errFile) {
            const readRes = await readerService.readLogLines({ fileName: errFile.relativePath || errFile.name, lines: 500 }).catch(() => ({ lines: [] }));
            clusters = aiAnalyzerService.clusterLogs(readRes.lines || []);
          }
          await aiAnalyzerService.runHealthInspectionStream(
            overview,
            clusters,
            typeof llmSelection === 'object' ? llmSelection : undefined,
            {
              onMeta: (meta) => writeEvent({ type: 'meta', ...meta }),
              onReasoning: (content) => writeEvent({ type: 'reasoning', content }),
              onChunk: (content) => writeEvent({ type: 'chunk', content }),
              onDone: (result) => {
                writeEvent({ type: 'done', ...result });
                if (!stream.writableEnded) stream.end();
              },
              onError: (err: any) => {
                writeEvent({ type: 'error', message: err.message, errorCode: err?.code || 'LLM_CALL_FAILED' });
                if (!stream.writableEnded) stream.end();
              },
            },
            { forceHeuristic: forceHeuristic === true || forceHeuristic === 'true' },
          );
        })().catch((err: any) => {
          writeEvent({ type: 'error', message: err?.message || 'Inspection stream error', errorCode: err?.code || 'LLM_CALL_FAILED' });
          if (!stream.writableEnded) stream.end();
        });
      },

      getLatestHealthInspection: async (ctx: Context, next: Next) => {
        const result = await aiAnalyzerService.getLatestHealthInspection();
        ctx.body = result || null;
        await next();
      },

      nlToFilter: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { query, llmSelection, forceHeuristic } = params;
        const availableCollections = Array.from(ctx.app.db.collections.keys()).map(String);
        const result = await aiAnalyzerService.naturalLanguageToFilter(
          String(query || ''),
          availableCollections,
          typeof llmSelection === 'object' ? llmSelection : undefined,
          { forceHeuristic: forceHeuristic === true || forceHeuristic === 'true' },
        );
        ctx.body = result;
        await next();
      },

      getAIAnalysisHistory: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { page = 1, pageSize = 20 } = params;
        const result = await aiAnalyzerService.getAnalysisHistory({
          page: Number(page) || 1,
          pageSize: Number(pageSize) || 20,
        });
        ctx.body = result;
        await next();
      },

      getAIAnalysisRecord: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { id } = params;
        if (id === undefined || id === null || id === '') {
          ctx.throw(400, 'id is required');
        }
        const result = await aiAnalyzerService.getAnalysisRecord(id);
        ctx.body = result || {};
        await next();
      },

      deleteAIAnalysisRecord: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const { id } = params;
        const result = await aiAnalyzerService.deleteAnalysisRecord(id);
        ctx.body = { success: result };
        await next();
      },

      clearAIAnalysisHistory: async (ctx: Context, next: Next) => {
        const result = await aiAnalyzerService.clearAnalysisHistory();
        ctx.body = { success: result };
        await next();
      },

      getPluginStorageStats: async (ctx: Context, next: Next) => {
        const result = await retentionService.getPluginStorageStats();
        ctx.body = result;
        await next();
      },

      cleanTableData: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const collectionName = params.collectionName || ctx.action?.params?.collectionName;
        if (!collectionName) {
          ctx.throw(400, 'collectionName is required');
        }
        const result = await retentionService.cleanTableData(String(collectionName));
        ctx.body = result;
        await next();
      },

      cleanExpiredAuditLogs: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const days = params.days || ctx.action?.params?.days;
        const result = await retentionService.cleanExpiredAuditLogs(days ? Number(days) : 15);
        ctx.body = result;
        await next();
      },

      getCleanTotalCount: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const collectionName = params.collectionName || ctx.action?.params?.collectionName || 'logger_audit_logs';
        const rawDays = params.days ?? ctx.action?.params?.days;
        const days =
          rawDays !== undefined && rawDays !== null && rawDays !== '' && rawDays !== 'undefined' && !isNaN(Number(rawDays)) && Number(rawDays) > 0
            ? Number(rawDays)
            : undefined;

        const result = await retentionService.getCleanTotalCount(String(collectionName), days);
        ctx.body = result;
        await next();
      },

      cleanBatch: async (ctx: Context, next: Next) => {
        const params = getParams(ctx);
        const collectionName = params.collectionName || ctx.action?.params?.collectionName || 'logger_audit_logs';
        const rawDays = params.days ?? ctx.action?.params?.days;
        const days =
          rawDays !== undefined && rawDays !== null && rawDays !== '' && rawDays !== 'undefined' && !isNaN(Number(rawDays)) && Number(rawDays) > 0
            ? Number(rawDays)
            : undefined;
        const limit = params.limit || ctx.action?.params?.limit;

        const result = await retentionService.cleanBatch(
          String(collectionName),
          days,
          limit ? Number(limit) : 20000,
        );
        ctx.body = result;
        await next();
      },
    },
  };
}
