import { Context, Next } from '@nocobase/actions';
import { LogReaderService } from '../services/log-reader.service';
import { LogRetentionService } from '../services/log-retention.service';
import { getLoggerFilePath } from '@nocobase/logger';
import path from 'path';
import fsp from 'fs/promises';
import _ from 'lodash';

const envVars = [
  'APP_ENV',
  'APP_PORT',
  'API_BASE_PATH',
  'API_BASE_URL',
  'DB_DIALECT',
  'DB_TABLE_PREFIX',
  'DB_UNDERSCORED',
  'DB_TIMEZONE',
  'DB_LOGGING',
  'LOGGER_TRANSPORT',
  'LOGGER_LEVEL',
];

export function createCompatLoggerResource(
  readerService: LogReaderService,
  retentionService?: LogRetentionService,
) {
  const getRetentionService = (): LogRetentionService | null => {
    if (retentionService) return retentionService;
    const app = (readerService as any).app;
    if (app) {
      const plugin = app.pm?.get?.('logger-pro') || app.pm?.get?.('@nocobase/plugin-logger-pro');
      if (plugin?.retentionService) {
        return plugin.retentionService;
      }
    }
    return null;
  };

  return {
    name: 'logger',
    actions: {
      list: async (ctx: Context, next: Next) => {
        const basePath = readerService.getLogBasePath();
        const readDir = async (path2: string) => {
          const fileTree: any[] = [];
          try {
            const files = await fsp.readdir(path2, { withFileTypes: true });
            for (const file of files) {
              if (file.isDirectory()) {
                const subFiles = await readDir(path.join(path2, file.name));
                if (!subFiles.length) continue;
                fileTree.push({
                  name: file.name,
                  files: subFiles,
                });
              } else if (file.name.endsWith('.log')) {
                fileTree.push(file.name);
              }
            }
            return fileTree;
          } catch (err) {
            return [];
          }
        };
        ctx.body = await readDir(basePath);
        await next();
      },

      download: async (ctx: Context, next: Next) => {
        const rawValues = ctx.action?.params?.values || (ctx.request as any)?.body || ctx.query || {};
        const values = rawValues.values && typeof rawValues.values === 'object' && !Array.isArray(rawValues.values) ? rawValues.values : rawValues;
        const files: string[] = values.files || (Array.isArray(values) ? values : []);
        if (!files.length) {
          ctx.throw(400, 'No files selected.');
        }
        const retention = getRetentionService();
        if (!retention) {
          ctx.throw(500, 'LogRetentionService is not available.');
        }
        try {
          ctx.attachment('logs.tar.gz');
          ctx.body = await retention.createArchiveStream(files);
        } catch (err: any) {
          ctx.throw(500, `Download logs failed: ${err.message}`);
        }
        await next();
      },

      collect: async (ctx: Context, next: Next) => {
        const rawValues = ctx.action?.params?.values || (ctx.request as any)?.body || {};
        const values = rawValues.values && typeof rawValues.values === 'object' ? rawValues.values : rawValues;
        const { error, ...info } = values;
        const { message, ...e } = error || {};
        ctx.log?.error?.({ message: `Diagnosis, frontend error, ${message}`, ...e });
        ctx.log?.error?.(`Diagnostic information`, info);
        ctx.log?.error?.('Diagnosis, environment variables', _.pick(process.env, envVars));

        const retention = getRetentionService();
        if (!retention) {
          ctx.throw(500, 'LogRetentionService is not available.');
        }
        try {
          ctx.attachment('logs.tar.gz');
          ctx.body = await retention.createArchiveStream();
        } catch (err: any) {
          ctx.throw(500, `Download logs failed: ${err.message}`);
        }
        await next();
      },
    },
  };
}
