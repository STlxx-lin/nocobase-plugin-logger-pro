import React, { useState, useEffect } from 'react';
import { Card, Tabs, theme } from 'antd';
import {
  DashboardOutlined,
  CodeOutlined,
  AuditOutlined,
  SettingOutlined,
  BellOutlined,
  DeploymentUnitOutlined,
} from '@ant-design/icons';
import { DashboardTab } from '../components/DashboardTab';
import { LogConsoleTab } from '../components/LogConsoleTab';
import { AuditLogTab } from '../components/AuditLogTab';
import { TraceTab } from '../components/TraceTab';
import { ConfigTab } from '../components/ConfigTab';
import { AlertTab } from '../components/AlertTab';
import { LoggerProContext } from '../context/LoggerProContext';

export interface LoggerProPageProps {
  api?: any;
}

export const LoggerProPage: React.FC<LoggerProPageProps> = ({ api }) => {
  const { token } = theme.useToken();
  const [activeTab, setActiveTab] = useState('dashboard');
  // 首次进入某 Tab 才挂载，之后保持挂载：避免一次进入页面就并发 6 个重接口
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set(['dashboard']));

  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev.has(activeTab)) return prev;
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  const lazyTab = (key: string, node: React.ReactNode) =>
    mountedTabs.has(key) ? node : <div style={{ minHeight: 120 }} />;

  return (
    <LoggerProContext.Provider value={{ api }}>
      <div style={{ padding: '16px 24px', background: token.colorBgLayout, minHeight: '100%' }}>
        <Card
          bordered={false}
          style={{
            boxShadow: token.boxShadowTertiary,
            borderRadius: token.borderRadiusLG,
            background: token.colorBgContainer,
          }}
          bodyStyle={{ padding: '12px 24px 20px' }}
        >
          <div style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: token.colorText }}>
              日志与审计管理 Pro
            </h2>
          </div>

          <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          type="line"
          size="large"
          items={[
            {
              key: 'dashboard',
              label: (
                <span>
                  <DashboardOutlined /> 运维概览
                </span>
              ),
              children: lazyTab('dashboard', <DashboardTab />),
            },
            {
              key: 'console',
              label: (
                <span>
                  <CodeOutlined /> 日志控制台
                </span>
              ),
              children: lazyTab('console', <LogConsoleTab />),
            },
            {
              key: 'audit',
              label: (
                <span>
                  <AuditOutlined /> 操作审计
                </span>
              ),
              children: lazyTab('audit', <AuditLogTab />),
            },
            {
              key: 'trace',
              label: (
                <span>
                  <DeploymentUnitOutlined /> 全链路追踪
                </span>
              ),
              children: lazyTab('trace', <TraceTab />),
            },
            {
              key: 'config',
              label: (
                <span>
                  <SettingOutlined /> 日志配置
                </span>
              ),
              children: lazyTab('config', <ConfigTab />),
            },
            {
              key: 'alert',
              label: (
                <span>
                  <BellOutlined /> 异常告警
                </span>
              ),
              children: lazyTab('alert', <AlertTab />),
            },
          ]}
        />
      </Card>
    </div>
    </LoggerProContext.Provider>
  );
};

export default LoggerProPage;
