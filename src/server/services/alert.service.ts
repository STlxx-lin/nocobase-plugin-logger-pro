import { Application } from '@nocobase/server';
import crypto from 'crypto';
import { ALERT_CHANNELS, ALERT_RULE_TYPES } from '../constants';

export interface AlertContext {
  title?: string;
  message?: string;
  level?: string;
  statusCode?: number;
  durationMs?: number;
  sql?: string;
  path?: string;
  method?: string;
  ip?: string;
  user?: string;
  stack?: string;
  aiSummary?: string;
  extra?: Record<string, any>;
}

/** IPv4 字面量是否为私有/环回/链路本地/保留段（含 0.0.0.0/8、CGNAT、组播、广播） */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24
  if (a >= 224) return true; // 组播 + 保留 + 广播
  return false;
}

/** 主机名是否属于不允许的 localhost / 环回 / 私有 / 保留地址 */
export function isPrivateOrReservedHost(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase().replace(/\.$/, '');

  // 主机名形式
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata' || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;

  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return isPrivateIPv4(h);
  }

  // IPv6 字面量（去掉方括号后）
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 唯一本地地址
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 链路本地
    // IPv4-mapped ::ffff:127.0.0.1
    const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
  }

  return false;
}

export class AlertService {
  private app: Application;
  private silenceCache: Map<number, number> = new Map(); // ruleId -> timestamp
  private aiAnalyzerService?: any;

  constructor(app: Application) {
    this.app = app;
  }

  setAIAnalyzerService(service: any) {
    this.aiAnalyzerService = service;
  }

