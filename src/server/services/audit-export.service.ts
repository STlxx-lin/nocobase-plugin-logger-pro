import { Application } from '@nocobase/server';
import { Context } from 'koa';

export interface AuditExportOptions {
  format?: 'csv' | 'xlsx' | 'json';
  fields?: string[];
  filter?: any;
  limit?: number;
}

export const ALL_AUDIT_EXPORT_FIELDS: Record<string, string> = {
  createdAt: '发生时间',
  reqId: '请求ID',
  userUsername: '操作用户名',
  userNickname: '用户昵称',
  userId: '用户ID',
  ip: '客户端IP',
  userAgent: 'User-Agent',
  method: '请求方法',
  path: '请求路径',
  collectionName: '数据表(Collection)',
  actionName: '操作动作(Action)',
  recordId: '目标记录ID',
  statusCode: '状态码',
  durationMs: '耗时(ms)',
  diff: '变更字段差异(JSON)',
  beforeData: '变更前快照(JSON)',
  afterData: '变更后快照(JSON)',
  params: '请求参数(JSON)',
  errorMessage: '异常信息',
};

// 兼容旧版前端/外部脚本使用的历史字段名，映射到当前模型字段
export const LEGACY_FIELD_ALIASES: Record<string, string> = {
  username: 'userUsername',
  nickname: 'userNickname',
  ua: 'userAgent',
  diffSummary: 'diff',
  previousData: 'beforeData',
  newData: 'afterData',
};

const MAX_EXPORT_LIMIT = 50000;
const EXPORT_BATCH_SIZE = 2000;

function normalizeField(key: string): string {
  const name = String(key || '').trim();
  return LEGACY_FIELD_ALIASES[name] || name;
}

/**
 * 递归规范化 filter 对象，将历史别名字段转换为当前集合实际字段
 */
export function normalizeFilter(filter: any): any {
  if (!filter || typeof filter !== 'object') {
    return filter;
  }
  if (Array.isArray(filter)) {
    return filter.map((item) => normalizeFilter(item));
  }
  if (filter instanceof Date || filter instanceof RegExp) {
    return filter;
  }
  const result: any = {};
  for (const [key, value] of Object.entries(filter)) {
    const normalizedKey = LEGACY_FIELD_ALIASES[key] || key;
    if (value && typeof value === 'object') {
      result[normalizedKey] = normalizeFilter(value);
    } else {
      result[normalizedKey] = value;
    }
  }
  return result;
}

export class AuditExportService {
  private app: Application;

  constructor(app: Application) {
    this.app = app;
  }

  // 格式化单元格数据
  private formatCellValue(key: string, record: any): string {
    const val = record[key];
    if (val === null || val === undefined) return '';
    if (key === 'createdAt') {
      try {
        return new Date(val).toLocaleString();
      } catch {
        return String(val);
      }
    }
    if (key === 'diff') {
      if (typeof val === 'string') return val;
      if (typeof val === 'object') {
        const keys = Object.keys(val);
        return keys.length > 0 ? keys.join(', ') : '无变更';
      }
      return '';
    }
    if (key === 'beforeData' || key === 'afterData' || key === 'params') {
      if (typeof val === 'object') {
        try {
          const json = JSON.stringify(val);
          // 单单元格上限 32KB，避免 Excel/CSV 行被撑爆
          return json.length > 32000 ? `${json.slice(0, 32000)}... [truncated]` : json;
        } catch {
          return '';
        }
      }
      return String(val);
    }
    return String(val);
  }

  // 生成 CSV 格式字符串
  private generateCsv(records: any[], selectedFieldKeys: string[]): string {
    const headerRow = selectedFieldKeys.map((k) => `"${(ALL_AUDIT_EXPORT_FIELDS[k] || k).replace(/"/g, '""')}"`).join(',');
    const rows = records.map((rec) => {
      return selectedFieldKeys
        .map((k) => {
          let val = this.formatCellValue(k, rec);
          // 中和 CSV 公式注入：Excel 会将以 = + - @ 等开头的单元格解析为公式/DDE 执行
          if (/^[=+\-@\t\r]/.test(val)) {
            val = `'${val}`;
          }
          // 转义双引号
          return `"${val.replace(/"/g, '""')}"`;
        })
        .join(',');
    });

    // 加上 UTF-8 BOM (\uFEFF) 确保 Windows Excel 打开中文不乱码
    return '\uFEFF' + [headerRow, ...rows].join('\r\n');
  }

