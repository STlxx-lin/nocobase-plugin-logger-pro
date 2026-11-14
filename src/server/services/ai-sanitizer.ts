import crypto from 'crypto';

export interface SanitizeResult {
  sanitized: string;
  maskedCount: number;
  maskedTypes: string[];
}

export interface CompressResult {
  compressed: string;
  originalLength: number;
  compressedLength: number;
  deduplicatedLines: number;
}

export interface ErrorCluster {
  fingerprint: string;
  pattern: string;
  sample: string;
  rawSample: string;
  count: number;
  level: string;
  firstSeen?: string;
  lastSeen?: string;
}

export interface NL2FilterResult {
  success: boolean;
  engine: 'llm' | 'heuristic';
  filter: Record<string, any>;
  uiFields: {
    username?: string;
    collectionName?: string;
    actionName?: string;
    statusFilter?: 'success' | 'error';
    method?: string;
    timeRange?: [string, string];
    keyword?: string;
  };
  tags: Array<{ key: string; label: string; value: any }>;
  explanation: string;
  llmService?: string;
  model?: string;
  errorCode?: 'LLM_NOT_CONFIGURED' | 'LLM_CALL_FAILED' | 'INVALID_INPUT';
  errorMessage?: string;
}

const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\x1B\[[0-9;]*[a-zA-Z]/g;

/**
 * 对发送给大模型前的日志文本进行敏感信息脱敏：
 * - Bearer Token / JWT
 * - API Key (sk-*, ak-*, ghp_*, xox*-*)
 * - 密码/密钥字段 (password/passwd/pwd/secret/token/apiKey/appSecret)
 * - 数据库连接串凭据 (postgres/mysql/mongodb/redis://user:pass@)
 * - 授权请求头 (Authorization / x-api-key / cookie)
 * - 邮箱地址与大陆手机号
 */
export function sanitizeLogText(input: string): SanitizeResult {
  if (!input || typeof input !== 'string') {
    return { sanitized: '', maskedCount: 0, maskedTypes: [] };
  }

  let text = input;
  let maskedCount = 0;
  const types = new Set<string>();

  const applyRule = (regex: RegExp, replacer: string | ((...args: any[]) => string), typeLabel: string) => {
    text = text.replace(regex, (...args) => {
      maskedCount++;
      types.add(typeLabel);
      if (typeof replacer === 'function') {
        return replacer(...args);
      }
      return replacer;
    });
  };

  // 1. 数据库连接串 user:pass@host
  applyRule(
    /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|mssql):\/\/)([^:\s/@]+):([^@\s]+)@/gi,
    (_m, scheme) => `${scheme}***:***@`,
    '数据库连接串',
  );

  // 2. Bearer Token
  applyRule(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***[REDACTED_TOKEN]***', 'Bearer Token');

  // 3. JWT Token
  applyRule(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    '***[REDACTED_JWT]***',
    'JWT',
  );

  // 4. 常见 API Key 前缀
  applyRule(
    /\b(?:sk-[A-Za-z0-9_-]{10,}|ak-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    '***[REDACTED_API_KEY]***',
    'API Key',
  );

  // 5. 常见敏感 Header (Authorization / x-api-key / cookie / set-cookie)
  applyRule(
    /((?:authorization|x-api-key|api-key|secret-key|access-token|refresh-token|set-cookie|cookie)\s*[:=]\s*["']?)([^\r\n"';,}]+)/gi,
    (_m, prefix, val) => {
      if (String(val).includes('***[REDACTED')) return `${prefix}${val}`;
      return `${prefix}***[REDACTED]***`;
    },
    '认证请求头',
  );

  // 6. 密码 / 密钥字段 (优先完整匹配引号内含空格的值，再匹配无引号 key=value)
  applyRule(
    /(["']?(?:password|passwd|pwd|secret|token|privateKey|private_key|apiKey|api_key|appSecret|app_secret|accessKeySecret)["']?\s*[:=]\s*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,}\r\n"']+))/gi,
    (m, prefix, dqVal, sqVal, bareVal) => {
      const val = dqVal ?? sqVal ?? bareVal ?? '';
      if (String(val).includes('***[REDACTED')) return m;
      if (dqVal !== undefined) return `${prefix}"***[REDACTED]***"`;
      if (sqVal !== undefined) return `${prefix}'***[REDACTED]***'`;
      return `${prefix}***[REDACTED]***`;
    },
    '密码/密钥字段',
  );

  // 7. 邮箱地址
  applyRule(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '***@***.***', '邮箱');

  // 8. 手机号 (11位大陆手机号)
  applyRule(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, (_m, p1, p2) => `${p1}****${p2}`, '手机号');

  return {
    sanitized: text,
    maskedCount,
    maskedTypes: Array.from(types),
  };
}

/**
 * 归一化单行日志用于去重与指纹计算
 */
function normalizeLineForDedup(line: string): string {
  return line
    .replace(ANSI_REGEX, '')
    .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<IP>')
    .replace(/0x[0-9a-f]+/gi, '<HEX>')
    .replace(/\b\d+\b/g, '<N>')
    .trim();
}

/**
 * 日志上下文智能压缩：
 * 1. 移除 ANSI 控制符与空行
 * 2. 折叠连续/高频重复的相似日志行
 * 3. 超长单行截断
 * 4. 在预算 maxChars 内优先保留包含 Error/Exception/Warn 的关键帧与首尾上下文
 */
export function compressLogContext(input: string, maxChars = 6000): CompressResult {
  if (!input || typeof input !== 'string') {
    return { compressed: '', originalLength: 0, compressedLength: 0, deduplicatedLines: 0 };
  }

  const originalLength = input.length;
  const rawLines = input.split(/\r?\n/).map((l) => l.replace(ANSI_REGEX, '').trimEnd()).filter((l) => l.trim().length > 0);

  // 1. 折叠连续重复行（基于归一化签名）
  const collapsed: Array<{ text: string; isImportant: boolean }> = [];
  let prevSig = '';
  let repeatCount = 0;
  let deduplicatedLines = 0;

  const flushRepeat = () => {
    if (repeatCount > 0) {
      collapsed.push({
        text: `... (similar log repeated ${repeatCount} more time${repeatCount > 1 ? 's' : ''})`,
        isImportant: false,
      });
      repeatCount = 0;
    }
  };

  for (const rawLine of rawLines) {
    const line = rawLine.length > 800 ? `${rawLine.slice(0, 800)} ...(truncated ${rawLine.length - 800} chars)` : rawLine;
    const sig = normalizeLineForDedup(line);
    if (sig && sig === prevSig) {
      repeatCount++;
      deduplicatedLines++;
      continue;
    }
    flushRepeat();
    prevSig = sig;
    const isImportant = /\[error\]|\[warn\]|error:|exception|fatal|typeerror|referenceerror|syntaxerror|sql|timeout|econnrefused|at\s+/i.test(line);
    collapsed.push({ text: line, isImportant });
  }
  flushRepeat();

  let joined = collapsed.map((c) => c.text).join('\n');
  if (joined.length <= maxChars) {
    return {
      compressed: joined,
      originalLength,
      compressedLength: joined.length,
      deduplicatedLines,
    };
  }

  // 2. 超出预算时：保留头部 20% + 关键错误帧 + 尾部 30%
  const headLines = collapsed.slice(0, Math.min(8, collapsed.length)).map((c) => c.text);
  const tailLines = collapsed.slice(Math.max(8, collapsed.length - 12)).map((c) => c.text);
  const middleImportant = collapsed
    .slice(Math.min(8, collapsed.length), Math.max(8, collapsed.length - 12))
    .filter((c) => c.isImportant)
    .map((c) => c.text);

  const combined: string[] = [...headLines];
  if (middleImportant.length > 0) {
    combined.push('... (non-error context omitted for brevity) ...');
    let budget = Math.max(0, maxChars - headLines.join('\n').length - tailLines.join('\n').length - 120);
    for (const imp of middleImportant) {
      if (budget - imp.length - 1 < 0) break;
      combined.push(imp);
      budget -= imp.length + 1;
    }
  } else if (collapsed.length > headLines.length + tailLines.length) {
    combined.push(`... (${collapsed.length - headLines.length - tailLines.length} middle lines omitted) ...`);
  }
  combined.push(...tailLines);

  joined = combined.join('\n');
  if (joined.length > maxChars) {
    joined = joined.slice(0, maxChars - 30) + '\n... (context truncated)';
  }

  return {
    compressed: joined,
    originalLength,
    compressedLength: joined.length,
    deduplicatedLines,
  };
}

function extractTimestamp(line: string): string | undefined {
  const m = line.match(/(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  return m ? m[1] : undefined;
}

/**
 * 计算错误日志行指纹（用于本地错误聚类去重）
 */
export function computeErrorFingerprint(line: string): { fingerprint: string; pattern: string; level: string } {
  const clean = line.replace(ANSI_REGEX, '').trim();
  let level = 'ERROR';
  if (/\[warn\]|"level"\s*:\s*"warn"/i.test(clean)) {
    level = 'WARN';
  }

  // 尝试提取 JSON 格式日志的 message/stack
  let coreText = clean;
  if (clean.startsWith('{') && clean.endsWith('}')) {
    try {
      const parsed = JSON.parse(clean);
      coreText = [parsed.message, parsed.err?.message, parsed.error, parsed.stack?.split('\n')?.[0]]
        .filter(Boolean)
        .join(' | ') || clean;
      if (parsed.level) level = String(parsed.level).toUpperCase();
    } catch {}
  }

  const pattern = coreText
    .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<IP>')
    .replace(/"reqId"\s*:\s*"[^"]+"/gi, '')
    .replace(/reqId=[^\s,]+/gi, '')
    .replace(/'[^']{1,60}'/g, "'<STR>'")
    .replace(/\b\d+\b/g, '<N>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);

  const fingerprint = crypto.createHash('sha1').update(`${level}:${pattern}`).digest('hex').slice(0, 12);
  return { fingerprint, pattern: pattern || clean.slice(0, 120), level };
}

/**
 * 对日志行执行本地指纹聚类去重
 */
export function clusterErrorLines(lines: string[]): ErrorCluster[] {
  const map = new Map<string, ErrorCluster>();

  for (const rawLine of lines) {
    if (!rawLine || !rawLine.trim()) continue;
    // 只聚簇 ERROR/WARN 或包含异常关键词的行
    if (!/\[error\]|\[warn\]|"level"\s*:\s*"(?:error|warn)"|Error:|Exception|TypeError|ReferenceError|SyntaxError|FATAL/i.test(rawLine)) {
      continue;
    }

    const { fingerprint, pattern, level } = computeErrorFingerprint(rawLine);
    const ts = extractTimestamp(rawLine);
    const existing = map.get(fingerprint);

    if (existing) {
      existing.count += 1;
      if (ts) {
        if (!existing.firstSeen || ts < existing.firstSeen) existing.firstSeen = ts;
        if (!existing.lastSeen || ts > existing.lastSeen) existing.lastSeen = ts;
      }
    } else {
      const { sanitized } = sanitizeLogText(rawLine.replace(ANSI_REGEX, '').trim());
      map.set(fingerprint, {
        fingerprint,
        pattern,
        sample: sanitized.slice(0, 800),
        rawSample: rawLine.replace(ANSI_REGEX, '').trim().slice(0, 1200),
        count: 1,
        level,
        firstSeen: ts,
        lastSeen: ts,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

const ALLOWED_FILTER_FIELDS = new Set([
  'createdAt',
  'statusCode',
  'method',
  'userUsername',
  'collectionName',
  'actionName',
  'path',
]);

const ALLOWED_OPERATORS = new Set(['$gte', '$gt', '$lte', '$lt', '$eq', '$ne', '$includes', '$in']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype', '$raw', '$sql', 'sql']);

/**
 * 严格白名单校验与清洗 NL2Filter 输出，绝不允许原始 SQL 或非白名单字段
 */
export function sanitizeNLFilter(rawFilter: any, availableCollections?: string[]): Record<string, any> {
  if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
    return {};
  }

  const clean: Record<string, any> = {};

  for (const [key, val] of Object.entries(rawFilter)) {
    if (DANGEROUS_KEYS.has(key) || !ALLOWED_FILTER_FIELDS.has(key)) {
      continue;
    }
    if (val === undefined || val === null || val === '') continue;

    if (key === 'method') {
      const upper = String(val).toUpperCase();
      if (ALLOWED_METHODS.has(upper)) {
        clean.method = upper;
      }
      continue;
    }

    if (key === 'collectionName') {
      const col = String(val).trim();
      if (!/^[A-Za-z0-9_.-]+$/.test(col)) continue;
      if (availableCollections && availableCollections.length > 0 && !availableCollections.includes(col)) {
        // 如果不在精确集合列表里，仍允许合法标识符但跳过明显无效注入
      }
      clean.collectionName = col;
      continue;
    }

    if (key === 'actionName') {
      const act = String(val).trim();
      if (/^[A-Za-z0-9_.-]+$/.test(act)) {
        clean.actionName = act;
      }
      continue;
    }

    if (key === 'statusCode') {
      if (typeof val === 'number' && Number.isInteger(val)) {
        clean.statusCode = val;
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        const opObj: Record<string, number> = {};
        for (const [op, opVal] of Object.entries(val)) {
          if (ALLOWED_OPERATORS.has(op) && typeof opVal === 'number' && Number.isFinite(opVal)) {
            opObj[op] = opVal;
          }
        }
        if (Object.keys(opObj).length > 0) clean.statusCode = opObj;
      }
      continue;
    }

    if (key === 'createdAt') {
      if (typeof val === 'object' && !Array.isArray(val)) {
        const opObj: Record<string, string> = {};
        for (const [op, opVal] of Object.entries(val)) {
          if (['$gte', '$gt', '$lte', '$lt'].includes(op) && typeof opVal === 'string') {
            const d = new Date(opVal);
            if (!isNaN(d.getTime())) {
              opObj[op] = d.toISOString();
            }
          }
        }
        if (Object.keys(opObj).length > 0) clean.createdAt = opObj;
      }
      continue;
    }

    if (key === 'userUsername' || key === 'path') {
      if (typeof val === 'string') {
        clean[key] = { $includes: val.trim().slice(0, 100) };
      } else if (typeof val === 'object' && !Array.isArray(val) && typeof (val as any).$includes === 'string') {
        clean[key] = { $includes: (val as any).$includes.trim().slice(0, 100) };
      }
    }
  }

  return clean;
}

/**
 * 根据清洗后的 filter 构建 UI 回填字段与条件标签
 */
export function buildNL2FilterResponse(
  cleanFilter: Record<string, any>,
  engine: 'llm' | 'heuristic',
  explanation: string,
): NL2FilterResult {
  const uiFields: NL2FilterResult['uiFields'] = {};
  const tags: NL2FilterResult['tags'] = [];

  if (cleanFilter.userUsername) {
    const u = typeof cleanFilter.userUsername === 'string'
      ? cleanFilter.userUsername
      : cleanFilter.userUsername.$includes;
    if (u) {
      uiFields.username = u;
      tags.push({ key: 'username', label: `操作人: ${u}`, value: u });
    }
  }

  if (cleanFilter.collectionName) {
    uiFields.collectionName = cleanFilter.collectionName;
    tags.push({ key: 'collectionName', label: `数据表: ${cleanFilter.collectionName}`, value: cleanFilter.collectionName });
  }

  if (cleanFilter.actionName) {
    uiFields.actionName = cleanFilter.actionName;
    tags.push({ key: 'actionName', label: `动作: ${cleanFilter.actionName}`, value: cleanFilter.actionName });
  }

  if (cleanFilter.method) {
    uiFields.method = cleanFilter.method;
    tags.push({ key: 'method', label: `方法: ${cleanFilter.method}`, value: cleanFilter.method });
  }

  if (cleanFilter.statusCode !== undefined) {
    if (typeof cleanFilter.statusCode === 'number') {
      uiFields.statusFilter = cleanFilter.statusCode >= 400 ? 'error' : 'success';
      tags.push({ key: 'statusCode', label: `状态码: ${cleanFilter.statusCode}`, value: cleanFilter.statusCode });
    } else if (typeof cleanFilter.statusCode === 'object') {
      if (cleanFilter.statusCode.$gte >= 400) {
        uiFields.statusFilter = 'error';
        tags.push({ key: 'statusFilter', label: `状态: 失败 (>=${cleanFilter.statusCode.$gte})`, value: cleanFilter.statusCode });
      } else if (cleanFilter.statusCode.$lt && cleanFilter.statusCode.$lt <= 400) {
        uiFields.statusFilter = 'success';
        tags.push({ key: 'statusFilter', label: `状态: 成功 (<${cleanFilter.statusCode.$lt})`, value: cleanFilter.statusCode });
      } else if (typeof cleanFilter.statusCode.$eq === 'number') {
        uiFields.statusFilter = cleanFilter.statusCode.$eq >= 400 ? 'error' : 'success';
        tags.push({ key: 'statusCode', label: `状态码: ${cleanFilter.statusCode.$eq}`, value: cleanFilter.statusCode.$eq });
      } else if (Array.isArray(cleanFilter.statusCode.$in) && cleanFilter.statusCode.$in.length > 0) {
        const hasErr = cleanFilter.statusCode.$in.some((c: number) => Number(c) >= 400);
        uiFields.statusFilter = hasErr ? 'error' : 'success';
        tags.push({ key: 'statusCode', label: `状态码: ${cleanFilter.statusCode.$in.join(', ')}`, value: cleanFilter.statusCode });
      }
    }
  }

  if (cleanFilter.createdAt) {
    const start = cleanFilter.createdAt.$gte || cleanFilter.createdAt.$gt;
    const end = cleanFilter.createdAt.$lte || cleanFilter.createdAt.$lt;
    if (start || end) {
      uiFields.timeRange = [start || '', end || ''];
      const startLabel = start ? new Date(start).toLocaleString() : '不限';
      const endLabel = end ? new Date(end).toLocaleString() : '现在';
      tags.push({ key: 'createdAt', label: `时间: ${startLabel} ~ ${endLabel}`, value: cleanFilter.createdAt });
    }
  }

  if (cleanFilter.path?.$includes) {
    uiFields.keyword = cleanFilter.path.$includes;
    tags.push({ key: 'path', label: `路径包含: ${cleanFilter.path.$includes}`, value: cleanFilter.path.$includes });
  }

  return {
    success: true,
    engine,
    filter: cleanFilter,
    uiFields,
    tags,
    explanation,
  };
}

/**
 * 内置启发式自然语言转查询条件解析器（LLM 未配置或失败时的保底）
 */
export function heuristicNLToFilter(query: string, availableCollections: string[] = []): NL2FilterResult {
  const q = (query || '').trim();
  const filter: Record<string, any> = {};
  const now = new Date();

  // 1. 时间范围解析
  if (/今天|今日|today/i.test(q)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    filter.createdAt = { $gte: start.toISOString() };
  } else if (/昨天|昨日|yesterday/i.test(q)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    filter.createdAt = { $gte: start.toISOString(), $lt: end.toISOString() };
  } else {
    const hourMatch = q.match(/(?:最近|近|last)\s*(\d+)\s*(?:小时|h|hours?)/i);
    const dayMatch = q.match(/(?:最近|近|last)\s*(\d+)\s*(?:天|d|days?)/i);
    const minMatch = q.match(/(?:最近|近|last)\s*(\d+)\s*(?:分钟|min|minutes?)/i);
    if (minMatch) {
      filter.createdAt = { $gte: new Date(now.getTime() - Number(minMatch[1]) * 60 * 1000).toISOString() };
    } else if (hourMatch) {
      filter.createdAt = { $gte: new Date(now.getTime() - Number(hourMatch[1]) * 3600 * 1000).toISOString() };
    } else if (dayMatch) {
      filter.createdAt = { $gte: new Date(now.getTime() - Number(dayMatch[1]) * 86400 * 1000).toISOString() };
    }
  }

  // 2. 状态码 / 成功失败
  if (/\b500\b|5xx|服务端错误|服务器错误/i.test(q)) {
    filter.statusCode = { $gte: 500 };
  } else if (/\b404\b/i.test(q)) {
    filter.statusCode = 404;
  } else if (/\b403\b/i.test(q)) {
    filter.statusCode = 403;
  } else if (/\b401\b/i.test(q)) {
    filter.statusCode = 401;
  } else if (/失败|报错|异常|错误|error|fail/i.test(q)) {
    filter.statusCode = { $gte: 400 };
  } else if (/成功|正常|success/i.test(q)) {
    filter.statusCode = { $lt: 400 };
  }

  // 3. HTTP 方法
  const methodMatch = q.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/i);
  if (methodMatch) {
    filter.method = methodMatch[1].toUpperCase();
  }

  // 4. 操作动作
  if (/删除|destroy|delete/i.test(q) && !filter.method) {
    filter.actionName = 'destroy';
  } else if (/更新|修改|编辑|update/i.test(q)) {
    filter.actionName = 'update';
  } else if (/创建|新增|添加|create/i.test(q)) {
    filter.actionName = 'create';
  }

  // 5. 数据表匹配
  if (availableCollections.length > 0) {
    const matchedCol = availableCollections.find((col) => {
      if (!col || col.length < 2) return false;
      const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, 'i').test(q);
    });
    if (matchedCol) {
      filter.collectionName = matchedCol;
    }
  } else {
    const tableMatch = q.match(/(?:表|集合|collection)\s*[:：]?\s*([A-Za-z0-9_]+)/i);
    if (tableMatch) {
      filter.collectionName = tableMatch[1];
    }
  }

  // 6. 用户名匹配
  const userMatch =
    q.match(/(?:用户|操作人|user)\s*[:：]?\s*([A-Za-z0-9_.-]+)/i) ||
    q.match(/\b(admin|root|nocobase)\b/i);
  if (userMatch && userMatch[1]) {
    filter.userUsername = { $includes: userMatch[1] };
  }

  // 7. 路径关键词
  const pathMatch = q.match(/(\/api\/[A-Za-z0-9_/:.-]+)/i);
  if (pathMatch) {
    filter.path = { $includes: pathMatch[1] };
  }

  const sanitized = sanitizeNLFilter(filter, availableCollections);
  return buildNL2FilterResponse(
    sanitized,
    'heuristic',
    Object.keys(sanitized).length > 0
      ? '已通过内置规则引擎解析出结构化查询条件（未调用或未命中外部 LLM）'
      : '未识别出明确的结构化字段，请尝试补充时间范围、用户、数据表或状态关键词',
  );
}