  /**
   * Webhook URL 安全校验：
   * 1. 仅允许 http/https 协议（阻断 file://、gopher:// 等危险协议）；
   * 2. 封禁 localhost / 环回 / 私有 / 链路本地 / 保留地址，以及云厂商元数据端点；
   * 3. 仅在显式开启 LOGGER_PRO_ALLOW_PRIVATE_WEBHOOK=true 时放行内网地址（自建内网接收端场景）。
   */
  private assertSafeWebhookUrl(rawUrl: string) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid webhook URL: ${rawUrl.slice(0, 100)}`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error(`Webhook URL protocol not allowed: ${u.protocol}`);
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    const blockedEndpoints = [
      '169.254.169.254', // AWS/阿里云/华为云等元数据
      '100.100.100.200', // 阿里云 ECS 元数据
      'metadata.google.internal', // GCP 元数据
      'metadata', // 通用元数据主机名
      'fd00:ec2::254', // AWS IPv6 元数据
    ];
    if (blockedEndpoints.includes(host)) {
      throw new Error(`Webhook URL points to a blocked metadata endpoint: ${host}`);
    }

    if (process.env.LOGGER_PRO_ALLOW_PRIVATE_WEBHOOK === 'true') {
      return;
    }
    if (isPrivateOrReservedHost(host)) {
      throw new Error(
        `Webhook URL points to a private/loopback/reserved address: ${host} ` +
          `(set LOGGER_PRO_ALLOW_PRIVATE_WEBHOOK=true to allow internal receivers)`,
      );
    }
  }

  /**
   * 发起出站请求并跟随重定向，**每一跳都重新校验目标地址**，
   * 防止公网域名 302 到内网/元数据地址绕过首跳校验。
   */
  private async safeFetch(
    rawUrl: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    maxRedirects = 3,
  ): Promise<Response> {
    let currentUrl = rawUrl;
    let method = init.method || 'POST';
    let body = init.body;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      this.assertSafeWebhookUrl(currentUrl);
      const res = await fetch(currentUrl, {
        method,
        headers: init.headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return res;
        currentUrl = new URL(location, currentUrl).toString();
        // 跨源重定向降级为 GET 且丢弃 body，避免凭据/负载被转发到第三方主机
        const nextOrigin = new URL(currentUrl).origin;
        if (nextOrigin !== new URL(rawUrl).origin) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      return res;
    }
    throw new Error(`Webhook redirect exceeded ${maxRedirects} hops`);
  }

  async testAlert(ruleData: any): Promise<{ success: boolean; error?: string }> {
    const testContext: AlertContext = {
      title: `[测试告警] ${ruleData.name || 'Logger Pro Alert Rule Test'}`,
      message: '这是一条来自 NocoBase Logger Pro 的连通性测试告警信息，如果收到说明告警渠道配置正常。',
      level: 'TEST',
      statusCode: 200,
      path: '/api/loggerPro:testAlert',
      method: 'POST',
      ip: '127.0.0.1',
      user: 'Admin',
    };

    try {
      await this.sendToChannel(ruleData.channelType, ruleData.channelConfig, testContext);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async checkAndTrigger(type: string, context: AlertContext) {
    try {
      const ruleRepo = this.app.db.getRepository('logger_alert_rules');
      if (!ruleRepo) return;

      const rules = await ruleRepo.find({
        filter: {
          type,
          enabled: true,
        },
      });

      if (!rules || rules.length === 0) return;

      const now = Date.now();

      for (const rule of rules) {
        if (!this.matchCondition(rule, type, context)) {
          continue;
        }

        // 防风暴限流检查（以规则自增 id 为键；不存在的 id 一律放行）
        const ruleKey = Number(rule.id);
        if (!Number.isFinite(ruleKey)) {
          continue;
        }

        // silenceMinutes <= 0 视为关闭静默（含非法值时的显式意图），默认仍为 5 分钟
        const rawSilence = Number(rule.silenceMinutes);
        const silenceMs = Number.isFinite(rawSilence) && rawSilence <= 0 ? 0 : (Number.isFinite(rawSilence) ? rawSilence : 5) * 60 * 1000;
        const lastTriggeredAt = rule.lastTriggeredAt ? new Date(rule.lastTriggeredAt).getTime() : 0;
        const lastTriggered = Math.max(this.silenceCache.get(ruleKey) || 0, Number.isFinite(lastTriggeredAt) ? lastTriggeredAt : 0);

        if (silenceMs > 0 && lastTriggered > 0 && now - lastTriggered < silenceMs) {
          continue;
        }

        this.silenceCache.set(ruleKey, now);
        // 异步更新数据库与发送，不阻塞主流程；失败时释放静默窗口，避免告警被静默吞掉
        this.dispatchAlert(rule, context).catch((e) => {
          if (this.silenceCache.get(ruleKey) === now) {
            this.silenceCache.delete(ruleKey);
          }
          this.app.logger?.warn?.(`[LoggerPro] dispatch alert failed: ${e?.message || e}`);
        });
      }
    } catch (err: any) {
      // 若表尚未建立或数据库迁移中，静默跳过，避免控制台刷屏
      if (err.message && (err.message.includes('no such table') || err.message.includes("doesn't exist"))) {
        return;
      }
      this.app.logger?.warn?.(`[LoggerPro] checkAndTrigger error: ${err.message}`);
    }
  }

  private matchCondition(rule: any, type: string, context: AlertContext): boolean {
    const condition = rule.condition || {};

    if (type === ALERT_RULE_TYPES.KEYWORD) {
      const keyword = condition.keyword?.trim();
      if (!keyword) return false;
      const targetStr = `${context.message || ''} ${context.title || ''} ${context.stack || ''}`;
      return targetStr.toLowerCase().includes(keyword.toLowerCase());
    }

    if (type === ALERT_RULE_TYPES.SLOW_SQL) {
      const threshold = Number(condition.thresholdMs) || 1000;
      return (context.durationMs || 0) >= threshold;
    }

    if (type === ALERT_RULE_TYPES.STATUS_5XX) {
      const code = context.statusCode || 0;
      return code >= 500 && code <= 599;
    }

    if (type === ALERT_RULE_TYPES.ERROR_LOG) {
      return (context.level || '').toUpperCase() === 'ERROR';
    }

    return true;
  }

  private async dispatchAlert(rule: any, context: AlertContext) {
    const ruleRepo = this.app.db.getRepository('logger_alert_rules');
    const logRepo = this.app.db.getRepository('logger_alert_logs');

    try {
      await ruleRepo.update({
        filterByTk: rule.id,
        values: { lastTriggeredAt: new Date() },
      });
    } catch (err: any) {
      // 更新失败不应阻断告警发送
      this.app.logger?.warn?.(`[LoggerPro] Update alert rule lastTriggeredAt failed: ${err.message}`);
    }

    let enrichedContext: AlertContext = { ...context };
    if (rule.aiSummaryEnabled === true && this.aiAnalyzerService?.generateAlertRootCauseSummary) {
      try {
        const res = await this.aiAnalyzerService.generateAlertRootCauseSummary(context, {
          timeoutMs: 8000,
          llmSelection: rule.aiSummaryConfig,
        });
        if (res?.summary) {
          enrichedContext.aiSummary = res.summary;
        }
      } catch (err: any) {
        this.app.logger?.warn?.(`[LoggerPro] Alert AI summary failed, continuing delivery: ${err?.message || err}`);
      }
    }

    let status = 'success';
    let errorMsg = '';

    try {
      await this.sendToChannel(rule.channelType, rule.channelConfig, enrichedContext);
    } catch (err) {
      status = 'failed';
      errorMsg = err.message;
    }

    if (logRepo) {
      const logContent = enrichedContext.aiSummary
        ? `${enrichedContext.message || JSON.stringify(context)}\n\n[AI 根因摘要]\n${enrichedContext.aiSummary}`
        : (enrichedContext.message || JSON.stringify(context));
      await logRepo.create({
        values: {
          ruleId: rule.id,
          ruleName: rule.name,
          channelType: rule.channelType,
          title: enrichedContext.title || `[告警] ${rule.name}`,
          content: logContent,
          status,
          errorMsg,
        },
      });
    }
  }

  /**
   * 解析通知管理插件（@nocobase/plugin-notification-manager）的插件实例。
   * 渠道由 channelId 指定的 Channel 唯一标识（如 email-xxx / in-app-message-xxx），
   * 不支持时返回 null。
   */
  private resolveNotificationPlugin(): any | null {
    const pm: any = (this.app as any).pm;
    if (!pm?.get) return null;
    for (const name of ['@nocobase/plugin-notification-manager', 'notification-manager']) {
      try {
        const plugin = pm.get(name);
        if (plugin && typeof plugin.send === 'function') {
          return plugin;
        }
      } catch {}
    }
    return null;
  }

  private async sendToChannel(channelType: string, config: any, context: AlertContext) {
    // 发起任何出站请求前先校验 webhook 目标（notification-manager 走系统内部通道，不适用）
    if (channelType !== ALERT_CHANNELS.NOTIFICATION_MANAGER) {
      this.assertSafeWebhookUrl(config?.webhookUrl);
    }

    const title = context.title || '【NocoBase 系统异常告警】';
    const timeStr = new Date().toLocaleString();
    const markdownContent = [
      `### 🚨 ${title}`,
      `> **告警时间**: ${timeStr}`,
      context.level ? `> **日志级别**: \`${context.level}\`` : '',
      context.path ? `> **请求路径**: \`${context.method || 'GET'} ${context.path}\`` : '',
      context.statusCode ? `> **状态码**: \`${context.statusCode}\`` : '',
      context.durationMs ? `> **耗时**: \`${context.durationMs} ms\`` : '',
      context.ip ? `> **来源 IP**: \`${context.ip}\`` : '',
      context.user ? `> **操作人**: \`${context.user}\`` : '',
      context.sql ? `> **SQL 语句**:\n\`\`\`sql\n${context.sql}\n\`\`\`` : '',
      context.message ? `> **错误详情**:\n${context.message}` : '',
      context.stack ? `> **堆栈信息**:\n\`\`\`text\n${String(context.stack).slice(0, 500)}\n\`\`\`` : '',
      context.aiSummary ? `> **🤖 AI 根因摘要**:\n${context.aiSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    switch (channelType) {
      case ALERT_CHANNELS.WECOM: {
        const webhookUrl = config?.webhookUrl;
        if (!webhookUrl) throw new Error('WeCom webhookUrl is required.');
        const res = await this.safeFetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
              content: markdownContent,
            },
          }),
        });
        const json: any = await res.json();
        if (json.errcode !== 0) {
          throw new Error(`WeCom API error: [${json.errcode}] ${json.errmsg}`);
        }
        break;
      }

      case ALERT_CHANNELS.DINGTALK: {
        let webhookUrl = config?.webhookUrl;
        if (!webhookUrl) throw new Error('DingTalk webhookUrl is required.');
        const secret = config?.secret;
        if (secret) {
          const timestamp = Date.now();
          const stringToSign = `${timestamp}\n${secret}`;
          const sign = encodeURIComponent(
            crypto.createHmac('sha256', secret).update(stringToSign).digest('base64'),
          );
          webhookUrl += `${webhookUrl.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
        }
        const res = await this.safeFetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
              title: title,
              text: markdownContent,
            },
          }),
        });
        const json: any = await res.json();
        if (json.errcode !== 0) {
          throw new Error(`DingTalk API error: [${json.errcode}] ${json.errmsg}`);
        }
        break;
      }

      case ALERT_CHANNELS.FEISHU: {
        const webhookUrl = config?.webhookUrl;
        if (!webhookUrl) throw new Error('Feishu webhookUrl is required.');
        const res = await this.safeFetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msg_type: 'interactive',
            card: {
              header: {
                title: { tag: 'plain_text', content: `🚨 ${title}` },
                template: 'red',
              },
              elements: [
                {
                  tag: 'markdown',
                  content: markdownContent,
                },
              ],
            },
          }),
        });
        const json: any = await res.json();
        if (json.code !== 0 && json.StatusCode !== 0) {
          throw new Error(`Feishu API error: [${json.code || json.StatusCode}] ${json.msg || json.StatusMessage}`);
        }
        break;
      }

      case ALERT_CHANNELS.CUSTOM_WEBHOOK: {
        const webhookUrl = config?.webhookUrl;
        if (!webhookUrl) throw new Error('Custom webhookUrl is required.');
        const method = (config?.method || 'POST').toUpperCase();
        const headers = config?.headers ? (typeof config.headers === 'string' ? JSON.parse(config.headers) : config.headers) : { 'Content-Type': 'application/json' };
        const res = await this.safeFetch(webhookUrl, {
          method,
          headers,
          body: JSON.stringify({
            title,
            time: timeStr,
            context,
            content: markdownContent,
          }),
        });
        // 非 2xx 视为投递失败，避免“发送成功”的假象
        if (!res.ok) {
          throw new Error(`Custom webhook responded HTTP ${res.status}`);
        }
        break;
      }

      case ALERT_CHANNELS.NOTIFICATION_MANAGER: {
        // 联动系统 notification manager：按真实接口 plugin.send({ channelName, message, triggerFrom }) 投递
        const channelName = config?.channelName || config?.channelId;
        if (!channelName) {
          throw new Error('Notification Manager channelName is required.');
        }
        const notificationPlugin = this.resolveNotificationPlugin();
        if (!notificationPlugin) {
          throw new Error('@nocobase/plugin-notification-manager is not enabled or not loaded.');
        }
        const message: Record<string, any> = {
          title,
          content: markdownContent,
          level: context.level,
          statusCode: context.statusCode,
          durationMs: context.durationMs,
          path: context.path,
          method: context.method,
          ip: context.ip,
          user: context.user,
          sql: context.sql,
          stack: context.stack,
          ...(context.extra || {}),
        };
        const result = await notificationPlugin.send({
          channelName: String(channelName),
          message,
          triggerFrom: 'logger-pro',
          data: { title },
        });
        if (result && result.status === 'failure') {
          throw new Error(`Notification Manager send failed: ${result.reason || 'unknown reason'}`);
        }
        break;
      }

      default:
        throw new Error(`Unsupported alert channel type: ${channelType}`);
    }
  }
}
