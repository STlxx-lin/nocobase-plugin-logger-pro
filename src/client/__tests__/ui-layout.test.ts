import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, theme } from 'antd';
import { LoggerProPage } from '../pages/LoggerProPage';
import { DashboardTab } from '../components/DashboardTab';
import { ConfigTab } from '../components/ConfigTab';
import { LogConsoleTab } from '../components/LogConsoleTab';
import { AuditLogTab } from '../components/AuditLogTab';
import { TraceTab } from '../components/TraceTab';
import { AlertTab } from '../components/AlertTab';
import { DiffModal } from '../components/DiffModal';
import { LogFileManagerModal } from '../components/LogFileManagerModal';
import { TraceDrawer } from '../components/TraceDrawer';
import { LoggerProContext } from '../context/LoggerProContext';

const mockApi = {
  request: async () => ({ data: { data: {} } }),
};

const renderWithTheme = (node: React.ReactElement, isDark = false) =>
  renderToStaticMarkup(
    React.createElement(
      ConfigProvider,
      { theme: { algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm } },
      React.createElement(LoggerProContext.Provider, { value: { api: mockApi } }, node),
    ),
  );

describe('Logger Pro UI Simplification & Theme Tests', () => {
  it('LoggerProPage 应精简外层标题，无冗长副标题与 emoji，且渲染全部 6 个 Tab', () => {
    const html = renderWithTheme(React.createElement(LoggerProPage, { api: mockApi }));
    expect(html).toContain('日志与审计管理 Pro');
    expect(html).not.toContain('企业级系统运行日志控制台');
    expect(html).not.toContain('📜');
    expect(html).toContain('运维概览');
    expect(html).toContain('日志控制台');
    expect(html).toContain('操作审计');
    expect(html).toContain('全链路追踪');
    expect(html).toContain('日志配置');
    expect(html).toContain('异常告警');
  });

  it('DashboardTab 应只保留 4 个核心指标卡、7 日趋势、摘要与 AI 健康巡检按钮', () => {
    const html = renderWithTheme(React.createElement(DashboardTab));
    expect(html).toContain('AI 健康巡检');
    expect(html).toContain('今日操作审计量');
    expect(html).toContain('今日异常错误数');
    expect(html).toContain('今日告警触发');
    expect(html).toContain('日志磁盘占用');
    expect(html).toContain('近 7 天请求量与异常走势');
    expect(html).toContain('Top 慢 SQL 摘要');
    expect(html).toContain('运行分布与活跃摘要');
    expect(html).toContain('查看详情');
    expect(html).not.toContain('📊');
  });

  it('ConfigTab 主视图应精简为高频核心表单并保留唯一入口按钮', () => {
    const html = renderWithTheme(React.createElement(ConfigTab));
    expect(html).toContain('全局最低日志级别');
    expect(html).toContain('SQL 执行日志');
    expect(html).toContain('日志保留天数');
    expect(html).toContain('默认 AI 员工');
    expect(html).toContain('存储统计与清理');
    expect(html).toContain('AI 高级与过滤策略');
    // 主视图不应重复出现两个相同入口按钮
    expect(html.split('存储统计与清理').length - 1).toBe(1);
    // 主视图不应直接展开插件数据表明细表
    expect(html).not.toContain('插件数据表明细与空间释放');
  });

  it('列表页 (LogConsoleTab / AuditLogTab / TraceTab / AlertTab) 应精简渲染且无多余 emoji', () => {
    const consoleHtml = renderWithTheme(React.createElement(LogConsoleTab));
    expect(consoleHtml).toContain('Tail');
    expect(consoleHtml).toContain('AI 诊断');
    expect(consoleHtml).toContain('文件管理');
    expect(consoleHtml).not.toContain('💻');

    const auditHtml = renderWithTheme(React.createElement(AuditLogTab));
    expect(auditHtml).toContain('AI 筛选');
    expect(auditHtml).toContain('目标数据表');
    expect(auditHtml).toContain('操作类型');
    expect(auditHtml).not.toContain('客户端 IP');
    expect(auditHtml).not.toContain('✨');

    const traceHtml = renderWithTheme(React.createElement(TraceTab));
    expect(traceHtml).toContain('追踪请求');
    expect(traceHtml).toContain('最近 API 请求记录');
    expect(traceHtml).not.toContain('全生命周期时序瀑布流');

    const alertHtml = renderWithTheme(React.createElement(AlertTab));
    expect(alertHtml).toContain('告警规则');
    expect(alertHtml).toContain('告警历史');
    expect(alertHtml).toContain('新建规则');
    expect(alertHtml).not.toContain('🔔');
    expect(alertHtml).not.toContain('静默周期');
  });

  it('暗黑主题下所有核心页面不应出现硬编码浅色 #fafafa 或 #ffffff', () => {
    const pages = [
      React.createElement(LoggerProPage, { api: mockApi }),
      React.createElement(DashboardTab),
      React.createElement(ConfigTab),
      React.createElement(AuditLogTab),
      React.createElement(TraceTab),
      React.createElement(AlertTab),
    ];
    for (const p of pages) {
      const darkHtml = renderWithTheme(p, true);
      expect(darkHtml).not.toContain('#fafafa');
      expect(darkHtml).not.toContain('#ffffff');
    }
  });

  it('边界条件：Drawer/Modal 组件在空记录或异常时间字段下应安全渲染且无多余 emoji', () => {
    expect(() =>
      renderWithTheme(React.createElement(DiffModal, { visible: false, onClose: () => {}, record: null })),
    ).not.toThrow();
    expect(() =>
      renderWithTheme(React.createElement(LogFileManagerModal, { visible: false, onClose: () => {} })),
    ).not.toThrow();
    expect(() =>
      renderWithTheme(React.createElement(TraceDrawer, { visible: false, reqId: null, onClose: () => {} })),
    ).not.toThrow();

    const diffHtml = renderWithTheme(
      React.createElement(DiffModal, {
        visible: true,
        onClose: () => {},
        record: {
          id: 1,
          collectionName: 'users',
          actionName: 'destroy',
          createdAt: null,
          beforeData: { id: 1, roles: [{ id: 2 }] },
          afterData: null,
        },
      }),
    );
    expect(diffHtml).not.toContain('Invalid Date');
    expect(diffHtml).not.toContain('📦');
    expect(diffHtml).not.toContain('🗑️');
  });
});