  // 生成 Excel XML Spreadsheet 格式 (原生支持 Excel 打开，无外部依赖)
  private generateExcelXml(records: any[], selectedFieldKeys: string[]): string {
    const escapeXml = (str: string) =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1890FF" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="Cell">
   <Alignment ss:Vertical="Center" ss:WrapText="1"/>
  </Style>
  <Style ss:ID="NumberCell">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="审计操作记录">
  <Table ss:DefaultRowHeight="20">
`;

    // 表头列宽
    for (const key of selectedFieldKeys) {
      const width = key.includes('Data') ? 250 : key === 'createdAt' ? 140 : key === 'reqId' ? 200 : 110;
      xml += `   <Column ss:Width="${width}"/>\n`;
    }

    // 表头行
    xml += '   <Row ss:Height="26">\n';
    for (const key of selectedFieldKeys) {
      const title = ALL_AUDIT_EXPORT_FIELDS[key] || key;
      xml += `    <Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(title)}</Data></Cell>\n`;
    }
    xml += '   </Row>\n';

    // 数据行
    for (const rec of records) {
      xml += '   <Row>\n';
      for (const key of selectedFieldKeys) {
        const val = this.formatCellValue(key, rec);
        const isNum = (key === 'statusCode' || key === 'durationMs') && !isNaN(Number(val));
        if (isNum && val !== '') {
          xml += `    <Cell ss:StyleID="NumberCell"><Data ss:Type="Number">${val}</Data></Cell>\n`;
        } else {
          xml += `    <Cell ss:StyleID="Cell"><Data ss:Type="String">${escapeXml(val)}</Data></Cell>\n`;
        }
      }
      xml += '   </Row>\n';
    }

    xml += `  </Table>
 </Worksheet>
</Workbook>`;

    return xml;
  }

  /**
   * 分批拉取记录（按 id 递增）：
   * 1. 避免一次性把 5 万行（含 JSON 快照）全量读入内存；
   * 2. 使用游标而非 offset 翻页，大偏移量在 SQLite/MySQL 上不会退化为全表扫描。
   */
  private async fetchRecordsInBatches(repo: any, filter: any, limit: number): Promise<any[]> {
    const rows: any[] = [];
    let lastId: any = null;
    while (rows.length < limit) {
      const batchFilter: any = { ...(filter || {}) };
      if (lastId !== null && lastId !== undefined) {
        batchFilter.id = { ...(typeof batchFilter.id === 'object' ? batchFilter.id : {}), $gt: lastId };
      }
      const batchLimit = Math.min(EXPORT_BATCH_SIZE, limit - rows.length);
      const batch = await repo.find({
        filter: batchFilter,
        sort: ['id'],
        limit: batchLimit,
      });
      if (!batch || batch.length === 0) break;
      for (const item of batch) {
        rows.push(item);
        lastId = item.id;
      }
      if (batch.length < batchLimit) break;
    }
    // 越新的记录排前面，与列表页顺序保持一致
    return rows.reverse();
  }

  // 执行导出并设置响应流
  async exportLogs(ctx: Context, options: AuditExportOptions) {
    const repo = this.app.db.getRepository('logger_audit_logs');
    if (!repo) {
      ctx.throw(500, 'Audit log repository not initialized');
    }

    const format = options.format === 'csv' ? 'csv' : options.format === 'json' ? 'json' : 'xlsx';
    const limit = Math.min(Math.max(Number(options.limit) || 10000, 1), MAX_EXPORT_LIMIT);
    const rawFields = Array.isArray(options.fields) ? options.fields : typeof options.fields === 'string' ? String(options.fields).split(',') : [];
    const requested = rawFields.map((f) => normalizeField(String(f))).filter((f) => f in ALL_AUDIT_EXPORT_FIELDS);
    const selectedFields = requested.length > 0 ? Array.from(new Set(requested)) : Object.keys(ALL_AUDIT_EXPORT_FIELDS);

    const normalizedFilter = normalizeFilter(options.filter || {});
    const records = await this.fetchRecordsInBatches(repo, normalizedFilter, limit);

    const now = new Date();
    const timeStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

    (ctx as any).withoutDataWrapping = true;
    if (format === 'csv') {
      const csvContent = this.generateCsv(records, selectedFields);
      ctx.set('Content-Type', 'text/csv; charset=utf-8');
      ctx.attachment(`audit_logs_${timeStr}.csv`);
      ctx.body = csvContent;
    } else if (format === 'json') {
      const exportData = records.map((rec) => {
        const item: Record<string, any> = {};
        for (const k of selectedFields) {
          let val = rec[k];
          if (typeof val === 'string' && (k === 'diff' || k === 'beforeData' || k === 'afterData' || k === 'params')) {
            try {
              val = JSON.parse(val);
            } catch {
              // keep as string
            }
          }
          item[k] = val !== undefined ? val : null;
        }
        return item;
      });
      ctx.set('Content-Type', 'application/json; charset=utf-8');
      ctx.attachment(`audit_logs_${timeStr}.json`);
      ctx.body = JSON.stringify(exportData, null, 2);
    } else {
      const xmlContent = this.generateExcelXml(records, selectedFields);
      // 内容实际为 Excel XML（xls 后缀可被 Excel/WPS 正常识别），文件名与内容保持一致
      ctx.set('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      ctx.attachment(`audit_logs_${timeStr}.xls`);
      ctx.body = xmlContent;
    }
  }
}
