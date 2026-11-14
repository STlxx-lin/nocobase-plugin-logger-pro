import { Application } from '@nocobase/server';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { isPrivateOrReservedHost } from './alert.service';
import { CONFIG_KEYS } from '../constants';
import { LogConfigService } from './log-config.service';
import {
  sanitizeLogText,
  compressLogContext,
  clusterErrorLines,
  sanitizeNLFilter,
  buildNL2FilterResponse,
  heuristicNLToFilter,
  ErrorCluster,
  NL2FilterResult,
} from './ai-sanitizer';

export interface LLMServiceSelection {
  llmService?: string; // 系统服务标识 (如 v_c6u6kvt0t85)
  model?: string;      // 系统模型标识 (如 qwen-plus)
}

export interface ChatMessageItem {
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoningContent?: string;
  createdAt?: string;
  engine?: 'llm' | 'heuristic';
  llmService?: string;
  model?: string;
}

export interface AIAnalysisRequest {
  logText: string;
  employeeName?: string; // 选中的员工 username 或 system-error-expert
  llmSelection?: LLMServiceSelection;
  sanitize?: boolean;
  recordType?: string;
  forceHeuristic?: boolean; // 用户显式选择“使用内置规则兜底分析”
  context?: {
    reqId?: string;
    method?: string;
    path?: string;
    collectionName?: string;
    actionName?: string;
    sqlQueries?: string[];
    userAgent?: string;
    [key: string]: any;
  };
}

export interface AIAnalysisResponse {
  id?: number | string;
  success: boolean;
  analyzerName: string;
  analysisReport: string;
  reasoningContent?: string;
  durationMs: number;
  createdAt?: string;
  engine?: 'llm' | 'heuristic';
  llmService?: string;
  model?: string;
  errorCode?: 'LLM_NOT_CONFIGURED' | 'LLM_CALL_FAILED' | 'INVALID_INPUT';
  errorMessage?: string;
  messages?: ChatMessageItem[];
  maskedCount?: number;
  maskedTypes?: string[];
  compressedStats?: {
    originalLength: number;
    compressedLength: number;
    deduplicatedLines: number;
  };
}

export interface StreamCallbacks {
  onMeta?: (meta: Record<string, any>) => void;
  onReasoning?: (chunk: string) => void;
  onChunk: (chunk: string) => void;
  onDone?: (result: AIAnalysisResponse) => void;
  onError?: (err: Error) => void;
}

/**
 * 流式分离 `<think>...</think>` 思考过程与正文输出，兼容跨 chunk 拆分的标签。
 */
export function createThinkStreamSplitter(
  onText: (chunk: string) => void,
  onReasoning?: (chunk: string) => void,
) {
  let inThink = false;
  let pending = '';
  let fullText = '';
  let fullReasoning = '';

  const emitText = (s: string) => {
    if (!s) return;
    fullText += s;
    onText(s);
  };

  const emitReasoning = (s: string) => {
    if (!s) return;
    fullReasoning += s;
    onReasoning?.(s);
  };

  const OPEN_TAG = '<think>';
  const CLOSE_TAG = '</think>';

  const pushText = (chunk: string) => {
    if (!chunk) return;
    pending += chunk;

    while (pending.length > 0) {
      const targetTag = inThink ? CLOSE_TAG : OPEN_TAG;
      const idx = pending.toLowerCase().indexOf(targetTag);
      if (idx >= 0) {
        const before = pending.slice(0, idx);
        if (inThink) emitReasoning(before);
        else emitText(before);
        pending = pending.slice(idx + targetTag.length);
        inThink = !inThink;
        continue;
      }

      // 保留可能构成不完整标签前缀的尾部字符，避免提前输出半个标签
      let holdLen = 0;
      const lowerPending = pending.toLowerCase();
      const maxCheck = Math.min(pending.length, targetTag.length - 1);
      for (let len = maxCheck; len >= 1; len--) {
        if (lowerPending.endsWith(targetTag.slice(0, len))) {
          holdLen = len;
          break;
        }
      }

      const safePart = holdLen > 0 ? pending.slice(0, pending.length - holdLen) : pending;
      if (inThink) emitReasoning(safePart);
      else emitText(safePart);
      pending = holdLen > 0 ? pending.slice(pending.length - holdLen) : '';
      break;
    }
  };

  const pushReasoning = (chunk: string) => {
    emitReasoning(chunk);
  };

  const flush = () => {
    if (pending) {
      if (inThink) emitReasoning(pending);
      else emitText(pending);
      pending = '';
    }
    return {
      content: fullText,
      reasoningContent: fullReasoning,
    };
  };

  return { pushText, pushReasoning, flush };
}

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata',
  'fd00:ec2::254',
]);

export class AIAnalyzerService {
  private app: Application;
  private configService?: LogConfigService;
  private latestInspectionCache: any = null;
  private collectionReady = false;

  constructor(app: Application, configService?: LogConfigService) {
    this.app = app;
    this.configService = configService;
  }

  setConfigService(configService: LogConfigService) {
    this.configService = configService;
  }

  private getAllowPrivateLLM(): boolean {
    if (this.configService) {
      return this.configService.getBoolean(CONFIG_KEYS.AI_ALLOW_PRIVATE_LLM, true);
    }
    return process.env.LOGGER_PRO_ALLOW_PRIVATE_LLM !== 'false';
  }

  private getDefaultSanitize(): boolean {
    if (this.configService) {
      return this.configService.getBoolean(CONFIG_KEYS.AI_DEFAULT_SANITIZE, true);
    }
    return true;
  }

  private getDefaultTimeoutMs(): number {
    if (this.configService) {
      const val = this.configService.getNumber(CONFIG_KEYS.AI_REQUEST_TIMEOUT_MS, 45000);
      return Math.min(Math.max(val, 3000), 180000);
    }
    return 45000;
  }

  private getDefaultEmployeeName(): string {
    const val = this.configService?.get?.(CONFIG_KEYS.AI_DEFAULT_EMPLOYEE);
    return (val && String(val).trim()) || 'system-error-expert';
  }

  private createErrorWithCode(message: string, code: 'LLM_NOT_CONFIGURED' | 'LLM_CALL_FAILED' | 'INVALID_INPUT'): Error {
    const err = new Error(message) as Error & { code?: string };
    err.code = code;
    return err;
  }

