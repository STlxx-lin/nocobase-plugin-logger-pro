import { describe, it, expect } from 'vitest';
import { createThinkStreamSplitter } from '../services/ai-analyzer.service';

describe('createThinkStreamSplitter 流式思考分离器测试', () => {
  it('应正确分离跨 chunk 拆分的 <think>...</think> 思考过程与正文输出', () => {
    const texts: string[] = [];
    const reasonings: string[] = [];
    const splitter = createThinkStreamSplitter(
      (t) => texts.push(t),
      (r) => reasonings.push(r),
    );

    const chunks = [
      '<thi',
      'nk>第一步分析日志堆栈\n',
      '第二步检查数据库',
      '</thi',
      'nk>\n### 诊断结论\n问题已定位。',
    ];
    for (const c of chunks) {
      splitter.pushText(c);
    }
    const result = splitter.flush();

    expect(reasonings.join('')).toBe('第一步分析日志堆栈\n第二步检查数据库');
    expect(texts.join('')).toBe('\n### 诊断结论\n问题已定位。');
    expect(result.reasoningContent).toBe('第一步分析日志堆栈\n第二步检查数据库');
    expect(result.content).toBe('\n### 诊断结论\n问题已定位。');
  });

  it('无 <think> 标签时应原样透传正文，并支持直接 pushReasoning', () => {
    const texts: string[] = [];
    const reasonings: string[] = [];
    const splitter = createThinkStreamSplitter(
      (t) => texts.push(t),
      (r) => reasonings.push(r),
    );

    splitter.pushReasoning('推理增量1');
    splitter.pushReasoning('推理增量2');
    splitter.pushText('正文内容A');
    splitter.pushText('正文内容B');
    const result = splitter.flush();

    expect(reasonings.join('')).toBe('推理增量1推理增量2');
    expect(texts.join('')).toBe('正文内容A正文内容B');
    expect(result.reasoningContent).toBe('推理增量1推理增量2');
    expect(result.content).toBe('正文内容A正文内容B');
  });
});
