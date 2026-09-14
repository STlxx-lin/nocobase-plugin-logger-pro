import React from 'react';
import { Plugin } from '@nocobase/client-v2';
import { LoggerProPage } from '../client/pages/LoggerProPage';
import { useAPIClient as useV2APIClient } from './hooks/useAPIClient';

const V2LoggerProPageWrapper: React.FC = () => {
  const api = useV2APIClient();
  return React.createElement(LoggerProPage, { api });
};

export class PluginLoggerProClientV2 extends Plugin {
  async load() {
    const manager = this.app.pluginSettingsManager as any;
    if (!manager) return;

    let title = '日志管理 Pro';
    try {
      const i18n = this.app?.i18n;
      const res = i18n?.t ? i18n.t('Logger Pro', { ns: ['@nocobase/plugin-logger-pro', 'client'] }) : null;
      if (res && res !== 'Logger Pro') {
        title = res;
      } else {
        const lang = (i18n?.language || (typeof window !== 'undefined' ? localStorage.getItem('NOCOBASE_LOCALE') : '') || '').toLowerCase();
        title = (!lang || lang.startsWith('zh')) ? '日志管理 Pro' : (res || 'Logger Pro');
      }
    } catch (e) {
      title = '日志管理 Pro';
    }
    const icon = 'FileTextOutlined';
    const menuKey = 'logger-pro';
    const pageName = `${menuKey}.index`;

    // 适配 NocoBase V2 现代菜单体系
    if (typeof manager.addMenuItem === 'function' && typeof manager.addPageTabItem === 'function') {
      manager.addMenuItem({
        key: menuKey,
        title,
        icon,
        aclSnippet: 'pm',
      });

      manager.addPageTabItem({
        menuKey,
        key: 'index',
        title,
        icon,
        aclSnippet: 'pm',
        Component: V2LoggerProPageWrapper,
      });

      const pluginNames = [
        this.options?.name,
        this.options?.packageName,
        'logger-pro',
        '@nocobase/plugin-logger-pro',
      ].filter(Boolean);

      [...new Set(pluginNames)].forEach((pluginName) => {
        manager.setPluginSettingsLink?.(pluginName, pageName);
      });
      return;
    }

    // 兼容传统模式
    if (typeof manager.add === 'function') {
      manager.add(menuKey, {
        title,
        icon,
        aclSnippet: 'pm',
        Component: V2LoggerProPageWrapper,
      });
    }
  }
}

export default PluginLoggerProClientV2;