  /**
   * 校验 LLM baseURL 安全性：
   * 1. 仅允许 http / https 协议；
   * 2. 始终阻断云厂商元数据地址 (169.254.169.254 等)；
   * 3. 当 ai_allow_private_llm 开启（默认）时，信任管理员在 llm_services 中配置的 localhost/内网地址 (Ollama 等)；
   *    关闭时阻断私有/环回地址。
   */
  public assertSafeLLMUrl(rawUrl: string): URL {
    const urlObj = new URL(rawUrl);
    if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
      throw new Error(`LLM baseURL 协议不允许: ${urlObj.protocol}`);
    }
    const host = urlObj.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (BLOCKED_METADATA_HOSTS.has(host)) {
      throw new Error(`LLM baseURL 指向受禁的云元数据地址: ${host}`);
    }
    if (!this.getAllowPrivateLLM() && isPrivateOrReservedHost(host)) {
      throw new Error(`LLM baseURL 指向私有/环回地址，已在插件配置中禁止: ${host}`);
    }
    return urlObj;
  }

  private normalizeChatCompletionsUrl(baseURL: string, provider = ''): string {
    const rawUrl = baseURL.trim().replace(/\/+$/, '');
    if (rawUrl.endsWith('/chat/completions')) {
      return rawUrl;
    }
    // Ollama 原生根地址 (如 http://localhost:11434) 兼容补全 /v1/chat/completions
    if (provider.includes('ollama') && !rawUrl.endsWith('/v1') && !rawUrl.includes('/v1/')) {
      return `${rawUrl}/v1/chat/completions`;
    }
    return `${rawUrl}/chat/completions`;
  }

  // 1. 获取 AI 员工列表 (内置错误分析专家 + 系统后台已配置的 AI 员工)
  async getAvailableEmployees() {
    const list: Array<{
      name: string;
      title: string;
      role?: string;
      avatar?: string;
      systemPrompt?: string;
      configuredModel?: string;
    }> = [];

    list.push({
      name: 'system-error-expert',
      title: '🛡️ 系统错误分析专家 (内置专家)',
      role: '专长于 Node.js 运行时异常、空指针、中间件流转与数据库错误诊断',
      systemPrompt: `你是一名资深的 NocoBase 和 Node.js 全栈系统架构师与错误诊断专家。请对系统错误日志和调用堆栈进行深度诊断分析，严格按照 Markdown 格式输出：
### 🤖 AI 智能诊断分析报告
#### 🔍 1. 故障摘要与根因定位 (Root Cause)
#### 🧭 2. 受影响模块与代码调用链分析
#### 🛠️ 3. 解决方案与修复建议 (含代码示例)
#### 🛡️ 4. 预防措施与长效建议`,
    });

    try {
      const repo = this.app.db.getRepository('aiEmployees');
      if (repo) {
        const records = await repo.find();
        for (const r of records) {
          const username = r.username || r.name;
          if (!username) continue;

          let modelDesc = '';
          if (r.modelSettings?.llmService && r.modelSettings?.model) {
            modelDesc = `${r.modelSettings.llmService}/${r.modelSettings.model}`;
          } else if (Array.isArray(r.modelSettings?.models) && r.modelSettings.models.length > 0) {
            modelDesc = `${r.modelSettings.models[0].llmService}/${r.modelSettings.models[0].model}`;
          }

          list.push({
            name: username,
            title: `🤖 ${r.nickname || r.name || username} (AI 员工)`,
            role: r.role || r.description || 'NocoBase 系统 AI 员工',
            avatar: r.avatar,
            systemPrompt: r.systemPrompt,
            configuredModel: modelDesc,
          });
        }
      }
    } catch {}

    return list;
  }

  // 2. 获取系统中已配置的真实 LLM 服务列表
  async getAvailableLLMServices() {
    const servicesList: Array<{
      llmService: string;
      llmServiceTitle: string;
      provider: string;
      enabledModels: Array<{ label: string; value: string }>;
    }> = [];

    try {
      const repo = this.app.db.getRepository('llmServices') || this.app.db.getRepository('llm_services');
      let records: any[] = [];
      if (repo) {
        records = await repo.find();
      } else if (this.app.db.sequelize) {
        const [rows] = await this.app.db.sequelize.query('SELECT * FROM llm_services');
        records = rows || [];
      }

      for (const r of records) {
        const serviceName = r.name || r.id || r.key;
        if (!serviceName) continue;

        const provider = String(r.provider || r.llmType || r.type || 'openai');
        const title = r.title || r.name || provider;
        const options = typeof r.options === 'string' ? (() => { try { return JSON.parse(r.options); } catch { return {}; } })() : (r.options || {});
        const raw = r.enabledModels || r.models || options.models || options.enabledModels;
        const modelsList: Array<{ label: string; value: string }> = [];

        if (Array.isArray(raw) && raw.length > 0) {
          for (const m of raw) {
            const val = typeof m === 'string' ? m : m?.value || m?.model || m?.name;
            const lbl = (typeof m === 'object' && (m?.label || m?.name)) ? (m.label || m.name) : val;
            if (val) {
              modelsList.push({ label: lbl, value: val });
            }
          }
        } else if (raw && typeof raw === 'object') {
          const list = Array.isArray(raw.models) ? raw.models : [];
          for (const m of list) {
            const val = typeof m === 'string' ? m : m?.value || m?.model || m?.name;
            const lbl = (typeof m === 'object' && (m?.label || m?.name)) ? (m.label || m.name) : val;
            if (val) {
              modelsList.push({ label: lbl, value: val });
            }
          }
        }

        if (modelsList.length === 0) {
          modelsList.push({
            label: `${title}`,
            value: options.model || options.defaultModel || 'default',
          });
        }

        servicesList.push({
          llmService: serviceName,
          llmServiceTitle: title,
          provider,
          enabledModels: modelsList,
        });
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] getAvailableLLMServices query error: ${err.message}`);
    }

    return servicesList;
  }

  // 解析数据库中配置的 LLM 服务连接参数
  private async resolveDirectLLMConfig(targetService: string, targetModel?: string) {
    const repo = this.app.db.getRepository('llmServices') || this.app.db.getRepository('llm_services');
    let record: any = null;
    if (repo) {
      record = await repo.findOne({ filter: { name: targetService } });
      if (!record && /^\d+$/.test(String(targetService))) {
        try {
          record = await repo.findOne({ filter: { id: Number(targetService) } });
        } catch {}
      }
    } else if (this.app.db.sequelize) {
      const isNumericId = /^\d+$/.test(String(targetService));
      const [rows]: any = isNumericId
        ? await this.app.db.sequelize.query(
            'SELECT * FROM llm_services WHERE name = ? OR id = ? LIMIT 1',
            { replacements: [targetService, Number(targetService)] },
          )
        : await this.app.db.sequelize.query(
            'SELECT * FROM llm_services WHERE name = ? LIMIT 1',
            { replacements: [targetService] },
          );
      record = rows?.[0] || null;
    }

    if (!record) return null;

    const options = typeof record.options === 'string'
      ? (() => { try { return JSON.parse(record.options); } catch { return {}; } })()
      : (record.options || {});
    const apiKey = String(options.apiKey || options.api_key || options.key || '').trim();
    let baseURL = String(options.baseURL || options.base_url || options.endpoint || options.url || '').trim();
    const provider = String(record.provider || record.llmType || record.type || record.title || '').toLowerCase();

    if (!baseURL) {
      if (provider.includes('dashscope') || provider.includes('aliyun') || provider.includes('qwen')) {
        baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      } else if (provider.includes('deepseek')) {
        baseURL = 'https://api.deepseek.com/v1';
      } else if (provider.includes('openai')) {
        baseURL = 'https://api.openai.com/v1';
      } else if (provider.includes('zhipu')) {
        baseURL = 'https://open.bigmodel.cn/api/paas/v4';
      } else if (provider.includes('ollama')) {
        baseURL = 'http://localhost:11434/v1';
      }
    }

    let effectiveModel = targetModel;
    if (!effectiveModel || effectiveModel === 'default') {
      effectiveModel =
        options.model ||
        options.defaultModel ||
        (provider.includes('dashscope') ? 'qwen-plus' : provider.includes('ollama') ? 'llama3' : 'gpt-4o-mini');
    }

    return {
      record,
      provider,
      baseURL,
      apiKey,
      effectiveModel: String(effectiveModel),
      title: record.title || targetService,
    };
  }

  // 通用 OpenAI 兼容协议同步 HTTP 请求
  private async callOpenAICompatible(
    baseURL: string,
    apiKey: string,
    modelName: string,
    messages: Array<{ role: string; content: string }>,
    options: { timeoutMs?: number; provider?: string } = {},
  ): Promise<string> {
    const apiUrl = this.normalizeChatCompletionsUrl(baseURL, options.provider);
    const urlObj = this.assertSafeLLMUrl(apiUrl);
    const timeoutMs = options.timeoutMs || this.getDefaultTimeoutMs();

    const postData = JSON.stringify({
      model: modelName,
      messages,
      temperature: 0.2,
    });

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    };
    if (apiKey && apiKey.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    return new Promise((resolve, reject) => {
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;

      const req = lib.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: `${urlObj.pathname}${urlObj.search}`,
          method: 'POST',
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                const reply = parsed.choices?.[0]?.message?.content ?? parsed.message?.content ?? data;
                resolve(typeof reply === 'string' ? reply : JSON.stringify(reply));
              } catch {
                resolve(data);
              }
            } else {
              reject(new Error(`大模型接口响应失败 (HTTP ${res.statusCode}): ${data.slice(0, 300)}`));
            }
          });
        },
      );

      req.on('error', (err) => {
        reject(new Error(`连接大模型接口失败: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`请求大模型服务响应超时 (${Math.round(timeoutMs / 1000)}s)`));
      });

      req.write(postData);
      req.end();
    });
  }

  // 通用 OpenAI 兼容协议流式 HTTP 请求 (SSE)
  private async callOpenAICompatibleStream(
    baseURL: string,
    apiKey: string,
    modelName: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    options: { timeoutMs?: number; provider?: string; onReasoning?: (chunk: string) => void } = {},
  ): Promise<{ content: string; reasoningContent: string }> {
    const apiUrl = this.normalizeChatCompletionsUrl(baseURL, options.provider);
    const urlObj = this.assertSafeLLMUrl(apiUrl);
    const timeoutMs = options.timeoutMs || this.getDefaultTimeoutMs();

    const postData = JSON.stringify({
      model: modelName,
      messages,
      temperature: 0.2,
      stream: true,
    });

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(postData),
    };
    if (apiKey && apiKey.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    return new Promise((resolve, reject) => {
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;
      const splitter = createThinkStreamSplitter(onChunk, options.onReasoning);
      let hasStreamEvent = false;
      let buffer = '';
      let nonStreamBody = '';

      const req = lib.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: `${urlObj.pathname}${urlObj.search}`,
          method: 'POST',
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = '';
            res.on('data', (c) => (errBody += c));
            res.on('end', () => {
              reject(new Error(`大模型流式接口响应失败 (HTTP ${res.statusCode}): ${errBody.slice(0, 300)}`));
            });
            return;
          }

          const contentType = String(res.headers['content-type'] || '');
          const isSSE = contentType.includes('text/event-stream') || contentType.includes('stream');

          res.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            if (!isSSE && !text.includes('data:')) {
              nonStreamBody += text;
              return;
            }
            buffer += text;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const parsed = JSON.parse(payload);
                const reasoningDelta =
                  parsed.choices?.[0]?.delta?.reasoning_content ??
                  parsed.choices?.[0]?.delta?.reasoning ??
                  parsed.choices?.[0]?.delta?.thinking ??
                  parsed.choices?.[0]?.message?.reasoning_content ??
                  parsed.message?.thinking ??
                  '';
                if (typeof reasoningDelta === 'string' && reasoningDelta) {
                  hasStreamEvent = true;
                  splitter.pushReasoning(reasoningDelta);
                }

                const delta =
                  parsed.choices?.[0]?.delta?.content ??
                  parsed.choices?.[0]?.message?.content ??
                  parsed.message?.content ??
                  '';
                if (typeof delta === 'string' && delta) {
                  hasStreamEvent = true;
                  splitter.pushText(delta);
                }
              } catch {}
            }
          });

          res.on('end', () => {
            if (nonStreamBody && !hasStreamEvent) {
              try {
                const parsed = JSON.parse(nonStreamBody);
                const reasoning =
                  parsed.choices?.[0]?.message?.reasoning_content ??
                  parsed.choices?.[0]?.message?.reasoning ??
                  parsed.message?.thinking ??
                  '';
                if (typeof reasoning === 'string' && reasoning) {
                  splitter.pushReasoning(reasoning);
                }
                const reply = parsed.choices?.[0]?.message?.content ?? parsed.message?.content ?? nonStreamBody;
                splitter.pushText(typeof reply === 'string' ? reply : JSON.stringify(reply));
              } catch {
                splitter.pushText(nonStreamBody);
              }
            }
            resolve(splitter.flush());
          });
        },
      );

      req.on('error', (err) => {
        reject(new Error(`连接大模型流式接口失败: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`请求大模型流式服务响应超时 (${Math.round(timeoutMs / 1000)}s)`));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * 统一调用 LLM（同步）：优先 NocoBase aiManager，失败后直连 llm_services
   */
  private async invokeLLM(
    messages: Array<{ role: string; content: string }>,
    llmSelection?: LLMServiceSelection,
    timeoutMs?: number,
  ): Promise<{ content: string; serviceTitle: string; usedService: string; usedModel: string } | null> {
    const targetService = llmSelection?.llmService;
    const targetModel = llmSelection?.model || 'default';
    if (!targetService) return null;

    const effectiveTimeout = timeoutMs || this.getDefaultTimeoutMs();

    const withTimeout = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`请求大模型服务响应超时 (${Math.round(effectiveTimeout / 1000)}s)`)), effectiveTimeout),
        ),
      ]);

    // 方式 A: @nocobase/plugin-ai aiManager
    try {
      const aiPlugin: any = this.app.pm.get('@nocobase/plugin-ai') || this.app.pm.get('ai');
      if (aiPlugin && aiPlugin.aiManager) {
        const serviceInstance = await aiPlugin.aiManager.getLLMService({
          llmService: targetService,
          model: targetModel === 'default' ? undefined : targetModel,
        });

        if (serviceInstance && serviceInstance.provider) {
          const chatModel = serviceInstance.provider.chatModel({
            model: targetModel === 'default' ? undefined : targetModel,
            temperature: 0.2,
          });
          if (chatModel && typeof chatModel.invoke === 'function') {
            const response: any = await withTimeout(chatModel.invoke(messages));
            const content = typeof response?.content === 'string' ? response.content : JSON.stringify(response?.content ?? '');
            return {
              content,
              serviceTitle: targetService,
              usedService: targetService,
              usedModel: targetModel,
            };
          }
        }
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] aiManager.getLLMService failed (${err.message}), trying direct DB call`);
    }

    // 方式 B: 直连 llm_services 表配置
    const cfg = await this.resolveDirectLLMConfig(targetService, targetModel);
    if (cfg && cfg.baseURL) {
      const content = await this.callOpenAICompatible(
        cfg.baseURL,
        cfg.apiKey,
        cfg.effectiveModel,
        messages,
        { timeoutMs: effectiveTimeout, provider: cfg.provider },
      );
      return {
        content,
        serviceTitle: cfg.title,
        usedService: targetService,
        usedModel: cfg.effectiveModel,
      };
    }

    throw new Error(`LLM 服务 "${targetService}" 缺少有效的 baseURL 或 API 连接配置，请前往 NocoBase 管理后台检查 LLM 服务配置`);
  }

  /**
   * 统一调用 LLM（流式）：优先 aiManager.stream -> direct SSE stream -> 同步降级分块
   */
  private async invokeLLMStream(
    messages: Array<{ role: string; content: string }>,
    llmSelection: LLMServiceSelection | undefined,
    onChunk: (chunk: string) => void,
    timeoutMs?: number,
    onReasoning?: (chunk: string) => void,
  ): Promise<{ content: string; reasoningContent?: string; serviceTitle: string; usedService: string; usedModel: string } | null> {
    const targetService = llmSelection?.llmService;
    const targetModel = llmSelection?.model || 'default';
    if (!targetService) return null;

    const effectiveTimeout = timeoutMs || this.getDefaultTimeoutMs();
    const withTimeout = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`请求大模型流式服务响应超时 (${Math.round(effectiveTimeout / 1000)}s)`)), effectiveTimeout),
        ),
      ]);

    const feedModelPart = (part: any, splitter: ReturnType<typeof createThinkStreamSplitter>) => {
      const reasoning =
        part?.additional_kwargs?.reasoning_content ??
        part?.additional_kwargs?.reasoning ??
        part?.reasoning_content ??
        part?.response_metadata?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) {
        splitter.pushReasoning(reasoning);
      }

      if (typeof part?.content === 'string') {
        splitter.pushText(part.content);
      } else if (Array.isArray(part?.content)) {
        for (const block of part.content) {
          if (block?.type === 'thinking' && typeof block?.thinking === 'string') {
            splitter.pushReasoning(block.thinking);
          } else if (block?.type === 'reasoning' && typeof block?.reasoning === 'string') {
            splitter.pushReasoning(block.reasoning);
          } else if (typeof block?.text === 'string') {
            splitter.pushText(block.text);
          } else if (typeof block === 'string') {
            splitter.pushText(block);
          }
        }
      }
    };

    // 方式 A: aiManager stream
    try {
      const aiPlugin: any = this.app.pm.get('@nocobase/plugin-ai') || this.app.pm.get('ai');
      if (aiPlugin && aiPlugin.aiManager) {
        const serviceInstance = await aiPlugin.aiManager.getLLMService({
          llmService: targetService,
          model: targetModel === 'default' ? undefined : targetModel,
        });

        if (serviceInstance && serviceInstance.provider) {
          const chatModel = serviceInstance.provider.chatModel({
            model: targetModel === 'default' ? undefined : targetModel,
            temperature: 0.2,
          });

          if (chatModel && typeof chatModel.stream === 'function') {
            const splitter = createThinkStreamSplitter(onChunk, onReasoning);
            const result = await withTimeout(
              (async () => {
                const stream = await chatModel.stream(messages);
                for await (const part of stream) {
                  feedModelPart(part, splitter);
                }
                return splitter.flush();
              })(),
            );
            if (result.content) {
              return {
                content: result.content,
                reasoningContent: result.reasoningContent || undefined,
                serviceTitle: targetService,
                usedService: targetService,
                usedModel: targetModel,
              };
            }
          } else if (chatModel && typeof chatModel.invoke === 'function') {
            const splitter = createThinkStreamSplitter(onChunk, onReasoning);
            const response: any = await withTimeout(chatModel.invoke(messages));
            feedModelPart(response, splitter);
            const result = splitter.flush();
            const content =
              result.content ||
              (typeof response?.content === 'string' ? response.content : JSON.stringify(response?.content ?? ''));
            return {
              content,
              reasoningContent: result.reasoningContent || undefined,
              serviceTitle: targetService,
              usedService: targetService,
              usedModel: targetModel,
            };
          }
        }
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] aiManager stream failed (${err.message}), trying direct SSE`);
    }

    // 方式 B: 直连 SSE 流式
    const cfg = await this.resolveDirectLLMConfig(targetService, targetModel);
    if (cfg && cfg.baseURL) {
      const result = await this.callOpenAICompatibleStream(
        cfg.baseURL,
        cfg.apiKey,
        cfg.effectiveModel,
        messages,
        onChunk,
        { timeoutMs: effectiveTimeout, provider: cfg.provider, onReasoning },
      );
      return {
        content: result.content,
        reasoningContent: result.reasoningContent || undefined,
        serviceTitle: cfg.title,
        usedService: targetService,
        usedModel: cfg.effectiveModel,
      };
    }

    throw new Error(`LLM 服务 "${targetService}" 缺少有效的 baseURL 或 API 连接配置，请前往 NocoBase 管理后台检查 LLM 服务配置`);
  }

  // 解析 AI 员工信息与 System Prompt
  private async resolveEmployeePrompt(employeeName = 'system-error-expert') {
    let employeeTitle = '🛡️ 系统错误分析专家';
    let systemPrompt = `你是一名资深的 NocoBase 和 Node.js 全栈系统架构师与错误诊断专家。请对系统错误日志和调用堆栈进行深度诊断分析，严格按照 Markdown 格式输出结构化报告：
### 🤖 AI 智能诊断分析报告
#### 🔍 1. 故障摘要与根因定位 (Root Cause)
#### 🧭 2. 受影响模块与代码调用链分析
#### 🛠️ 3. 解决方案与修复建议 (含代码示例)
#### 🛡️ 4. 预防措施与长效建议`;

    if (employeeName && employeeName !== 'system-error-expert') {
      try {
        const repo = this.app.db.getRepository('aiEmployees');
        const emp = await repo?.findOne({ filter: { username: employeeName } }) || await repo?.findOne({ filter: { name: employeeName } });
        if (emp) {
          employeeTitle = emp.nickname || emp.name || employeeName;
          if (emp.systemPrompt) {
            systemPrompt = emp.systemPrompt;
          }
        }
      } catch {}
    }

    return { employeeTitle, systemPrompt };
  }

  // 预处理日志文本（脱敏 + 智能压缩）
  public prepareLogForAI(logText: string, sanitize?: boolean) {
    const shouldSanitize = sanitize !== undefined ? sanitize : this.getDefaultSanitize();
    const sanitizeRes = shouldSanitize
      ? sanitizeLogText(logText)
      : { sanitized: logText, maskedCount: 0, maskedTypes: [] as string[] };
    const compressRes = compressLogContext(sanitizeRes.sanitized, 6000);
    return {
      processedText: compressRes.compressed,
      sanitizedText: sanitizeRes.sanitized,
      maskedCount: sanitizeRes.maskedCount,
      maskedTypes: sanitizeRes.maskedTypes,
      compressedStats: {
        originalLength: compressRes.originalLength,
        compressedLength: compressRes.compressedLength,
        deduplicatedLines: compressRes.deduplicatedLines,
      },
    };
  }

  // 内置专家知识库保底分析
  private runHeuristicAnalysis(logText: string, context?: any): string {
    const lines = logText.split(/\r?\n/).filter((l) => l.trim());
    const contextSummary = context
      ? `\n\n> 🌐 **关联请求上下文**: \`${context.method || 'GET'} ${context.path || '-'}\` (ReqId: \`${context.reqId || '-'}\`)\n`
      : '';

    if (/Cannot read properties of undefined \(reading 'repository'\)|Cannot read properties of undefined \(reading 'getRepository'\)/i.test(logText)) {
      return `### 🤖 AI 智能诊断分析报告
${contextSummary}
#### 🔍 1. 故障摘要与根因定位 (Root Cause)
- **错误类型**: \`TypeError: Cannot read properties of undefined (reading 'repository')\`
- **根本原因**:
  1. 系统在执行认证中间件或业务逻辑时，尝试从 \`app.db\` 获取 Repository，但此时目标数据表或数据库实例尚未加载完成；
  2. 常见于系统热重载重启期间客户端发起并发鉴权请求，或者插件在 \`beforeLoad\` 阶段提前访问了数据库。

#### 🧭 2. 受影响模块与调用链分析
- **涉及模块**: \`@nocobase/plugin-auth\` / \`@nocobase/database\`
- **触发函数**: \`getUserRepository\` -> \`BasicAuth.checkToken\` -> \`AsyncEmitter\`

#### 🛠️ 3. 解决方案与修复建议
1. 若在开发环境频繁热重载，请等待控制台输出 \`app has been started\` 后再刷新页面；
2. 在获取 repository 前增加防御性判定：
\`\`\`typescript
const repo = app.db?.getRepository('users');
if (!repo) {
  throw new Error('Database repository "users" is not ready yet');
}
\`\`\``;
    }

    if (/Cannot read properties of undefined \(reading 'getConfig'\)/i.test(logText)) {
      return `### 🤖 AI 智能诊断分析报告
${contextSummary}
#### 🔍 1. 故障摘要与根因定位 (Root Cause)
- **错误类型**: \`TypeError: Cannot read properties of undefined (reading 'getConfig')\`
- **根本原因**: 插件在处理 Token 校验或配置读取时，所依赖的 ConfigService 或 Auth 认证对象为 \`undefined\`；常见于未在后台初始化配置对应的身份验证器实例。

#### 🧭 2. 受影响模块与代码链
- **涉及模块**: \`@nocobase/plugin-auth\`
- **触发链路**: \`BasicAuth.checkToken\`

#### 🛠️ 3. 解决方案与修复建议
1. 进入 NocoBase 管理后台 -> **【用户认证】**，检查基础认证方式是否已启用并保存配置；
2. 为 \`getConfig\` 增加可选链保底：\`const config = authInstance?.getConfig?.() || {};\``;
    }

    if (/Workflow pre-action.*collection.*not found/i.test(logText)) {
      return `### 🤖 AI 智能诊断分析报告
${contextSummary}
#### 🔍 1. 故障摘要与根因定位 (Root Cause)
- **警告类型**: \`[Workflow pre-action]: collection "xxx" not found\`
- **根本原因**: 工作流触发器监听了某个数据表的操作事件，但当前请求访问的模块并不是真实的数据表集合，导致工作流前置拦截器未在数据库中找到匹配的 Collection。

#### 🛠️ 2. 解决方案与建议
- 此类日志通常为 NocoBase 工作流前置检查的常规非致命 \`[warn]\`，系统会自动跳过无匹配 Collection 的请求；
- 可检查工作流触发配置，将其限定在明确的数据表集合范围内。`;
    }

    if (logText.includes('【全链路请求生命周期全景诊断】') || (context && context.reqId)) {
      const isSuccess = context?.statusCode ? context.statusCode < 400 : !logText.includes('[error]');
      const sqlCount = context?.sqlQueries?.length || (logText.match(/SELECT|INSERT|UPDATE|DELETE/gi) || []).length;
      const duration = context?.durationMs !== undefined ? `${context.durationMs} ms` : '正常响应';

      return `### 🤖 AI 全链路生命周期智能诊断报告
${contextSummary}
#### 🌐 1. 请求画像与生命周期健康度
- **请求接口**: \`${context?.method || 'POST'} ${context?.path || '-'}\`
- **处理状态**: \`${isSuccess ? '✅ 请求正常响应 (HTTP ' + (context?.statusCode || 200) + ')' : '❌ 请求处理异常'}\`
- **总处理耗时**: \`${duration}\` ${Number(context?.durationMs) > 1000 ? '⚠️ (耗时偏高，存在慢查或阻塞)' : '⚡ (响应极为迅速)'}
- **操作者身份**: \`${context?.username || 'nocobase'}\` (IP: \`${context?.ip || '-'}\`)

#### 🗄️ 2. 数据库 SQL 与数据层交互分析
- **执行 SQL 数量**: \`${sqlCount} 条查询\`
${context?.sqlQueries && context.sqlQueries.length > 0 ? context.sqlQueries.slice(0, 3).map((s: string) => `- \`${s}\``).join('\n') : '- 当前请求主要完成元数据/路由解析，未产生额外的重型慢 SQL。'}

