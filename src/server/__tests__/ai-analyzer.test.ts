import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { createMockServer, MockServer } from '@nocobase/test';
import PluginLoggerProServer from '../index';
import {
  sanitizeLogText,
  compressLogContext,
  clusterErrorLines,
  sanitizeNLFilter,
  buildNL2FilterResponse,
  heuristicNLToFilter,
} from '../services/ai-sanitizer';
import { AIAnalyzerService } from '../services/ai-analyzer.service';
import { CONFIG_KEYS } from '../constants';

describe('AI Analyzer & Proactive Ops Test Suite', () => {
  describe('1. 敏感信息脱敏与日志上下文压缩 (ai-sanitizer)', () => {
    it('应自动掩码 Bearer Token、JWT、API Key、密码、数据库连接串、邮箱与手机号', () => {
      const raw = [
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefg123456.xyz987654',
        'OPENAI_KEY=sk-proj-1234567890abcdefg',
        '{"password": "MySecretPassword123!", "apiKey": "ak-9876543210abcdef"}',
        'Error connecting to postgres://dbadmin:SuperPass99@10.0.0.5:5432/prod_db',
        'User alice.wang@example.com with phone 13812345678 failed login',
      ].join('\n');

      const res = sanitizeLogText(raw);
      expect(res.maskedCount).toBeGreaterThanOrEqual(6);
      expect(res.sanitized).not.toContain('MySecretPassword123!');
      expect(res.sanitized).not.toContain('SuperPass99');
      expect(res.sanitized).not.toContain('sk-proj-1234567890abcdefg');
      expect(res.sanitized).not.toContain('alice.wang@example.com');
      expect(res.sanitized).not.toContain('13812345678');
      expect(res.sanitized).toContain('138****5678');
      expect(res.sanitized).toContain('postgres://***:***@10.0.0.5:5432/prod_db');

      // 带空格的引号密码应完整脱敏，不泄露后半段
      const spaced = sanitizeLogText('{"password": "my secret pass 123", "secret": \'top secret value\'}');
      expect(spaced.sanitized).not.toContain('my secret');
      expect(spaced.sanitized).not.toContain('pass 123');
      expect(spaced.sanitized).not.toContain('top secret');
      expect(spaced.sanitized).not.toContain('value');
    });

    it('应折叠连续重复的相似日志行并在超长预算时保留关键错误帧', () => {
      const repeated = Array.from({ length: 20 }, (_, i) =>
        `2026-11-14 10:00:${String(i).padStart(2, '0')} [info] Heartbeat check reqId=abc-${i} ok`,
      );
      const lines = [
        ...repeated,
        '2026-11-14 10:01:00 [error] TypeError: Cannot read properties of undefined (reading "repository")',
        '    at BasicAuth.checkToken (/app/auth.js:246:12)',
      ];
      const res = compressLogContext(lines.join('\n'), 500);
      expect(res.deduplicatedLines).toBe(19);
      expect(res.compressed).toContain('similar log repeated 19 more times');
      expect(res.compressed).toContain('TypeError: Cannot read properties of undefined');
      expect(res.compressedLength).toBeLessThanOrEqual(500);
    });
  });

  describe('2. 错误日志指纹聚类去重 (clusterErrorLines)', () => {
    it('应将时间戳、UUID、IP、数字不同的同类错误聚为一簇并按频次降序', () => {
      const logs = [
        '2026-11-14 10:00:01 [error] Connection timeout to 192.168.1.10:5432 reqId=11111111-1111-1111-1111-111111111111',
        '2026-11-14 10:00:05 [error] Connection timeout to 192.168.1.11:5432 reqId=22222222-2222-2222-2222-222222222222',
        '2026-11-14 10:00:09 [error] Connection timeout to 10.0.0.8:5432 reqId=33333333-3333-3333-3333-333333333333',
        '2026-11-14 10:01:00 [warn] [Workflow pre-action]: collection "loggerPro" not found',
        '2026-11-14 10:02:00 [info] Normal request finished in 12ms',
      ];
      const clusters = clusterErrorLines(logs);
      expect(clusters.length).toBe(2);
      expect(clusters[0].count).toBe(3);
      expect(clusters[0].level).toBe('ERROR');
      expect(clusters[1].count).toBe(1);
      expect(clusters[1].level).toBe('WARN');
    });
  });

  describe('3. NL2Filter 白名单安全校验与启发式解析', () => {
    it('应严格剥离非白名单字段、SQL 注入与原型污染键', () => {
      const dirty = {
        $raw: '1=1; DROP TABLE users;--',
        $sql: 'SELECT * FROM users',
        __proto__: { polluted: true },
        unknownField: 'evil',
        method: 'delete',
        collectionName: 'users',
        statusCode: { $gte: 500, $raw: 'bad' },
      };
      const clean = sanitizeNLFilter(dirty, ['users', 'orders']);
      expect(clean.$raw).toBeUndefined();
      expect(clean.$sql).toBeUndefined();
      expect(clean.unknownField).toBeUndefined();
      expect(clean.method).toBe('DELETE');
      expect(clean.collectionName).toBe('users');
      expect(clean.statusCode).toEqual({ $gte: 500 });
    });

    it('启发式解析器应识别时间范围、用户、集合、动作与状态码', () => {
      const res = heuristicNLToFilter('昨天 用户 admin 删除 users 表的 500 错误', ['users', 'posts']);
      expect(res.success).toBe(true);
      expect(res.engine).toBe('heuristic');
      expect(res.filter.createdAt).toBeDefined();
      expect(res.filter.userUsername).toEqual({ $includes: 'admin' });
      expect(res.filter.collectionName).toBe('users');
      expect(res.filter.statusCode).toEqual({ $gte: 500 });
      expect(res.tags.length).toBeGreaterThanOrEqual(4);
    });

    it('buildNL2FilterResponse 应对 $eq 与 $in 状态码生成对应标签', () => {
      const eqRes = buildNL2FilterResponse({ statusCode: { $eq: 502 } }, 'llm', 'ok');
      expect(eqRes.uiFields.statusFilter).toBe('error');
      expect(eqRes.tags.some((t) => t.label.includes('502'))).toBe(true);

      const inRes = buildNL2FilterResponse({ statusCode: { $in: [500, 503] } }, 'llm', 'ok');
      expect(inRes.uiFields.statusFilter).toBe('error');
      expect(inRes.tags.some((t) => t.label.includes('500, 503'))).toBe(true);
    });
  });

  describe('4. 本地/内网 LLM 安全策略 (Ollama 放行 + 元数据地址始终阻断)', () => {
    it('默认信任 localhost 与内网 IP，但始终阻断云元数据与非 http 协议', () => {
      const mockConfig = {
        getBoolean: (k: string, d: boolean) => (k === CONFIG_KEYS.AI_ALLOW_PRIVATE_LLM ? true : d),
        getNumber: (_k: string, d: number) => d,
      } as any;
      const svc = new AIAnalyzerService({} as any, mockConfig);

      expect(() => svc.assertSafeLLMUrl('http://localhost:11434/v1/chat/completions')).not.toThrow();
      expect(() => svc.assertSafeLLMUrl('http://127.0.0.1:11434/v1/chat/completions')).not.toThrow();
      expect(() => svc.assertSafeLLMUrl('http://192.168.1.100:11434/v1/chat/completions')).not.toThrow();

      expect(() => svc.assertSafeLLMUrl('http://169.254.169.254/latest/meta-data')).toThrow(/元数据/);
      expect(() => svc.assertSafeLLMUrl('http://100.100.100.200/latest/meta-data')).toThrow(/元数据/);
      expect(() => svc.assertSafeLLMUrl('http://metadata.google.internal/computeMetadata')).toThrow(/元数据/);
      expect(() => svc.assertSafeLLMUrl('file:///etc/passwd')).toThrow(/协议/);
    });

    it('关闭 ai_allow_private_llm 时应阻断 localhost 与私有 IP', () => {
      const mockConfig = {
        getBoolean: (k: string, d: boolean) => (k === CONFIG_KEYS.AI_ALLOW_PRIVATE_LLM ? false : d),
        getNumber: (_k: string, d: number) => d,
      } as any;
      const svc = new AIAnalyzerService({} as any, mockConfig);

      expect(() => svc.assertSafeLLMUrl('http://localhost:11434/v1/chat/completions')).toThrow(/禁止/);
      expect(() => svc.assertSafeLLMUrl('http://192.168.1.100:11434/v1/chat/completions')).toThrow(/禁止/);
      expect(() => svc.assertSafeLLMUrl('https://api.openai.com/v1/chat/completions')).not.toThrow();
    });
  });

  describe('5. MockServer + 本地 Mock Ollama LLM 端到端集成测试', () => {
    let app: MockServer;
    let mockLLMServer: http.Server;
    let mockLLMPort = 0;
    let slowMode = false;

    beforeAll(async () => {
      // 启动本地 Mock OpenAI/Ollama 兼容服务器
      mockLLMServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (slowMode) {
            setTimeout(() => {
              if (!res.writableEnded) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: 'late reply' } }] }));
              }
            }, 500);
            return;
          }

          if (parsed.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
            });
            const sysContent = String(parsed.messages?.[0]?.content || '');
            const chunkText = sysContent.includes('SRE')
              ? '### 🩺 系统健康巡检报告\n- 综合健康评分: 95/100'
              : '### 流式诊断\n根因已定位。';
            if (sysContent.includes('SRE')) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunkText } }] })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '### 流式诊断\n' } }] })}\n\n`);
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '根因已定位。' } }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            const sysContent = String(parsed.messages?.[0]?.content || '');
            const userContent = String(parsed.messages?.[1]?.content || '');
            let replyContent = '### 同步诊断报告\n- 连接本地 Ollama 成功';
            if (sysContent.includes('审计日志查询条件转换器')) {
              replyContent = JSON.stringify({
                filter: {
                  userUsername: { $includes: 'admin' },
                  statusCode: { $gte: 400 },
                },
                explanation: '已通过真实 LLM 解析 admin 失败请求',
              });
            } else if (sysContent.includes('SRE') || userContent.includes('健康巡检')) {
              replyContent = '### 🩺 系统健康巡检报告\n- 综合健康评分: **96 / 100** (真实 LLM)';
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: replyContent,
                    },
                  },
                ],
              }),
            );
          }
        });
      });

      await new Promise<void>((resolve) => {
        mockLLMServer.listen(0, '127.0.0.1', () => {
          mockLLMPort = (mockLLMServer.address() as any).port;
          resolve();
        });
      });

      app = await createMockServer({
        plugins: [[PluginLoggerProServer, { name: 'logger-pro' }]],
      });
      await app.load();
      await app.db.sync();
      await app.start();

      // 创建一张模拟 llm_services 表供直连测试
      await app.db.sequelize.query(`
        CREATE TABLE IF NOT EXISTS llm_services (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name VARCHAR(255),
          title VARCHAR(255),
          provider VARCHAR(255),
          options TEXT
        )
      `);
      await app.db.sequelize.query(
        `INSERT INTO llm_services (name, title, provider, options) VALUES (?, ?, ?, ?)`,
        {
          replacements: [
            'local-ollama',
            'Local Ollama',
            'ollama',
            JSON.stringify({ baseURL: `http://127.0.0.1:${mockLLMPort}`, model: 'qwen2.5:7b' }),
          ],
        },
      );
    }, 30000);

    afterAll(async () => {
      if (app) await app.stop();
      if (mockLLMServer) await new Promise<void>((r) => mockLLMServer.close(() => r()));
    });

    it('应支持连接本地 Ollama 服务进行同步诊断、流式 SSE 诊断及多轮追问持久化', async () => {
      const plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;
      const aiSvc: AIAnalyzerService = plugin.aiAnalyzerService;

      // 1. 同步调用本地 Ollama
      const syncRes = await aiSvc.analyzeLog({
        logText: '2026-11-14 [error] Bearer secret-token-123 failed',
        llmSelection: { llmService: 'local-ollama', model: 'qwen2.5:7b' },
      });
      expect(syncRes.success).toBe(true);
      expect(syncRes.analysisReport).toContain('连接本地 Ollama 成功');
      expect(syncRes.id).toBeDefined();
      expect(syncRes.maskedCount).toBeGreaterThanOrEqual(1);

      // 2. 多轮追问并校验 logger_ai_records.messages 持久化及每条消息的引擎元数据
      const followRes = await aiSvc.followUpChat({
        recordId: syncRes.id,
        question: '如何修复？',
        llmSelection: { llmService: 'local-ollama', model: 'qwen2.5:7b' },
      });
      expect(followRes.success).toBe(true);
      expect(followRes.messages.length).toBe(4);
      expect(followRes.messages[1].engine).toBe('llm');
      expect(followRes.messages[3].engine).toBe('llm');
      expect(followRes.messages[3].llmService).toBe('local-ollama');

      // 2.1 在同一会话中显式切换为内置规则兜底追问，各气泡应保留各自真实引擎标注
      const followFallback = await aiSvc.followUpChat({
        recordId: syncRes.id,
        question: '给出修复代码',
        forceHeuristic: true,
      });
      expect(followFallback.success).toBe(true);
      expect(followFallback.engine).toBe('heuristic');
      expect(followFallback.messages.length).toBe(6);
      expect(followFallback.messages[3].engine).toBe('llm');
      expect(followFallback.messages[5].engine).toBe('heuristic');
      expect(followFallback.messages[5].llmService).toBe('builtin');

      const loaded = await aiSvc.getAnalysisRecord(syncRes.id!);
      expect(Array.isArray(loaded.messages)).toBe(true);
      expect(loaded.messages.length).toBe(6);
      expect(loaded.messages[2].content).toBe('如何修复？');
      expect(loaded.messages[5].engine).toBe('heuristic');

      // 3. 流式 SSE 诊断
      const chunks: string[] = [];
      let doneResult: any = null;
      await aiSvc.analyzeLogStream(
        {
          logText: '2026-11-14 [error] Stream test error',
          llmSelection: { llmService: 'local-ollama', model: 'qwen2.5:7b' },
        },
        {
          onChunk: (c) => chunks.push(c),
          onDone: (r) => (doneResult = r),
        },
      );
      expect(chunks.join('')).toBe('### 流式诊断\n根因已定位。');
      expect(doneResult?.success).toBe(true);
    });

    it('告警 AI 摘要超时时应自动降级为启发式摘要，绝不抛错阻塞', async () => {
      const plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;
      const aiSvc: AIAnalyzerService = plugin.aiAnalyzerService;

      slowMode = true;
      const summaryRes = await aiSvc.generateAlertRootCauseSummary(
        { title: 'Slow SQL', durationMs: 2500, statusCode: 500, message: 'ETIMEDOUT' },
        { timeoutMs: 80, llmSelection: { llmService: 'local-ollama', model: 'qwen2.5:7b' } },
      );
      slowMode = false;

      expect(summaryRes.engine).toBe('heuristic');
      expect(summaryRes.summary).toContain('2500ms');
      expect(summaryRes.summary).toContain('HTTP 500');
    });

    it('HTTP API 接口 (nlToFilter / clusterErrorLogs / previewSanitizedLog / healthInspection) 应正常响应', async () => {
      const agent = app.agent();

      const previewRes = await agent.post('/loggerPro:previewSanitizedLog').send({
        logText: 'Authorization: Bearer my-secret-jwt-token\n13900001111',
        sanitize: true,
      });
      expect(previewRes.status).toBe(200);
      const previewData = previewRes.body?.data || previewRes.body;
      expect(previewData.maskedCount).toBeGreaterThanOrEqual(2);
      expect(previewData.processedText).not.toContain('my-secret-jwt-token');

      const clusterRes = await agent.post('/loggerPro:clusterErrorLogs').send({
        logLines: [
          '2026-11-14 10:00:01 [error] DB failed id=1',
          '2026-11-14 10:00:02 [error] DB failed id=2',
        ],
      });
      expect(clusterRes.status).toBe(200);
      const clusterData = clusterRes.body?.data || clusterRes.body;
      expect(clusterData.totalClusters).toBe(1);
      expect(clusterData.clusters[0].count).toBe(2);

      const nlRes = await agent.post('/loggerPro:nlToFilter').send({
        query: '昨天 admin 删除失败的请求',
      });
      expect(nlRes.status).toBe(200);
      const nlData = nlRes.body?.data || nlRes.body;
      expect(nlData.success).toBe(true);
      expect(nlData.engine).toBe('llm');
      expect(nlData.llmService).toBe('local-ollama');
      expect(nlData.filter.userUsername).toEqual({ $includes: 'admin' });
      expect(nlData.filter.statusCode).toEqual({ $gte: 400 });

      const inspectRes = await agent.post('/loggerPro:healthInspection').send({});
      expect(inspectRes.status).toBe(200);
      const inspectData = inspectRes.body?.data || inspectRes.body;
      expect(inspectData.success).toBe(true);
      expect(inspectData.engine).toBe('llm');
      expect(inspectData.llmService).toBe('local-ollama');
      expect(inspectData.analysisReport).toContain('健康巡检报告');

      const latestRes = await agent.get('/loggerPro:getLatestHealthInspection');
      expect(latestRes.status).toBe(200);
      const latestData = latestRes.body?.data || latestRes.body;
      expect(latestData.analysisReport).toContain('健康巡检报告');

      // 按 recordType 过滤历史记录
      const plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;
      const healthHist = await plugin.aiAnalyzerService.getAnalysisHistory({ recordType: 'health_inspection' });
      expect(healthHist.rows.length).toBeGreaterThanOrEqual(1);
      expect(healthHist.rows.every((r: any) => r.recordType === 'health_inspection')).toBe(true);
    });

    it('未传 llmSelection 时应自动读取插件默认配置或首个可用真实 LLM 服务', async () => {
      const plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;
      const aiSvc = plugin.aiAnalyzerService;

      // 1. 未设置默认服务时自动选用首个可用真实 LLM (local-ollama)
      const autoRes = await aiSvc.analyzeLog({
        logText: '2026-11-14 [error] Auto select first LLM',
      });
      expect(autoRes.success).toBe(true);
      expect(autoRes.engine).toBe('llm');
      expect(autoRes.llmService).toBe('local-ollama');

      // 2. 配置默认 LLM 服务与模型后应优先使用配置值
      await plugin.configService.updateAll({
        [CONFIG_KEYS.AI_DEFAULT_LLM_SERVICE]: 'local-ollama',
        [CONFIG_KEYS.AI_DEFAULT_LLM_MODEL]: 'qwen2.5:14b',
      });
      const cfgRes = await aiSvc.analyzeLog({
        logText: '2026-11-14 [error] Use configured default LLM',
      });
      expect(cfgRes.success).toBe(true);
      expect(cfgRes.engine).toBe('llm');
      expect(cfgRes.llmService).toBe('local-ollama');
      expect(cfgRes.model).toBe('qwen2.5:14b');

      // 清理默认配置
      await plugin.configService.updateAll({
        [CONFIG_KEYS.AI_DEFAULT_LLM_SERVICE]: '',
        [CONFIG_KEYS.AI_DEFAULT_LLM_MODEL]: '',
      });
    });

    it('llm_services 缺少 baseURL 时应返回结构化配置错误而不抛出 Invalid URL', async () => {
      await app.db.sequelize.query(
        `INSERT INTO llm_services (name, title, provider, options) VALUES (?, ?, ?, ?)`,
        {
          replacements: ['no-url-custom', 'No URL Custom', 'custom-local', JSON.stringify({ apiKey: 'sk-only-key' })],
        },
      );
      const plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;
      const res = await plugin.aiAnalyzerService.analyzeLog({
        logText: '2026-11-14 [error] Test missing baseURL error',
        llmSelection: { llmService: 'no-url-custom', model: 'default' },
      });
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('LLM_CALL_FAILED');
      expect(res.errorMessage).toContain('baseURL');
    });

    it('无可用 LLM 服务时主动触发的 AI 功能应明确报错，传入 forceHeuristic 时走内置规则兜底', async () => {
      const plugin = app.pm.get(PluginLoggerProServer) as PluginLoggerProServer;
      const aiSvc = plugin.aiAnalyzerService;

      // 临时清空 llm_services 模拟未配置 LLM
      await app.db.sequelize.query('DELETE FROM llm_services');

      const diagErr = await aiSvc.analyzeLog({ logText: '2026-11-14 [error] No LLM test' });
      expect(diagErr.success).toBe(false);
      expect(diagErr.errorCode).toBe('LLM_NOT_CONFIGURED');

      const followErr = await aiSvc.followUpChat({ question: '怎么修？', logText: 'Error: x' });
      expect(followErr.success).toBe(false);
      expect(followErr.errorCode).toBe('LLM_NOT_CONFIGURED');

      const inspectErr = await aiSvc.runHealthInspection({ summary: {} }, []);
      expect(inspectErr.success).toBe(false);
      expect(inspectErr.errorCode).toBe('LLM_NOT_CONFIGURED');

      const nlErr = await aiSvc.naturalLanguageToFilter('昨天 admin 失败请求', ['users']);
      expect(nlErr.success).toBe(false);
      expect(nlErr.errorCode).toBe('LLM_NOT_CONFIGURED');

      // 流式接口在无可用 LLM 时同样应通过 onError 返回 LLM_NOT_CONFIGURED
      let streamDiagErr: any = null;
      await aiSvc.analyzeLogStream(
        { logText: '2026-11-14 [error] Stream no LLM' },
        { onChunk: () => {}, onError: (e) => (streamDiagErr = e) },
      );
      expect(streamDiagErr?.code).toBe('LLM_NOT_CONFIGURED');

      let streamFollowErr: any = null;
      await aiSvc.followUpChatStream(
        { question: '怎么修？', logText: 'Error: x' },
        { onChunk: () => {}, onDone: () => {}, onError: (e) => (streamFollowErr = e) },
      );
      expect(streamFollowErr?.code).toBe('LLM_NOT_CONFIGURED');

      let streamInspectErr: any = null;
      await aiSvc.runHealthInspectionStream(
        { summary: {} },
        [],
        undefined,
        { onChunk: () => {}, onError: (e) => (streamInspectErr = e) },
      );
      expect(streamInspectErr?.code).toBe('LLM_NOT_CONFIGURED');

      // 显式传入 forceHeuristic: true 时应走内置规则兜底并标注 heuristic
      const diagFallback = await aiSvc.analyzeLog({
        logText: '2026-11-14 [error] No LLM fallback test',
        forceHeuristic: true,
      });
      expect(diagFallback.success).toBe(true);
      expect(diagFallback.engine).toBe('heuristic');
      expect(diagFallback.llmService).toBe('builtin');

      const nlFallback = await aiSvc.naturalLanguageToFilter('昨天 admin 失败请求', ['users'], undefined, {
        forceHeuristic: true,
      });
      expect(nlFallback.success).toBe(true);
      expect(nlFallback.engine).toBe('heuristic');

      // 恢复 local-ollama 供后续可能的测试使用
      await app.db.sequelize.query(
        `INSERT INTO llm_services (name, title, provider, options) VALUES (?, ?, ?, ?)`,
        {
          replacements: [
            'local-ollama',
            'Local Ollama',
            'ollama',
            JSON.stringify({ baseURL: `http://127.0.0.1:${mockLLMPort}`, model: 'qwen2.5:7b' }),
          ],
        },
      );
    });
  });
});
