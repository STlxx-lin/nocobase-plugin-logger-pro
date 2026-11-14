import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, theme } from 'antd';
import { MarkdownRenderer, AIEngineBadge, AIThinkingPanel } from '../components/MarkdownRenderer';

describe('MarkdownRenderer & AIEngineBadge UI Unit Tests', () => {
  it('应正确渲染标题(含 h1-h6)、代码块(含语言与复制按钮)、列表、行内代码与表格(含紧跟段落的表格)', () => {
    const md = [
      '### 诊断报告',
      '##### 五级标题',
      '紧跟表格前的段落说明：',
      '| 指标 | 状态 | 耗时 |',
      '| :--- | :---: | ---: |',
      '| DB | **正常** | `12ms` |',
      '',
      '- 无序项 1',
      '1. 有序项 1',
      '',
      '```typescript',
      'const x = 1;',
      '```',
    ].join('\n');

    const html = renderToStaticMarkup(React.createElement(MarkdownRenderer, { content: md }));
    expect(html).toContain('诊断报告');
    expect(html).toContain('五级标题');
    expect(html).toContain('紧跟表格前的段落说明：');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('12ms');
    expect(html).toContain('<ul');
    expect(html).toContain('<ol');
    expect(html).toContain('typescript');
    expect(html).toContain('复制代码');
    expect(html).toContain('const x = 1;');
  });

  it('应拦截 javascript: 等不安全链接并仅渲染安全 http/https 链接', () => {
    const md = '[恶意链接](javascript:alert(1)) 和 [安全文档](https://docs.nocobase.com)';
    const html = renderToStaticMarkup(React.createElement(MarkdownRenderer, { content: md }));
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://docs.nocobase.com"');
  });

  it('应在亮色与暗黑主题下使用不同的主题 Token 颜色，无硬编码浅色', () => {
    const md = '`inline` 与\n```sql\nSELECT 1;\n```';
    const lightHtml = renderToStaticMarkup(
      React.createElement(
        ConfigProvider,
        { theme: { algorithm: theme.defaultAlgorithm } },
        React.createElement(MarkdownRenderer, { content: md }),
      ),
    );
    const darkHtml = renderToStaticMarkup(
      React.createElement(
        ConfigProvider,
        { theme: { algorithm: theme.darkAlgorithm } },
        React.createElement(MarkdownRenderer, { content: md }),
      ),
    );

    expect(lightHtml).not.toEqual(darkHtml);
    expect(darkHtml).not.toContain('#ffffff');
    expect(darkHtml).not.toContain('#fafafa');
  });

  it('AIEngineBadge 应准确区分流式生成中、真实 AI 与启发式兜底标签', () => {
    const streamingHtml = renderToStaticMarkup(
      React.createElement(AIEngineBadge, { streaming: true, engine: 'llm', llmService: 'qwen' }),
    );
    expect(streamingHtml).toContain('流式生成中');

    const llmHtml = renderToStaticMarkup(
      React.createElement(AIEngineBadge, { engine: 'llm', llmService: 'local-ollama', model: 'qwen2.5:7b' }),
    );
    expect(llmHtml).toContain('真实 AI · local-ollama / qwen2.5:7b');

    const heuristicByEngine = renderToStaticMarkup(
      React.createElement(AIEngineBadge, { engine: 'heuristic' }),
    );
    expect(heuristicByEngine).toContain('非真实 AI · 启发式兜底');

    const heuristicByLegacyFields = renderToStaticMarkup(
      React.createElement(AIEngineBadge, { llmService: 'builtin', model: 'heuristic' }),
    );
    expect(heuristicByLegacyFields).toContain('非真实 AI · 启发式兜底');
  });

  it('AIThinkingPanel 与 MarkdownRenderer 应正确展示等待、思考过程与流式文本生成提示', () => {
    const waitingHtml = renderToStaticMarkup(
      React.createElement(AIThinkingPanel, { streaming: true, hasContent: false }),
    );
    expect(waitingHtml).toContain('正在连接大模型并深度推理分析');

    const thinkingHtml = renderToStaticMarkup(
      React.createElement(AIThinkingPanel, {
        reasoning: '正在定位堆栈中的空指针来源',
        streaming: true,
        hasContent: false,
      }),
    );
    expect(thinkingHtml).toContain('AI 深度思考中');
    expect(thinkingHtml).toContain('正在定位堆栈中的空指针来源');

    const finishedThinkingHtml = renderToStaticMarkup(
      React.createElement(AIThinkingPanel, {
        reasoning: '思考完成记录',
        streaming: false,
        hasContent: true,
      }),
    );
    expect(finishedThinkingHtml).toContain('AI 思考过程');

    const streamingMdHtml = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, { content: '正在输出报告内容', streaming: true }),
    );
    expect(streamingMdHtml).toContain('正在实时生成文本');
    expect(streamingMdHtml).toContain('8 字');
  });
});
