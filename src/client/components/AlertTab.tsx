import React, { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Button,
  Space,
  Tag,
  Switch,
  Form,
  Input,
  Select,
  InputNumber,
  message,
  Popconfirm,
  Drawer,
  Descriptions,
  theme,
} from 'antd';
import {
  PlusOutlined,
  SendOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HistoryOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useLoggerProAPI } from '../context/LoggerProContext';

export const AlertTab: React.FC = () => {
  const { token } = theme.useToken();
  const api = useLoggerProAPI();
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<any[]>([]);

  // 规则创建/编辑右侧 Drawer
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [editingRule, setEditingRule] = useState<any>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [drawerForm] = Form.useForm();
  const [channelType, setChannelType] = useState<string>('wecom');
  const [ruleType, setRuleType] = useState<string>('error_log');

  // 测试发送状态
  const [testingId, setTestingId] = useState<number | null>(null);

  // 历史记录抽屉
  const [historyDrawerVisible, setHistoryDrawerVisible] = useState(false);
  const [historyLogs, setHistoryLogs] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // 1. 获取告警规则
  const fetchRules = async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'logger_alert_rules:list',
        params: { sort: ['-createdAt'] },
      });
      setRules(res?.data?.data || []);
    } catch (err: any) {
      message.error(`加载告警规则失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 2. 加载告警历史
  const fetchHistoryLogs = async () => {
    setHistoryLoading(true);
    try {
      const res = await api.request({
        url: 'logger_alert_logs:list',
        params: { pageSize: 50, sort: ['-createdAt'] },
      });
      setHistoryLogs(res?.data?.data || []);
    } catch {} finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  // 打开创建/编辑右侧 Drawer
  const handleOpenDrawer = (rule?: any) => {
    setEditingRule(rule || null);
    if (rule) {
      setChannelType(rule.channelType);
      setRuleType(rule.type);
      drawerForm.setFieldsValue({
        name: rule.name,
        type: rule.type,
        channelType: rule.channelType,
        silenceMinutes: rule.silenceMinutes || 5,
        enabled: rule.enabled !== false,
        aiSummaryEnabled: rule.aiSummaryEnabled === true,
        keyword: rule.condition?.keyword,
        thresholdMs: rule.condition?.thresholdMs || 1000,
        webhookUrl: rule.channelConfig?.webhookUrl,
        secret: rule.channelConfig?.secret,
        method: rule.channelConfig?.method || 'POST',
        channelId: rule.channelConfig?.channelId,
      });
    } else {
      setChannelType('wecom');
      setRuleType('error_log');
      drawerForm.resetFields();
      drawerForm.setFieldsValue({
        type: 'error_log',
        channelType: 'wecom',
        silenceMinutes: 5,
        enabled: true,
        aiSummaryEnabled: false,
        thresholdMs: 1000,
        method: 'POST',
      });
    }
    setDrawerVisible(true);
  };

  // 保存规则
  const handleSaveRule = async (values: any) => {
    setSavingRule(true);
    try {
      const condition: any = {};
      if (values.type === 'keyword') {
        condition.keyword = values.keyword;
      } else if (values.type === 'slow_sql') {
        condition.thresholdMs = values.thresholdMs;
      }

      const channelConfig: any = {
        webhookUrl: values.webhookUrl,
        secret: values.secret,
        method: values.method || editingRule?.channelConfig?.method || 'POST',
        channelId: values.channelId,
      };

      const payload = {
        name: values.name,
        type: values.type,
        condition,
        channelType: values.channelType,
        channelConfig,
        silenceMinutes: values.silenceMinutes,
        enabled: values.enabled,
        aiSummaryEnabled: Boolean(values.aiSummaryEnabled),
      };

      if (editingRule) {
        await api.request({
          url: 'logger_alert_rules:update',
          params: { filterByTk: editingRule.id },
          method: 'post',
          data: payload,
        });
        message.success('告警规则已更新');
      } else {
        await api.request({
          url: 'logger_alert_rules:create',
          method: 'post',
          data: payload,
        });
        message.success('告警规则已创建');
      }

      setDrawerVisible(false);
      fetchRules();
    } catch (err: any) {
      message.error(`保存失败: ${err.message}`);
    } finally {
      setSavingRule(false);
    }
  };

  // 删除规则
  const handleDeleteRule = async (id: number) => {
    try {
      await api.request({
        url: 'logger_alert_rules:destroy',
        params: { filterByTk: id },
        method: 'post',
      });
      message.success('告警规则已删除');
      fetchRules();
    } catch (err: any) {
      message.error(`删除失败: ${err.message}`);
    }
  };

  // 开关切换
  const handleToggleEnabled = async (rule: any, enabled: boolean) => {
    try {
      await api.request({
        url: 'logger_alert_rules:update',
        params: { filterByTk: rule.id },
        method: 'post',
        data: { enabled },
      });
      message.success(`规则已${enabled ? '启用' : '禁用'}`);
      fetchRules();
    } catch (err: any) {
      message.error(`更新状态失败: ${err.message}`);
    }
  };

  // 测试发送
  const handleTestAlert = async (ruleData: any) => {
    setTestingId(ruleData.id);
    try {
      const res = await api.request({
        url: 'loggerPro:testAlert',
        method: 'post',
        data: ruleData,
      });
      const data = res?.data?.data || res?.data || {};
      if (data.success) {
        message.success('测试告警发送成功，请检查接收端通知');
      } else {
        message.error(`测试告警发送失败: ${data.error}`);
      }
    } catch (err: any) {
      message.error(`测试发送异常: ${err.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const getChannelTag = (type: string) => {
    switch (type) {
      case 'wecom':
        return <Tag color="blue">企业微信</Tag>;
      case 'dingtalk':
        return <Tag color="orange">钉钉机器人</Tag>;
      case 'feishu':
        return <Tag color="cyan">飞书机器人</Tag>;
      case 'custom_webhook':
        return <Tag color="purple">自定义 Webhook</Tag>;
      case 'notification_manager':
        return <Tag color="green">通知管理插件</Tag>;
      default:
        return <Tag>{type}</Tag>;
    }
  };

  const getRuleTypeTag = (type: string) => {
    switch (type) {
      case 'error_log':
        return <Tag color="red">ERROR 日志</Tag>;
      case 'status_5xx':
        return <Tag color="magenta">HTTP 5xx 异常</Tag>;
      case 'slow_sql':
        return <Tag color="gold">慢 SQL 超标</Tag>;
      case 'keyword':
        return <Tag color="geekblue">关键词匹配</Tag>;
      default:
        return <Tag>{type}</Tag>;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 单行紧凑工具条 */}
      <Card size="small" bordered bodyStyle={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Space size={8}>
            <span style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>告警规则</span>
            <Tag color="blue" style={{ margin: 0 }}>{rules.length} 条</Tag>
          </Space>

          <Space size={8}>
            <Button
              size="middle"
              icon={<HistoryOutlined />}
              onClick={() => {
                fetchHistoryLogs();
                setHistoryDrawerVisible(true);
              }}
            >
              告警历史
            </Button>
            <Button size="middle" icon={<ReloadOutlined />} onClick={fetchRules} loading={loading}>
              刷新
            </Button>
            <Button size="middle" type="primary" icon={<PlusOutlined />} onClick={() => handleOpenDrawer()}>
              新建规则
            </Button>
          </Space>
        </div>
      </Card>

      {/* 核心字段告警规则表 */}
      <Card bordered bodyStyle={{ padding: 0 }}>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rules}
          pagination={false}
          columns={[
            {
              title: '规则名称',
              dataIndex: 'name',
              render: (name, r) => (
                <Space size={6}>
                  <span style={{ fontWeight: 600, color: token.colorText }}>{name}</span>
                  {r.aiSummaryEnabled && <Tag color="purple">AI 摘要</Tag>}
                </Space>
              ),
            },
            {
              title: '触发类型',
              dataIndex: 'type',
              width: 140,
              render: (type) => getRuleTypeTag(type),
            },
            {
              title: '通知渠道',
              dataIndex: 'channelType',
              width: 140,
              render: (ch) => getChannelTag(ch),
            },
            {
              title: '启用状态',
              dataIndex: 'enabled',
              width: 100,
              render: (enabled, r) => (
                <Switch
                  size="small"
                  checked={enabled !== false}
                  onChange={(checked) => handleToggleEnabled(r, checked)}
                />
              ),
            },
            {
              title: '操作',
              width: 210,
              render: (_, r) => (
                <Space size={2}>
                  <Button size="middle" type="link" icon={<EditOutlined />} onClick={() => handleOpenDrawer(r)}>
                    详情 / 编辑
                  </Button>
                  <Button
                    size="middle"
                    type="link"
                    icon={<SendOutlined />}
                    loading={testingId === r.id}
                    onClick={() => handleTestAlert(r)}
                  >
                    测试
                  </Button>
                  <Popconfirm
                    title="确定删除此告警规则？"
                    onConfirm={() => handleDeleteRule(r.id)}
                    okText="确定"
                    cancelText="取消"
                  >
                    <Button size="middle" type="link" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: '暂无告警规则，点击右上角新建规则' }}
        />
      </Card>

      {/* 创建 / 编辑规则右侧 Drawer */}
      <Drawer
        title={editingRule ? `编辑告警规则 · ${editingRule.name}` : '新建告警规则'}
        placement="right"
        width={560}
        open={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        destroyOnClose
        extra={
          <Space>
            <Button size="middle" onClick={() => setDrawerVisible(false)}>
              取消
            </Button>
            <Button
              size="middle"
              type="primary"
              icon={<SaveOutlined />}
              loading={savingRule}
              onClick={() => drawerForm.submit()}
            >
              保存规则
            </Button>
          </Space>
        }
      >
        {editingRule && (
          <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="静默周期">{editingRule.silenceMinutes || 5} 分钟</Descriptions.Item>
            <Descriptions.Item label="最近触发">
              {editingRule.lastTriggeredAt ? new Date(editingRule.lastTriggeredAt).toLocaleString() : '从未触发'}
            </Descriptions.Item>
          </Descriptions>
        )}

        <Form form={drawerForm} layout="vertical" onFinish={handleSaveRule}>
          <Form.Item
            name="name"
            label="规则名称"
            rules={[{ required: true, message: '请输入规则名称' }]}
          >
            <Input placeholder="例如：核心业务 ERROR 级别实时告警" />
          </Form.Item>

          <Form.Item
            name="type"
            label="触发源条件"
            rules={[{ required: true, message: '请选择触发条件' }]}
          >
            <Select
              onChange={(v) => setRuleType(v)}
              options={[
                { label: 'ERROR 日志级别触发 (发生系统错误时告警)', value: 'error_log' },
                { label: 'HTTP 5xx 状态码触发 (接口返回服务端异常时告警)', value: 'status_5xx' },
                { label: '慢 SQL 超标触发 (数据库查询超出阈值时告警)', value: 'slow_sql' },
                { label: '关键词匹配触发 (日志包含特定关键字时告警)', value: 'keyword' },
              ]}
            />
          </Form.Item>

          {ruleType === 'keyword' && (
            <Form.Item
              name="keyword"
              label="匹配关键词"
              rules={[{ required: true, message: '请输入需要匹配的关键词' }]}
              tooltip="支持大小写不敏感匹配"
            >
              <Input placeholder="如：Deadlock、OutOfMemory、Timeout" />
            </Form.Item>
          )}

          {ruleType === 'slow_sql' && (
            <Form.Item
              name="thresholdMs"
              label="告警慢 SQL 耗时阈值 (毫秒)"
              rules={[{ required: true, message: '请输入阈值' }]}
            >
              <InputNumber min={100} max={60000} step={100} style={{ width: '100%' }} suffix="ms" />
            </Form.Item>
          )}

          <Form.Item
            name="channelType"
            label="通知渠道类型"
            rules={[{ required: true, message: '请选择通知渠道' }]}
          >
            <Select
              onChange={(v) => setChannelType(v)}
              options={[
                { label: '企业微信机器人 Webhook', value: 'wecom' },
                { label: '钉钉机器人 Webhook (支持加签)', value: 'dingtalk' },
                { label: '飞书机器人 Webhook (Card/卡片)', value: 'feishu' },
                { label: '自定义通用 Webhook (POST JSON)', value: 'custom_webhook' },
                { label: '联动系统通知管理插件 (Notification Manager)', value: 'notification_manager' },
              ]}
            />
          </Form.Item>

          {channelType !== 'notification_manager' && (
            <Form.Item
              name="webhookUrl"
              label="Webhook 地址 (URL)"
              rules={[{ required: true, message: '请输入 Webhook URL' }]}
            >
              <Input placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" />
            </Form.Item>
          )}

          {channelType === 'dingtalk' && (
            <Form.Item
              name="secret"
              label="安全加签 Secret (选填)"
              tooltip="钉钉机器人开启加签安全设置时的 SEC 开头秘钥"
            >
              <Input.Password placeholder="SECxxxxxxxx" />
            </Form.Item>
          )}

          {channelType === 'notification_manager' && (
            <Form.Item
              name="channelId"
              label="通知渠道 ID / 标识"
              tooltip="系统 @nocobase/plugin-notification-manager 中配置的 Channel ID"
            >
              <Input placeholder="如：email-default 或 in-app-channel" />
            </Form.Item>
          )}

          <Form.Item
            name="silenceMinutes"
            label="告警静默周期 (防风暴)"
            tooltip="相同规则在指定周期内最多发送 1 次告警，避免错误频发引发消息刷屏"
          >
            <InputNumber min={1} max={1440} style={{ width: '100%' }} suffix="分钟" />
          </Form.Item>

          <Space size="large">
            <Form.Item name="enabled" label="启用规则" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>

            <Form.Item
              name="aiSummaryEnabled"
              label="联动 AI 生成根因摘要"
              valuePropName="checked"
              tooltip="开启后，告警发送前以 8 秒短超时调用 AI 生成精简根因摘要；超时或未配置 LLM 时自动降级。"
            >
              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
            </Form.Item>
          </Space>
        </Form>
      </Drawer>

      {/* 告警历史右侧 Drawer */}
      <Drawer
        title="告警发送历史记录"
        placement="right"
        width={680}
        onClose={() => setHistoryDrawerVisible(false)}
        open={historyDrawerVisible}
        extra={
          <Button size="middle" icon={<ReloadOutlined />} loading={historyLoading} onClick={fetchHistoryLogs}>
            刷新
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={historyLoading}
          dataSource={historyLogs}
          pagination={{ pageSize: 15 }}
          columns={[
            {
              title: '发送时间',
              dataIndex: 'createdAt',
              width: 160,
              render: (t) => (
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                  {t ? new Date(t).toLocaleString() : '-'}
                </span>
              ),
            },
            {
              title: '规则名称',
              dataIndex: 'ruleName',
              width: 140,
            },
            {
              title: '渠道',
              dataIndex: 'channelType',
              width: 100,
              render: (ch) => getChannelTag(ch),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 80,
              render: (st) => (
                <Tag color={st === 'success' ? 'success' : 'error'}>
                  {st === 'success' ? '成功' : '失败'}
                </Tag>
              ),
            },
            {
              title: '告警标题 / 详情',
              dataIndex: 'title',
              render: (title, r) => (
                <div>
                  <div style={{ fontWeight: 500, color: token.colorText }}>{title}</div>
                  {r.errorMsg && <div style={{ color: token.colorError, fontSize: 12 }}>{r.errorMsg}</div>}
                </div>
              ),
            },
          ]}
          locale={{ emptyText: '暂无告警记录' }}
        />
      </Drawer>
    </div>
  );
};