#### 💡 3. 架构调优与长效建议
1. 对于高频元数据接口可开启短时缓存以降低并发开销；
2. 该操作已被系统操作审计模块完整捕获留痕。`;
    }

    const errorMatch = logText.match(/Error:\s*([^\r\n]+)/i) || logText.match(/\[error\]\s*([^\r\n]+)/i) || logText.match(/\[warn\]\s*([^\r\n]+)/i);
    const errorTitle = errorMatch ? errorMatch[1] : '系统未捕获日志特征';

    return `### 🤖 AI 智能诊断分析报告
${contextSummary}
#### 🔍 1. 故障摘要与特征分析
- **日志特征**: \`${errorTitle}\`
- **日志行数**: \`${lines.length} 行堆栈信息\`

#### 🧭 2. 调用堆栈与模块分析
${lines.slice(0, 6).map((l) => `- \`${l.trim()}\``).join('\n')}

#### 🛠️ 3. 排查建议
1. 检查日志中相关的接口请求参数与上下文；
2. 确认相关依赖服务（数据库、缓存、第三方服务）连通性；
3. 查看关联的【全链路追踪】，确认在报错前最后执行的 SQL 查询或中间件流转情况。`;
  }

  // 确保 logger_ai_records 集合与表结构已就绪
  private async ensureCollection() {
    if (this.collectionReady) return;

    try {
      const collection = this.app.db.getCollection('logger_ai_records');
      if (collection) {
        await collection.sync();
        this.collectionReady = true;
        return;
      }
    } catch {}

    try {
      if (this.app.db.sequelize) {
        const dialect = this.app.db.sequelize?.getDialect?.() || 'sqlite';
        let ddl: string;
        if (dialect === 'mysql' || dialect === 'mariadb') {
          ddl = `CREATE TABLE IF NOT EXISTS logger_ai_records (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            analyzerName VARCHAR(255),
            employeeName VARCHAR(255),
            llmService VARCHAR(255),
            model VARCHAR(255),
            logSummary VARCHAR(255),
            logText LONGTEXT,
            context LONGTEXT,
            analysisReport LONGTEXT,
            messages LONGTEXT,
            recordType VARCHAR(64) DEFAULT 'log_analysis',
            durationMs BIGINT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
          )`;
        } else if (dialect === 'postgres') {
          ddl = `CREATE TABLE IF NOT EXISTS logger_ai_records (
            id SERIAL PRIMARY KEY,
            analyzerName VARCHAR(255),
            employeeName VARCHAR(255),
            llmService VARCHAR(255),
            model VARCHAR(255),
            logSummary VARCHAR(255),
            logText TEXT,
            context TEXT,
            analysisReport TEXT,
            messages TEXT,
            recordType VARCHAR(64) DEFAULT 'log_analysis',
            durationMs BIGINT,
            createdAt TIMESTAMPTZ DEFAULT NOW(),
            updatedAt TIMESTAMPTZ DEFAULT NOW()
          )`;
        } else {
          ddl = `CREATE TABLE IF NOT EXISTS logger_ai_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            analyzerName VARCHAR(255),
            employeeName VARCHAR(255),
            llmService VARCHAR(255),
            model VARCHAR(255),
            logSummary VARCHAR(255),
            logText TEXT,
            context TEXT,
            analysisReport TEXT,
            messages TEXT,
            recordType VARCHAR(64) DEFAULT 'log_analysis',
            durationMs INTEGER,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
          )`;
        }
        await this.app.db.sequelize.query(ddl);
        this.collectionReady = true;
      }
    } catch {}
  }

  // 保存一条 AI 诊断记录
  private async saveAnalysisRecord(data: {
    analyzerName: string;
    employeeName?: string;
    llmService?: string;
    model?: string;
    logSummary?: string;
    logText: string;
    context?: any;
    analysisReport: string;
    messages?: ChatMessageItem[];
    recordType?: string;
    durationMs: number;
  }) {
    await this.ensureCollection();
    try {
      const repo = this.app.db.getRepository('logger_ai_records');
      const firstLine = (data.logText || '').split(/\r?\n/).find((l) => l.trim()) || '错误日志诊断';
      const logSummary = (data.logSummary || firstLine).slice(0, 150);

      if (repo) {
        const created = await repo.create({
          values: {
            analyzerName: data.analyzerName,
            employeeName: data.employeeName || 'system-error-expert',
            llmService: data.llmService || 'builtin',
            model: data.model || 'default',
            logSummary,
            logText: data.logText,
            context: data.context || null,
            analysisReport: data.analysisReport,
            messages: data.messages || [],
            recordType: data.recordType || 'log_analysis',
            durationMs: data.durationMs,
          },
        });
        return created?.id;
      } else if (this.app.db.sequelize) {
        const [res] = await this.app.db.sequelize.query(
          `INSERT INTO logger_ai_records (analyzerName, employeeName, llmService, model, logSummary, logText, analysisReport, messages, recordType, durationMs, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          {
            replacements: [
              data.analyzerName,
              data.employeeName || 'system-error-expert',
              data.llmService || 'builtin',
              data.model || 'default',
              logSummary,
              data.logText,
              data.analysisReport,
              JSON.stringify(data.messages || []),
              data.recordType || 'log_analysis',
              data.durationMs,
              new Date(),
              new Date(),
            ],
          },
        );
        return res;
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] Failed to save AI record: ${err.message}`);
    }
    return null;
  }

  // 更新记录的 messages（多轮对话持久化）
  private async updateRecordMessages(recordId: string | number, messages: ChatMessageItem[]) {
    if (recordId === undefined || recordId === null || recordId === '') return;
    await this.ensureCollection();
    try {
      const repo = this.app.db.getRepository('logger_ai_records');
      if (repo) {
        await repo.update({
          filterByTk: recordId,
          values: { messages },
        });
      } else if (this.app.db.sequelize) {
        await this.app.db.sequelize.query(
          'UPDATE logger_ai_records SET messages = ?, updatedAt = ? WHERE id = ?',
          { replacements: [JSON.stringify(messages), new Date(), recordId] },
        );
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] Failed to update AI messages: ${err.message}`);
    }
  }

  // 获取 AI 诊断历史记录列表
  async getAnalysisHistory(options: { page?: number; pageSize?: number; recordType?: string } = {}) {
    const page = Math.max(Number(options.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(options.pageSize) || 20, 1), 100);
    await this.ensureCollection();
    const LIST_FIELDS = ['id', 'analyzerName', 'employeeName', 'llmService', 'model', 'logSummary', 'recordType', 'durationMs', 'createdAt'];
    try {
      const repo = this.app.db.getRepository('logger_ai_records');
      if (repo) {
        const filter: any = {};
        if (options.recordType) filter.recordType = options.recordType;
        const [rows, count] = await repo.findAndCount({
          fields: LIST_FIELDS,
          filter,
          sort: ['-createdAt', '-id'],
          offset: (page - 1) * pageSize,
          limit: pageSize,
        });
        return { rows, count, page, pageSize };
      } else if (this.app.db.sequelize) {
        const whereSql = options.recordType ? 'WHERE recordType = ?' : '';
        const replacements = options.recordType ? [options.recordType] : [];
        const [rows]: any = await this.app.db.sequelize.query(
          `SELECT ${LIST_FIELDS.join(', ')} FROM logger_ai_records ${whereSql} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
          { replacements },
        );
        const [countRes]: any = await this.app.db.sequelize.query(
          `SELECT count(*) as total FROM logger_ai_records ${whereSql}`,
          { replacements },
        );
        const count = countRes?.[0]?.total || rows.length;
        return { rows, count, page, pageSize };
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] getAnalysisHistory error: ${err.message}`);
    }
    return { rows: [], count: 0, page, pageSize };
  }

  // 按 id 读取单条诊断记录全文
  async getAnalysisRecord(id: string | number) {
    if (id === undefined || id === null || id === '') return null;
    await this.ensureCollection();
    try {
      const repo = this.app.db.getRepository('logger_ai_records');
      if (repo) {
        const rec = await repo.findOne({ filterByTk: id });
        if (rec && typeof rec.messages === 'string') {
          try { rec.messages = JSON.parse(rec.messages); } catch { rec.messages = []; }
        }
        return rec;
      } else if (this.app.db.sequelize) {
        const [rows]: any = await this.app.db.sequelize.query('SELECT * FROM logger_ai_records WHERE id = ? LIMIT 1', {
          replacements: [id],
        });
        const rec = rows?.[0] || null;
        if (rec && typeof rec.messages === 'string') {
          try { rec.messages = JSON.parse(rec.messages); } catch { rec.messages = []; }
        }
        return rec;
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] getAnalysisRecord error: ${err.message}`);
    }
    return null;
  }

  async deleteAnalysisRecord(id: string | number) {
    if (id === undefined || id === null || id === '') return false;
    await this.ensureCollection();
    try {
      const repo = this.app.db.getRepository('logger_ai_records');
      if (repo) {
        await repo.destroy({ filter: { id } });
        return true;
      } else if (this.app.db.sequelize) {
        await this.app.db.sequelize.query('DELETE FROM logger_ai_records WHERE id = ?', { replacements: [id] });
        return true;
      }
    } catch {}
    return false;
  }

  async clearAnalysisHistory() {
    await this.ensureCollection();
    try {
      const repo = this.app.db.getRepository('logger_ai_records');
      if (repo) {
        await repo.destroy({ truncate: true });
        return true;
      } else if (this.app.db.sequelize) {
        await this.app.db.sequelize.query('DELETE FROM logger_ai_records');
        return true;
      }
    } catch {}
    return false;
  }

  private buildAnalysisUserPrompt(processedText: string, context?: any): string {
    let userPrompt = `错误日志与调用堆栈如下：\n\`\`\`\n${processedText}\n\`\`\``;
    if (context) {
      userPrompt += `\n\n关联请求上下文：\n- 请求接口: ${context.method || 'GET'} ${context.path || '-'}\n- ReqId: ${context.reqId || '-'}\n- 数据表: ${context.collectionName || '-'}\n- 动作: ${context.actionName || '-'}`;
      if (context.sqlQueries && context.sqlQueries.length > 0) {
        userPrompt += `\n- 报错前执行的 SQL 查询:\n${context.sqlQueries.slice(0, 3).join('\n')}`;
      }
    }
    return userPrompt;
  }

  // 执行 AI 错误日志分析（同步）
  async analyzeLog(options: AIAnalysisRequest): Promise<AIAnalysisResponse> {
    const startTime = Date.now();
    const { logText, employeeName, llmSelection, context, sanitize, recordType, forceHeuristic } = options;
    const effectiveEmployee = (employeeName && employeeName.trim()) || this.getDefaultEmployeeName();

    if (!logText || !logText.trim()) {
      return {
        success: false,
        analyzerName: '错误分析专家',
        analysisReport: '',
        errorCode: 'INVALID_INPUT',
        errorMessage: '请提供有效的错误日志文本或堆栈信息进行诊断。',
        durationMs: 0,
      };
    }

    const { employeeTitle, systemPrompt } = await this.resolveEmployeePrompt(effectiveEmployee);
    const prep = this.prepareLogForAI(logText, sanitize);
    const userPrompt = this.buildAnalysisUserPrompt(prep.processedText, context);
    const messagesForLLM: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    if (!forceHeuristic) {
      const effectiveSelection = await this.resolveDefaultLLMSelection(llmSelection);
      if (!effectiveSelection?.llmService) {
        return {
          success: false,
          analyzerName: employeeTitle,
          analysisReport: '',
          errorCode: 'LLM_NOT_CONFIGURED',
          errorMessage: '系统尚未配置可用的真实 LLM 服务，请前往 NocoBase 管理后台【AI 员工 / LLM 服务】配置后再试，或使用内置规则兜底分析。',
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const llmRes = await this.invokeLLM(messagesForLLM, effectiveSelection);
        if (llmRes && llmRes.content) {
          const durationMs = Date.now() - startTime;
          const analyzerName = `${employeeTitle} (${llmRes.serviceTitle})`;
          const nowIso = new Date().toISOString();
          const savedMessages: ChatMessageItem[] = [
            { role: 'user', content: userPrompt, createdAt: nowIso },
            {
              role: 'assistant',
              content: llmRes.content,
              createdAt: nowIso,
              engine: 'llm',
              llmService: llmRes.usedService,
              model: llmRes.usedModel,
            },
          ];

          const recordId = await this.saveAnalysisRecord({
            analyzerName,
            employeeName: effectiveEmployee,
            llmService: llmRes.usedService,
            model: llmRes.usedModel,
            logText: prep.sanitizedText,
            context,
            analysisReport: llmRes.content,
            messages: savedMessages,
            recordType: recordType || 'log_analysis',
            durationMs,
          });

          return {
            id: recordId || undefined,
            success: true,
            analyzerName,
            analysisReport: llmRes.content,
            durationMs,
            engine: 'llm',
            llmService: llmRes.usedService,
            model: llmRes.usedModel,
            messages: savedMessages,
            maskedCount: prep.maskedCount,
            maskedTypes: prep.maskedTypes,
            compressedStats: prep.compressedStats,
          };
        }
        return {
          success: false,
          analyzerName: `${employeeTitle} (${effectiveSelection.llmService})`,
          analysisReport: '',
          errorCode: 'LLM_CALL_FAILED',
          errorMessage: `LLM 服务 (${effectiveSelection.llmService}) 未返回有效分析内容，请检查模型配置。`,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        return {
          success: false,
          analyzerName: `${employeeTitle} (${effectiveSelection.llmService})`,
          analysisReport: '',
          errorCode: 'LLM_CALL_FAILED',
          errorMessage: `调用 LLM 服务 (${effectiveSelection.llmService}) 失败: ${err.message}。请前往 NocoBase 管理后台检查 LLM 配置或连通性。`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 显式触发内置专家规则兜底分析
    const heuristicReport = this.runHeuristicAnalysis(prep.processedText, context);
    const durationMs = Date.now() - startTime;
    const analyzerName = `${employeeTitle} (内置专家引擎)`;
    const nowIso = new Date().toISOString();
    const savedMessages: ChatMessageItem[] = [
      { role: 'user', content: userPrompt, createdAt: nowIso },
      {
        role: 'assistant',
        content: heuristicReport,
        createdAt: nowIso,
        engine: 'heuristic',
        llmService: 'builtin',
        model: 'heuristic',
      },
    ];

    const recordId = await this.saveAnalysisRecord({
      analyzerName,
      employeeName: effectiveEmployee,
      llmService: 'builtin',
      model: 'heuristic',
      logText: prep.sanitizedText,
      context,
      analysisReport: heuristicReport,
      messages: savedMessages,
      recordType: recordType || 'log_analysis',
      durationMs,
    });

    return {
      id: recordId || undefined,
      success: true,
      analyzerName,
      analysisReport: heuristicReport,
      durationMs,
      engine: 'heuristic',
      llmService: 'builtin',
      model: 'heuristic',
      messages: savedMessages,
      maskedCount: prep.maskedCount,
      maskedTypes: prep.maskedTypes,
      compressedStats: prep.compressedStats,
    };
  }

  // 执行 AI 错误日志分析（SSE 流式）
  async analyzeLogStream(options: AIAnalysisRequest, callbacks: StreamCallbacks): Promise<void> {
    const startTime = Date.now();
    const { logText, employeeName, llmSelection, context, sanitize, recordType, forceHeuristic } = options;
    const effectiveEmployee = (employeeName && employeeName.trim()) || this.getDefaultEmployeeName();

    if (!logText || !logText.trim()) {
      callbacks.onError?.(this.createErrorWithCode('请提供有效的错误日志文本或堆栈信息进行诊断', 'INVALID_INPUT'));
      return;
    }

    const { employeeTitle, systemPrompt } = await this.resolveEmployeePrompt(effectiveEmployee);
    const prep = this.prepareLogForAI(logText, sanitize);
    const userPrompt = this.buildAnalysisUserPrompt(prep.processedText, context);
    const messagesForLLM: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    if (!forceHeuristic) {
      const effectiveSelection = await this.resolveDefaultLLMSelection(llmSelection);
      if (!effectiveSelection?.llmService) {
        callbacks.onError?.(
          this.createErrorWithCode(
            '系统尚未配置可用的真实 LLM 服务，请前往 NocoBase 管理后台【AI 员工 / LLM 服务】配置后再试，或使用内置规则兜底分析。',
            'LLM_NOT_CONFIGURED',
          ),
        );
        return;
      }

      try {
        callbacks.onMeta?.({
          analyzerName: `${employeeTitle} (${effectiveSelection.llmService})`,
          engine: 'llm',
          llmService: effectiveSelection.llmService,
          model: effectiveSelection.model,
          maskedCount: prep.maskedCount,
          maskedTypes: prep.maskedTypes,
          compressedStats: prep.compressedStats,
        });

        const llmRes = await this.invokeLLMStream(
          messagesForLLM,
          effectiveSelection,
          callbacks.onChunk,
          undefined,
          callbacks.onReasoning,
        );
        if (llmRes && llmRes.content) {
          const durationMs = Date.now() - startTime;
          const analyzerName = `${employeeTitle} (${llmRes.serviceTitle})`;
          const nowIso = new Date().toISOString();
          const savedMessages: ChatMessageItem[] = [
            { role: 'user', content: userPrompt, createdAt: nowIso },
            {
              role: 'assistant',
              content: llmRes.content,
              reasoningContent: llmRes.reasoningContent,
              createdAt: nowIso,
              engine: 'llm',
              llmService: llmRes.usedService,
              model: llmRes.usedModel,
            },
          ];

          const recordId = await this.saveAnalysisRecord({
            analyzerName,
            employeeName: effectiveEmployee,
            llmService: llmRes.usedService,
            model: llmRes.usedModel,
            logText: prep.sanitizedText,
            context,
            analysisReport: llmRes.content,
            messages: savedMessages,
            recordType: recordType || 'log_analysis',
            durationMs,
          });

          callbacks.onDone?.({
            id: recordId || undefined,
            success: true,
            analyzerName,
            analysisReport: llmRes.content,
            reasoningContent: llmRes.reasoningContent,
            durationMs,
            engine: 'llm',
            llmService: llmRes.usedService,
            model: llmRes.usedModel,
            messages: savedMessages,
            maskedCount: prep.maskedCount,
            maskedTypes: prep.maskedTypes,
            compressedStats: prep.compressedStats,
          });
          return;
        }
        callbacks.onError?.(
          this.createErrorWithCode(
            `LLM 服务 (${effectiveSelection.llmService}) 未返回有效分析内容，请检查模型配置。`,
            'LLM_CALL_FAILED',
          ),
        );
        return;
      } catch (err: any) {
        callbacks.onError?.(
          this.createErrorWithCode(
            `调用 LLM 服务 (${effectiveSelection.llmService}) 失败: ${err.message}`,
            'LLM_CALL_FAILED',
          ),
        );
        return;
      }
    }

    // 显式触发内置专家引擎模拟流式分块输出
    const heuristicReport = this.runHeuristicAnalysis(prep.processedText, context);
    const analyzerName = `${employeeTitle} (内置专家引擎)`;
    callbacks.onMeta?.({
      analyzerName,
      engine: 'heuristic',
      llmService: 'builtin',
      model: 'heuristic',
      maskedCount: prep.maskedCount,
      maskedTypes: prep.maskedTypes,
      compressedStats: prep.compressedStats,
    });

    const lines = heuristicReport.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const piece = (i === 0 ? '' : '\n') + lines[i];
      callbacks.onChunk(piece);
    }

    const durationMs = Date.now() - startTime;
    const nowIso = new Date().toISOString();
    const savedMessages: ChatMessageItem[] = [
      { role: 'user', content: userPrompt, createdAt: nowIso },
      {
        role: 'assistant',
        content: heuristicReport,
        createdAt: nowIso,
        engine: 'heuristic',
        llmService: 'builtin',
        model: 'heuristic',
      },
    ];

    const recordId = await this.saveAnalysisRecord({
      analyzerName,
      employeeName: effectiveEmployee,
      llmService: 'builtin',
      model: 'heuristic',
      logText: prep.sanitizedText,
      context,
      analysisReport: heuristicReport,
      messages: savedMessages,
      recordType: recordType || 'log_analysis',
      durationMs,
    });

    callbacks.onDone?.({
      id: recordId || undefined,
      success: true,
      analyzerName,
      analysisReport: heuristicReport,
      durationMs,
      engine: 'heuristic',
      llmService: 'builtin',
      model: 'heuristic',
      messages: savedMessages,
      maskedCount: prep.maskedCount,
      maskedTypes: prep.maskedTypes,
      compressedStats: prep.compressedStats,
    });
  }

  // 多轮追问对话（同步）
  async followUpChat(options: {
    recordId?: number | string;
    question: string;
    messages?: ChatMessageItem[];
    logText?: string;
    employeeName?: string;
    llmSelection?: LLMServiceSelection;
    sanitize?: boolean;
    forceHeuristic?: boolean;
  }): Promise<{
    success: boolean;
    reply: string;
    messages: ChatMessageItem[];
    durationMs: number;
    recordId?: number | string;
    engine?: 'llm' | 'heuristic';
    llmService?: string;
    model?: string;
    errorCode?: 'LLM_NOT_CONFIGURED' | 'LLM_CALL_FAILED' | 'INVALID_INPUT';
    errorMessage?: string;
  }> {
    const startTime = Date.now();
    const question = (options.question || '').trim();
    if (!question) {
      return {
        success: false,
        reply: '',
        errorCode: 'INVALID_INPUT',
        errorMessage: '请输入追问内容',
        messages: options.messages || [],
        durationMs: 0,
      };
    }

    let historyMessages: ChatMessageItem[] = Array.isArray(options.messages) ? [...options.messages] : [];
    let baseLogText = options.logText || '';

    if (options.recordId !== undefined && options.recordId !== null && options.recordId !== '') {
      const rec = await this.getAnalysisRecord(options.recordId);
      if (rec) {
        if (!baseLogText && rec.logText) baseLogText = rec.logText;
        if (historyMessages.length === 0) {
          if (Array.isArray(rec.messages) && rec.messages.length > 0) {
            historyMessages = [...rec.messages];
          } else if (rec.analysisReport) {
            historyMessages = [
              { role: 'user', content: `请诊断以下日志：\n${String(rec.logText || '').slice(0, 2000)}` },
              { role: 'assistant', content: rec.analysisReport },
            ];
          }
        }
      }
    }

    const effectiveEmployee = (options.employeeName && options.employeeName.trim()) || this.getDefaultEmployeeName();
    const { systemPrompt } = await this.resolveEmployeePrompt(effectiveEmployee);
    const shouldSanitize = options.sanitize !== undefined ? options.sanitize : this.getDefaultSanitize();
    const safeQuestion = shouldSanitize ? sanitizeLogText(question).sanitized : question;

    const llmMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: `${systemPrompt}\n\n当前处于多轮诊断追问会话，请基于之前的日志上下文与诊断结论回答用户的追问。` },
    ];
    if (historyMessages.length === 0 && baseLogText) {
      const prep = this.prepareLogForAI(baseLogText, shouldSanitize);
      llmMessages.push({ role: 'user', content: `日志上下文：\n\`\`\`\n${prep.processedText}\n\`\`\`` });
    }
    for (const m of historyMessages.slice(-12)) {
      llmMessages.push({ role: m.role, content: m.content });
    }
    llmMessages.push({ role: 'user', content: safeQuestion });

    let reply = '';
    let engine: 'llm' | 'heuristic' = 'heuristic';
    let usedService = 'builtin';
    let usedModel = 'heuristic';

    if (!options.forceHeuristic) {
      const effectiveSelection = await this.resolveDefaultLLMSelection(options.llmSelection);
      if (!effectiveSelection?.llmService) {
        return {
          success: false,
          reply: '',
          errorCode: 'LLM_NOT_CONFIGURED',
          errorMessage: '系统尚未配置可用的真实 LLM 服务，请前往 NocoBase 管理后台配置 LLM 服务，或使用内置规则兜底回答。',
          messages: historyMessages,
          durationMs: Date.now() - startTime,
          recordId: options.recordId,
        };
      }

      try {
        const llmRes = await this.invokeLLM(llmMessages, effectiveSelection);
        if (!llmRes || !llmRes.content) {
          return {
            success: false,
            reply: '',
            errorCode: 'LLM_CALL_FAILED',
            errorMessage: `追问调用 LLM 服务 (${effectiveSelection.llmService}) 未返回有效内容。`,
            messages: historyMessages,
            durationMs: Date.now() - startTime,
            recordId: options.recordId,
          };
        }
        reply = llmRes.content;
        engine = 'llm';
        usedService = llmRes.usedService;
        usedModel = llmRes.usedModel;
      } catch (err: any) {
        return {
          success: false,
          reply: '',
          errorCode: 'LLM_CALL_FAILED',
          errorMessage: `追问调用 LLM 服务 (${effectiveSelection.llmService}) 失败: ${err.message}`,
          messages: historyMessages,
          durationMs: Date.now() - startTime,
          recordId: options.recordId,
        };
      }
    } else {
      reply = this.runHeuristicFollowUp(safeQuestion, baseLogText, historyMessages);
    }

    const nowIso = new Date().toISOString();
    const updatedMessages: ChatMessageItem[] = [
      ...historyMessages,
      { role: 'user', content: safeQuestion, createdAt: nowIso },
      {
        role: 'assistant',
        content: reply,
        createdAt: nowIso,
        engine,
        llmService: usedService,
        model: usedModel,
      },
    ];

    if (options.recordId !== undefined && options.recordId !== null && options.recordId !== '') {
      await this.updateRecordMessages(options.recordId, updatedMessages);
    }

    return {
      success: true,
      reply,
      messages: updatedMessages,
      durationMs: Date.now() - startTime,
      recordId: options.recordId,
      engine,
      llmService: usedService,
      model: usedModel,
    };
  }

  // 多轮追问对话（SSE 流式）
  async followUpChatStream(
    options: {
      recordId?: number | string;
      question: string;
      messages?: ChatMessageItem[];
      logText?: string;
      employeeName?: string;
      llmSelection?: LLMServiceSelection;
      sanitize?: boolean;
      forceHeuristic?: boolean;
    },
    callbacks: {
      onReasoning?: (chunk: string) => void;
      onChunk: (chunk: string) => void;
      onDone: (res: {
        success: boolean;
        reply: string;
        reasoningContent?: string;
        messages: ChatMessageItem[];
        durationMs: number;
        recordId?: number | string;
        engine?: 'llm' | 'heuristic';
        llmService?: string;
        model?: string;
      }) => void;
      onError: (err: Error) => void;
    },
  ): Promise<void> {
    const startTime = Date.now();
    const question = (options.question || '').trim();
    if (!question) {
      callbacks.onError(this.createErrorWithCode('请输入追问内容', 'INVALID_INPUT'));
      return;
    }

    let historyMessages: ChatMessageItem[] = Array.isArray(options.messages) ? [...options.messages] : [];
    let baseLogText = options.logText || '';

    if (options.recordId !== undefined && options.recordId !== null && options.recordId !== '') {
      const rec = await this.getAnalysisRecord(options.recordId);
      if (rec) {
        if (!baseLogText && rec.logText) baseLogText = rec.logText;
        if (historyMessages.length === 0) {
          if (Array.isArray(rec.messages) && rec.messages.length > 0) {
            historyMessages = [...rec.messages];
          } else if (rec.analysisReport) {
            historyMessages = [
              { role: 'user', content: `请诊断以下日志：\n${String(rec.logText || '').slice(0, 2000)}` },
              { role: 'assistant', content: rec.analysisReport },
            ];
          }
        }
      }
    }

    const effectiveEmployee = (options.employeeName && options.employeeName.trim()) || this.getDefaultEmployeeName();
    const { systemPrompt } = await this.resolveEmployeePrompt(effectiveEmployee);
    const shouldSanitize = options.sanitize !== undefined ? options.sanitize : this.getDefaultSanitize();
    const safeQuestion = shouldSanitize ? sanitizeLogText(question).sanitized : question;

    const llmMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: `${systemPrompt}\n\n当前处于多轮诊断追问会话，请基于之前的日志上下文与诊断结论回答用户的追问。` },
    ];
    if (historyMessages.length === 0 && baseLogText) {
      const prep = this.prepareLogForAI(baseLogText, shouldSanitize);
      llmMessages.push({ role: 'user', content: `日志上下文：\n\`\`\`\n${prep.processedText}\n\`\`\`` });
    }
    for (const m of historyMessages.slice(-12)) {
      llmMessages.push({ role: m.role, content: m.content });
    }
    llmMessages.push({ role: 'user', content: safeQuestion });

    let reply = '';
    let reasoningContent: string | undefined;
    let engine: 'llm' | 'heuristic' = 'heuristic';
    let usedService = 'builtin';
    let usedModel = 'heuristic';

    if (!options.forceHeuristic) {
      const effectiveSelection = await this.resolveDefaultLLMSelection(options.llmSelection);
      if (!effectiveSelection?.llmService) {
        callbacks.onError(
          this.createErrorWithCode(
            '系统尚未配置可用的真实 LLM 服务，请前往 NocoBase 管理后台配置 LLM 服务，或使用内置规则兜底回答。',
            'LLM_NOT_CONFIGURED',
          ),
        );
        return;
      }

      try {
        const llmRes = await this.invokeLLMStream(
          llmMessages,
          effectiveSelection,
          callbacks.onChunk,
          undefined,
          callbacks.onReasoning,
        );
        if (!llmRes || !llmRes.content) {
          callbacks.onError(
            this.createErrorWithCode(
              `追问调用 LLM 服务 (${effectiveSelection.llmService}) 未返回有效内容。`,
              'LLM_CALL_FAILED',
            ),
          );
          return;
        }
        reply = llmRes.content;
        reasoningContent = llmRes.reasoningContent;
        engine = 'llm';
        usedService = llmRes.usedService;
        usedModel = llmRes.usedModel;
      } catch (err: any) {
        callbacks.onError(
          this.createErrorWithCode(
            `追问调用 LLM 服务 (${effectiveSelection.llmService}) 失败: ${err.message}`,
            'LLM_CALL_FAILED',
          ),
        );
        return;
      }
    } else {
      reply = this.runHeuristicFollowUp(safeQuestion, baseLogText, historyMessages);
      callbacks.onChunk(reply);
    }

    const nowIso = new Date().toISOString();
    const updatedMessages: ChatMessageItem[] = [
      ...historyMessages,
      { role: 'user', content: safeQuestion, createdAt: nowIso },
      {
        role: 'assistant',
        content: reply,
        reasoningContent: typeof reasoningContent === 'string' ? reasoningContent : undefined,
        createdAt: nowIso,
        engine,
        llmService: usedService,
        model: usedModel,
      },
    ];

    if (options.recordId !== undefined && options.recordId !== null && options.recordId !== '') {
      await this.updateRecordMessages(options.recordId, updatedMessages);
    }

    callbacks.onDone({
      success: true,
      reply,
      reasoningContent,
      messages: updatedMessages,
      durationMs: Date.now() - startTime,
      recordId: options.recordId,
      engine,
      llmService: usedService,
      model: usedModel,
    });
  }

  private runHeuristicFollowUp(question: string, logText: string, history: ChatMessageItem[]): string {
    if (/怎么修|如何修复|代码|fix|code/i.test(question)) {
      return `针对你的追问「${question}」，建议按以下步骤修复：\n1. 在报错调用点增加空值/边界校验（可选链 \`?.\` 与默认兜底值）；\n2. 若涉及数据库或异步依赖，确保在 \`afterStart\` 或连接就绪后再执行查询；\n3. 补充对应的单元测试覆盖异常输入场景。`;
    }
    if (/影响|范围|严重|impact/i.test(question)) {
      return `从当前日志特征来看，该异常主要影响触发该请求路径的接口调用。建议结合【全链路追踪】确认是否存在连续 5xx 失败或慢 SQL 扩散效应。`;
    }
    return `已结合当前 ${history.length} 条对话上下文与日志特征进行分析（内置引擎模式）：\n- 关于「${question}」，当前日志核心上下文长度为 ${logText.length} 字符。\n- 如需更深入的代码级推演，请在上方选择一个已配置的 LLM 服务（如 Dashscope / Ollama）后再发起追问。`;
  }

  // 错误日志本地指纹聚类
  clusterLogs(logLines: string[]): ErrorCluster[] {
    return clusterErrorLines(logLines);
  }

  // 解析默认 LLM 服务：显式传入 > 插件默认配置 > 系统中首个可用真实 LLM 服务
  private async resolveDefaultLLMSelection(preferred?: LLMServiceSelection): Promise<LLMServiceSelection | undefined> {
    if (preferred?.llmService) return preferred;
    const services = await this.getAvailableLLMServices();
    if (services.length === 0) return undefined;

    const configuredService = this.configService?.get?.(CONFIG_KEYS.AI_DEFAULT_LLM_SERVICE)?.trim();
    const configuredModel = this.configService?.get?.(CONFIG_KEYS.AI_DEFAULT_LLM_MODEL)?.trim();

    if (configuredService) {
      const matched = services.find((s) => String(s.llmService) === String(configuredService));
      if (matched) {
        return {
          llmService: matched.llmService,
          model: configuredModel || matched.enabledModels?.[0]?.value || 'default',
        };
      }
    }

    const first = services[0];
    return {
      llmService: first.llmService,
      model: first.enabledModels?.[0]?.value || 'default',
    };
  }

  // 告警触发联动 AI 生成精简根因摘要（带短超时与启发式降级，绝不抛错阻塞告警）
  async generateAlertRootCauseSummary(
    alertContext: Record<string, any>,
    options: { timeoutMs?: number; llmSelection?: LLMServiceSelection } = {},
  ): Promise<{ summary: string; engine: 'llm' | 'heuristic' }> {
    const timeoutMs = options.timeoutMs || 8000;
    const rawText = [
      alertContext.title ? `Title: ${alertContext.title}` : '',
      alertContext.level ? `Level: ${alertContext.level}` : '',
      alertContext.path ? `Request: ${alertContext.method || 'GET'} ${alertContext.path}` : '',
      alertContext.statusCode ? `Status: ${alertContext.statusCode}` : '',
      alertContext.durationMs ? `Duration: ${alertContext.durationMs}ms` : '',
      alertContext.sql ? `SQL: ${alertContext.sql}` : '',
      alertContext.message ? `Message: ${alertContext.message}` : '',
      alertContext.stack ? `Stack: ${String(alertContext.stack).slice(0, 1500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const { sanitized } = sanitizeLogText(rawText);

    try {
      const selection = await this.resolveDefaultLLMSelection(options.llmSelection);
      if (selection?.llmService) {
        const res = await this.invokeLLM(
          [
            {
              role: 'system',
              content: '你是系统运维告警助手。请根据告警上下文用简洁中文输出 2-3 条根因与处置建议（总字数不超过 220 字，纯 Markdown 列表）。',
            },
            { role: 'user', content: sanitized },
          ],
          selection,
          timeoutMs,
        );
        if (res?.content && res.content.trim()) {
          return { summary: res.content.trim().slice(0, 800), engine: 'llm' };
        }
      }
    } catch (err: any) {
      this.app.logger?.warn?.(`[LoggerPro] Alert AI summary fallback to heuristic: ${err?.message || err}`);
    }

    // 启发式降级摘要
    const hints: string[] = [];
    if (alertContext.durationMs && Number(alertContext.durationMs) >= 500) {
      hints.push(`慢查询耗时 ${alertContext.durationMs}ms，建议检查 SQL 索引与查询条件。`);
    }
    if (alertContext.statusCode && Number(alertContext.statusCode) >= 500) {
      hints.push(`服务端返回 HTTP ${alertContext.statusCode}，建议结合 ReqId 查看系统异常堆栈。`);
    }
    if (/timeout|etimedout|econnrefused/i.test(sanitized)) {
      hints.push('检测到网络/连接超时特征，请检查下游服务或数据库连通性。');
    }
    if (/deadlock|lock wait/i.test(sanitized)) {
      hints.push('检测到数据库锁冲突/死锁特征，建议排查长事务与并发更新顺序。');
    }
    if (hints.length === 0) {
      hints.push('建议点击控制台【全链路追踪】或【AI 错误诊断】进一步定位上下文堆栈。');
    }

    return {
      summary: hints.map((h) => `- ${h}`).join('\n'),
      engine: 'heuristic',
    };
  }

  // Dashboard AI 健康巡检报告
  private buildHealthPromptData(overview: any, errorClusters: ErrorCluster[]) {
    const summary = overview?.summary || {};
    const topSlow = (overview?.topSlowQueries || []).slice(0, 5).map((q: any) => ({
      durationMs: q.durationMs,
      sql: sanitizeLogText(String(q.sql || '').slice(0, 200)).sanitized,
    }));
    const topClusters = errorClusters.slice(0, 5).map((c) => ({
      count: c.count,
      level: c.level,
      pattern: c.pattern.slice(0, 150),
    }));

    return {
      summary,
      trend: overview?.trend || [],
      topSlowQueries: topSlow,
      topUsers: (overview?.topUsers || []).slice(0, 5),
      topCollections: (overview?.topCollections || []).slice(0, 5),
      topErrorClusters: topClusters,
    };
  }

  private runHeuristicHealthInspection(payload: any): string {
    const s = payload.summary || {};
    const errCount = Number(s.todayErrorCount || 0);
    const alertCount = Number(s.todayAlertCount || 0);
    const slowCount = (payload.topSlowQueries || []).length;
    const score = Math.max(40, 100 - Math.min(30, errCount * 2) - Math.min(15, alertCount * 3) - Math.min(15, slowCount * 2));
    const statusLabel = score >= 85 ? '🟢 健康' : score >= 65 ? '🟡 亚健康（需关注）' : '🔴 存在风险';

    return `### 🩺 系统健康巡检报告
#### 📊 1. 综合健康评分: **${score} / 100** (${statusLabel})
- **今日审计操作**: \`${s.todayAuditCount ?? 0}\` 次（累计 \`${s.totalAuditCount ?? 0}\` 次）
- **今日异常错误**: \`${errCount}\` 次
- **今日告警触发**: \`${alertCount}\` 次
- **日志磁盘占用**: \`${s.totalDiskFormatted ?? '0 MB'}\`（共 \`${s.totalLogFiles ?? 0}\` 个文件）

#### 🔥 2. 错误热点与慢 SQL 诊断
${(payload.topErrorClusters || []).length > 0 ? payload.topErrorClusters.map((c: any) => `- [${c.level}] 出现 **${c.count}** 次: \`${c.pattern}\``).join('\n') : '- 近期错误日志聚类未发现高频重复异常。'}
${(payload.topSlowQueries || []).length > 0 ? `\n- 捕获到 **${payload.topSlowQueries.length}** 条慢 SQL，最高耗时 \`${payload.topSlowQueries[0]?.durationMs}ms\`。` : '\n- 运行时暂未捕获到明显慢 SQL。'}

#### 🛡️ 3. 运维改进建议
1. ${errCount > 0 ? '优先排查今日异常错误中出现频次最高的接口或错误簇；' : '保持当前稳定性，建议定期抽检核心接口审计记录；'}
2. ${slowCount > 0 ? '针对 Top 慢 SQL 检查数据库索引与分页限制；' : '数据库查询耗时处于健康区间；'}
3. 关注日志磁盘增长趋势，确保自动清理策略（\`auto_clean_enabled\`）正常运行。`;
  }

  async runHealthInspection(
    overview: any,
    errorClusters: ErrorCluster[],
    llmSelection?: LLMServiceSelection,
    options?: { forceHeuristic?: boolean },
  ): Promise<AIAnalysisResponse> {
    const startTime = Date.now();
    const payload = this.buildHealthPromptData(overview, errorClusters);
    const promptText = `以下是 NocoBase 系统当前运行指标与错误聚类摘要（JSON）：\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n请输出一份结构化的中文系统健康巡检报告（包含健康评分 0-100、异常热点分析、性能瓶颈、运维建议）。`;

    let report = '';
    let analyzerName = '🩺 系统健康巡检 (内置引擎)';
    let usedService = 'builtin';
    let usedModel = 'heuristic';
    let engine: 'llm' | 'heuristic' = 'heuristic';

    if (!options?.forceHeuristic) {
      const effectiveSelection = await this.resolveDefaultLLMSelection(llmSelection);
      if (!effectiveSelection?.llmService) {
        return {
          success: false,
          analyzerName: '🩺 系统健康巡检',
          analysisReport: '',
          errorCode: 'LLM_NOT_CONFIGURED',
          errorMessage: '系统尚未配置可用的真实 LLM 服务，请前往 NocoBase 管理后台配置 LLM 服务，或使用内置规则兜底巡检。',
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const llmRes = await this.invokeLLM(
          [
            { role: 'system', content: '你是一名资深 SRE 与 NocoBase 系统架构师，请根据系统运维指标输出清晰、可落地的 Markdown 健康巡检报告。' },
            { role: 'user', content: promptText },
          ],
          effectiveSelection,
        );
        if (!llmRes?.content) {
          return {
            success: false,
            analyzerName: `🩺 系统健康巡检 (${effectiveSelection.llmService})`,
            analysisReport: '',
            errorCode: 'LLM_CALL_FAILED',
            errorMessage: `健康巡检调用 LLM 服务 (${effectiveSelection.llmService}) 未返回有效内容。`,
            durationMs: Date.now() - startTime,
          };
        }
        report = llmRes.content;
        analyzerName = `🩺 系统健康巡检 (${llmRes.serviceTitle})`;
        usedService = llmRes.usedService;
        usedModel = llmRes.usedModel;
        engine = 'llm';
      } catch (err: any) {
        return {
          success: false,
          analyzerName: `🩺 系统健康巡检 (${effectiveSelection.llmService})`,
          analysisReport: '',
          errorCode: 'LLM_CALL_FAILED',
          errorMessage: `健康巡检调用 LLM 服务 (${effectiveSelection.llmService}) 失败: ${err.message}`,
          durationMs: Date.now() - startTime,
        };
      }
    } else {
      report = this.runHeuristicHealthInspection(payload);
    }

    const durationMs = Date.now() - startTime;
    const createdAt = new Date().toISOString();
    const recordId = await this.saveAnalysisRecord({
      analyzerName,
      employeeName: 'system-error-expert',
      llmService: usedService,
      model: usedModel,
      logSummary: `Dashboard 系统健康巡检报告 (${new Date().toLocaleDateString()})`,
      logText: JSON.stringify(payload, null, 2),
      context: { type: 'health_inspection' },
      analysisReport: report,
      messages: [
        { role: 'user', content: promptText, createdAt },
        { role: 'assistant', content: report, createdAt },
      ],
      recordType: 'health_inspection',
      durationMs,
    });

    const result: AIAnalysisResponse = {
      id: recordId || undefined,
      success: true,
      analyzerName,
      analysisReport: report,
      durationMs,
      createdAt,
      engine,
      llmService: usedService,
      model: usedModel,
    };
    this.latestInspectionCache = result;
    return result;
  }

  async runHealthInspectionStream(
    overview: any,
    errorClusters: ErrorCluster[],
    llmSelection: LLMServiceSelection | undefined,
    callbacks: StreamCallbacks,
    options?: { forceHeuristic?: boolean },
  ): Promise<void> {
    const startTime = Date.now();
    const payload = this.buildHealthPromptData(overview, errorClusters);
    const promptText = `以下是 NocoBase 系统当前运行指标与错误聚类摘要（JSON）：\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n请输出一份结构化的中文系统健康巡检报告（包含健康评分 0-100、异常热点分析、性能瓶颈、运维建议）。`;

    let report = '';
    let reasoningContent: string | undefined;
    let analyzerName = '🩺 系统健康巡检 (内置引擎)';
    let usedService = 'builtin';
    let usedModel = 'heuristic';
    let engine: 'llm' | 'heuristic' = 'heuristic';

    if (!options?.forceHeuristic) {
      const effectiveSelection = await this.resolveDefaultLLMSelection(llmSelection);
      if (!effectiveSelection?.llmService) {
        callbacks.onError?.(
          this.createErrorWithCode(
            '系统尚未配置可用的真实 LLM 服务，请前往 NocoBase 管理后台配置 LLM 服务，或使用内置规则兜底巡检。',
            'LLM_NOT_CONFIGURED',
          ),
        );
        return;
      }

      try {
        callbacks.onMeta?.({
          analyzerName: `🩺 系统健康巡检 (${effectiveSelection.llmService})`,
          engine: 'llm',
          llmService: effectiveSelection.llmService,
          model: effectiveSelection.model,
        });
        const llmRes = await this.invokeLLMStream(
          [
            { role: 'system', content: '你是一名资深 SRE 与 NocoBase 系统架构师，请根据系统运维指标输出清晰、可落地的 Markdown 健康巡检报告。' },
            { role: 'user', content: promptText },
          ],
          effectiveSelection,
          callbacks.onChunk,
          undefined,
          callbacks.onReasoning,
        );
        if (!llmRes?.content) {
          callbacks.onError?.(
            this.createErrorWithCode(
              `健康巡检调用 LLM 服务 (${effectiveSelection.llmService}) 未返回有效内容。`,
              'LLM_CALL_FAILED',
            ),
          );
          return;
        }
        report = llmRes.content;
        reasoningContent = llmRes.reasoningContent;
        analyzerName = `🩺 系统健康巡检 (${llmRes.serviceTitle})`;
        usedService = llmRes.usedService;
        usedModel = llmRes.usedModel;
        engine = 'llm';
      } catch (err: any) {
        callbacks.onError?.(
          this.createErrorWithCode(
            `健康巡检调用 LLM 服务 (${effectiveSelection.llmService}) 失败: ${err.message}`,
            'LLM_CALL_FAILED',
          ),
        );
        return;
      }
    } else {
      callbacks.onMeta?.({
        analyzerName,
        engine: 'heuristic',
        llmService: 'builtin',
        model: 'heuristic',
      });
      report = this.runHeuristicHealthInspection(payload);
      const lines = report.split('\n');
      for (let i = 0; i < lines.length; i++) {
        callbacks.onChunk((i === 0 ? '' : '\n') + lines[i]);
      }
    }

    const durationMs = Date.now() - startTime;
    const createdAt = new Date().toISOString();
    const recordId = await this.saveAnalysisRecord({
      analyzerName,
      employeeName: 'system-error-expert',
      llmService: usedService,
      model: usedModel,
      logSummary: `Dashboard 系统健康巡检报告 (${new Date().toLocaleDateString()})`,
      logText: JSON.stringify(payload, null, 2),
      context: { type: 'health_inspection' },
      analysisReport: report,
      messages: [
        { role: 'user', content: promptText, createdAt },
        { role: 'assistant', content: report, reasoningContent, createdAt },
      ],
      recordType: 'health_inspection',
      durationMs,
    });

    const result: AIAnalysisResponse = {
      id: recordId || undefined,
      success: true,
      analyzerName,
      analysisReport: report,
      reasoningContent,
      durationMs,
      createdAt,
      engine,
      llmService: usedService,
      model: usedModel,
    };
    this.latestInspectionCache = result;
    callbacks.onDone?.(result);
  }

  async getLatestHealthInspection() {
    if (this.latestInspectionCache) {
      return this.latestInspectionCache;
    }
    await this.ensureCollection();
    try {
      const repo = this.app.db.getRepository('logger_ai_records');
      if (repo) {
        const rec = await repo.findOne({
          filter: { recordType: 'health_inspection' },
          sort: ['-createdAt', '-id'],
        });
        if (rec) {
          this.latestInspectionCache = rec;
          return rec;
        }
      }
    } catch {}
    return null;
  }

  // 自然语言转结构化审计查询条件 (NL2Filter) —— 严格白名单字段，禁止生成原始 SQL
  async naturalLanguageToFilter(
    query: string,
    availableCollections: string[] = [],
    llmSelection?: LLMServiceSelection,
    options?: { forceHeuristic?: boolean },
  ): Promise<NL2FilterResult> {
    const q = (query || '').trim();
    if (!q) {
      return {
        ...buildNL2FilterResponse({}, 'heuristic', '请输入自然语言查询描述'),
        success: false,
        errorCode: 'INVALID_INPUT',
        errorMessage: '请输入自然语言查询描述',
      };
    }

    if (options?.forceHeuristic) {
      return {
        ...heuristicNLToFilter(q, availableCollections),
        llmService: 'builtin',
        model: 'heuristic',
      };
    }

    const selection = await this.resolveDefaultLLMSelection(llmSelection);
    if (!selection?.llmService) {
      return {
        ...buildNL2FilterResponse({}, 'heuristic', ''),
        success: false,
        errorCode: 'LLM_NOT_CONFIGURED',
        errorMessage: '系统尚未配置可用的真实 LLM 服务，请前往 NocoBase 管理后台配置 LLM 服务，或使用内置规则兜底筛选。',
      };
    }

    try {
      const nowIso = new Date().toISOString();
      const colHint = availableCollections.slice(0, 40).join(', ');
      const sysPrompt = `你是一个审计日志查询条件转换器。你只能输出纯 JSON（不要包含 Markdown 代码块或任何解释），且严格限制使用以下白名单字段构建 filter 对象：
- createdAt: { "$gte"?: ISOString, "$lt"?: ISOString }
- statusCode: number 或 { "$gte"?: number, "$lt"?: number }
- method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
- userUsername: { "$includes": string }
- collectionName: string (可选参考集合: ${colHint})
- actionName: "create" | "update" | "destroy"
- path: { "$includes": string }
禁止生成任何 SQL 或非白名单字段。当前时间: ${nowIso}。
输出格式: { "filter": { ... }, "explanation": "简短中文说明" }`;

      const llmRes = await this.invokeLLM(
        [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: q },
        ],
        selection,
        12000,
      );

      if (llmRes?.content) {
        const jsonMatch = llmRes.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const rawFilter = parsed.filter || parsed;
          const cleanFilter = sanitizeNLFilter(rawFilter, availableCollections);
          if (Object.keys(cleanFilter).length > 0) {
            return {
              ...buildNL2FilterResponse(
                cleanFilter,
                'llm',
                String(parsed.explanation || '已通过 AI 解析自然语言查询条件'),
              ),
              llmService: llmRes.usedService,
              model: llmRes.usedModel,
            };
          }
        }
      }

      return {
        ...buildNL2FilterResponse({}, 'llm', ''),
        success: false,
        llmService: selection.llmService,
        model: selection.model,
        errorCode: 'LLM_CALL_FAILED',
        errorMessage: `LLM 服务 (${selection.llmService}) 未能生成有效的结构化过滤条件，请调整查询描述或使用内置规则兜底筛选。`,
      };
    } catch (err: any) {
      return {
        ...buildNL2FilterResponse({}, 'llm', ''),
        success: false,
        llmService: selection.llmService,
        model: selection.model,
        errorCode: 'LLM_CALL_FAILED',
        errorMessage: `NL2Filter 调用 LLM 服务 (${selection.llmService}) 失败: ${err.message}`,
      };
    }
  }
}
