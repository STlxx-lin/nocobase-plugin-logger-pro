import React, { useState, useEffect, useRef } from 'react';
import {
  Form,
  Card,
  Radio,
  Switch,
  InputNumber,
  Input,
  Select,
  Button,
  Space,
  Divider,
  message,
  Popconfirm,
  Row,
  Col,
  Alert,
  Table,
  Tag,
  Statistic,
  Progress,
  Modal,
  Drawer,
  theme,
} from 'antd';
import {
  SaveOutlined,
  ClearOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  HddOutlined,
  DeleteOutlined,
  LoadingOutlined,
  CloseCircleOutlined,
  SafetyCertificateOutlined,
  SlidersOutlined,
} from '@ant-design/icons';
import { useLoggerProAPI } from '../context/LoggerProContext';

export const ConfigTab: React.FC = () => {
  const { token } = theme.useToken();
  const api = useLoggerProAPI();
  const [form] = Form.useForm();
  const maxDiskSizeMb = Form.useWatch('max_disk_size_mb', form);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleanLoading, setCleanLoading] = useState(false);
  const [collectionsList, setCollectionsList] = useState<any[]>([]);
  const [aiEmployees, setAiEmployees] = useState<any[]>([]);
  const [llmServices, setLlmServices] = useState<any[]>([]);

  // Drawer 控制状态
  const [storageDrawerVisible, setStorageDrawerVisible] = useState(false);
  const [advancedDrawerVisible, setAdvancedDrawerVisible] = useState(false);

  // 存储与数据占用分析状态
  const [statsLoading, setStatsLoading] = useState(false);
  const [storageStats, setStorageStats] = useState<any>(null);

  // 删除进度弹窗状态
  const [progressVisible, setProgressVisible] = useState(false);
  const [progressTitle, setProgressTitle] = useState('');
  const [totalToClean, setTotalToClean] = useState(0);
  const [cleanedCount, setCleanedCount] = useState(0);
  const [remainingCount, setRemainingCount] = useState(0);
  const [cleanStatus, setCleanStatus] = useState<'running' | 'completed' | 'error' | 'stopped'>('running');
  const [cleanErrorMsg, setCleanErrorMsg] = useState('');
  const cancelCleanRef = useRef(false);

  // 系统预置集合与常用数据表中文映射
  const systemCollectionMap: Record<string, string> = {
    auth: '用户身份与认证',
    roles: '角色与权限控制',
    uiSchemas: '界面区块 Schema 配置',
    uiSchemaTemplates: '区块 UI 模板配置',
    desktopRoutes: '桌面端路由与菜单',
    themeConfig: '主题与界面外观配置',
    dataSources: '数据源连接与配置',
    environmentVariables: '系统环境变量',
    systemSettings: '系统全局核心设置',
    applicationPlugins: '应用插件管理与状态',
    migrations: '数据库版本迁移记录',
    workflow: '工作流引擎核心表',
    flowModels: '流程设计模型',
    aiConversations: 'AI 会话与交互历史',
    aiEmployees: 'AI 智能员工与助手',
    attachments: '附件与文件存储表',
    logger_audit_logs: '操作审计记录表',
    logger_alert_logs: '告警通知发送记录',
    logger_configs: '日志系统配置表',
    logger_alert_rules: '智能告警规则表',
    logger_ai_records: 'AI 诊断记录表',
  };

  // 排除数据表候选选项
  const excludeCollectionOptions = React.useMemo(() => {
    const existing = new Set<string>();
    const options: Array<{ label: string; value: string }> = [];

    for (const c of collectionsList) {
      existing.add(c.name);
      const zh = systemCollectionMap[c.name] || c.title || c.name;
      options.push({
        label: `${zh} (${c.name})`,
        value: c.name,
      });
    }

    for (const [key, zh] of Object.entries(systemCollectionMap)) {
      if (!existing.has(key)) {
        options.push({
          label: `${zh} (${key})`,
          value: key,
        });
      }
    }

    return options;
  }, [collectionsList]);

  // 排除操作动作候选选项
  const excludeActionOptions = [
    { label: 'syncCookies (Cookie 会话心跳同步)', value: 'syncCookies' },
    { label: 'unreadCounts (未读消息与提醒轮询)', value: 'unreadCounts' },
    { label: 'listByUser (用户与员工列表拉取)', value: 'listByUser' },
    { label: 'listMeta (集合元数据动态查询)', value: 'listMeta' },
    { label: 'listAccessible (可访问菜单与路由查询)', value: 'listAccessible' },
    { label: 'listMine (我的待办工作流任务)', value: 'listMine' },
    { label: 'check (权限与状态常规校验)', value: 'check' },
    { label: 'getLang (系统多语言词包获取)', value: 'getLang' },
    { label: 'getInfo (应用与环境信息查询)', value: 'getInfo' },
    { label: 'getConfigs (日志与插件配置读取)', value: 'getConfigs' },
    { label: 'getCollections (数据表与模型列表获取)', value: 'getCollections' },
    { label: 'dashboard (仪表盘运行状态获取)', value: 'dashboard' },
    { label: 'getFile (文件与附件预览读取)', value: 'getFile' },
    { label: 'list (基础列表只读数据查询)', value: 'list' },
    { label: 'get (基础单条只读数据查询)', value: 'get' },
    { label: 'count (数据总量统计)', value: 'count' },
    { label: 'find (数据检索查询)', value: 'find' },
    { label: 'findOne (单条数据检索)', value: 'findOne' },
  ];

  // 1. 获取配置与 Collections
  const fetchConfigs = async () => {
    setLoading(true);
    try {
      const [configRes, colRes, empRes, llmRes] = await Promise.all([
        api.request({ url: 'loggerPro:getConfigs' }),
        api.request({ url: 'loggerPro:getCollections' }),
        api.request({ url: 'loggerPro:getAIEmployees' }).catch(() => ({ data: [] })),
        api.request({ url: 'loggerPro:getLLMServices' }).catch(() => ({ data: [] })),
      ]);

      const configs = configRes?.data?.data || configRes?.data || {};
      setCollectionsList(colRes?.data?.data || colRes?.data || []);
      const empList = empRes?.data?.data || empRes?.data || [];
      setAiEmployees(Array.isArray(empList) ? empList : []);
      const llmList = llmRes?.data?.data || llmRes?.data || [];
      setLlmServices(Array.isArray(llmList) ? llmList : []);

      let auditCols: string[] = [];
      let auditExcludeCols: string[] = [];
      let auditExcludeActs: string[] = [];
      try {
        auditCols = configs.audit_collections ? JSON.parse(configs.audit_collections) : [];
      } catch {}
      try {
        auditExcludeCols = configs.audit_exclude_collections
          ? JSON.parse(configs.audit_exclude_collections)
          : [
              'auth',
              'roles',
              'uiSchemas',
              'uiSchemaTemplates',
              'desktopRoutes',
              'themeConfig',
              'dataSources',
              'environmentVariables',
              'systemSettings',
              'applicationPlugins',
              'migrations',
            ];
      } catch {}
      try {
        auditExcludeActs = configs.audit_exclude_actions
          ? JSON.parse(configs.audit_exclude_actions)
          : ['syncCookies', 'unreadCounts', 'listByUser', 'listMeta', 'listAccessible', 'listMine', 'check'];
      } catch {}

      form.setFieldsValue({
        logger_level: configs.logger_level || 'info',
        sql_logging: configs.sql_logging === 'true',
        slow_query_enabled: configs.slow_query_enabled === 'true',
        slow_query_threshold_ms: Number(configs.slow_query_threshold_ms) || 500,
        request_logging: configs.request_logging === 'true',
        audit_log_enabled: configs.audit_log_enabled === 'true',
        audit_record_diff: configs.audit_record_diff === 'true',
        audit_collections: auditCols,
        audit_exclude_collections: auditExcludeCols,
        audit_exclude_actions: auditExcludeActs,
        audit_ignore_readonly_post: configs.audit_ignore_readonly_post !== 'false',
        audit_zero_diff_skip: configs.audit_zero_diff_skip !== 'false',
        retention_days: Number(configs.retention_days) || 15,
        max_disk_size_mb: Number(configs.max_disk_size_mb) || 2048,
        auto_clean_enabled: configs.auto_clean_enabled === 'true',
        auto_clean_cron: configs.auto_clean_cron || '0 2 * * *',
        ai_allow_private_llm: configs.ai_allow_private_llm !== 'false',
        ai_default_sanitize: configs.ai_default_sanitize !== 'false',
        ai_request_timeout_ms: Number(configs.ai_request_timeout_ms) || 45000,
        ai_default_employee: configs.ai_default_employee || 'system-error-expert',
        ai_default_llm_key: configs.ai_default_llm_service
          ? `${configs.ai_default_llm_service}:${configs.ai_default_llm_model || 'default'}`
          : '',
      });
    } catch (err: any) {
      message.error(`加载配置失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 2. 获取插件存储空间占用统计
  const fetchStorageStats = async () => {
    setStatsLoading(true);
    try {
      const res = await api.request({ url: 'loggerPro:getPluginStorageStats' });
      const data = res?.data?.data || res?.data;
      if (data) {
        setStorageStats(data);
      }
    } catch {} finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    fetchConfigs();
    fetchStorageStats();
  }, []);

  // 3. 保存配置
  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const allValues = { ...form.getFieldsValue(true), ...values };
      const rawLlmKey = String(allValues.ai_default_llm_key || '').trim();
      let defaultLlmService = '';
      let defaultLlmModel = '';
      if (rawLlmKey) {
        const parts = rawLlmKey.split(':');
        defaultLlmService = parts[0] || '';
        defaultLlmModel = parts.slice(1).join(':') || 'default';
      }

      const payload: Record<string, string> = {
        logger_level: String(allValues.logger_level || 'info'),
        sql_logging: String(Boolean(allValues.sql_logging)),
        slow_query_enabled: String(Boolean(allValues.slow_query_enabled)),
        slow_query_threshold_ms: String(allValues.slow_query_threshold_ms ?? 500),
        request_logging: String(Boolean(allValues.request_logging)),
        audit_log_enabled: String(Boolean(allValues.audit_log_enabled)),
        audit_record_diff: String(Boolean(allValues.audit_record_diff)),
        audit_collections: JSON.stringify(Array.isArray(allValues.audit_collections) ? allValues.audit_collections : []),
        audit_exclude_collections: JSON.stringify(
          Array.isArray(allValues.audit_exclude_collections) ? allValues.audit_exclude_collections : [],
        ),
        audit_exclude_actions: JSON.stringify(
          Array.isArray(allValues.audit_exclude_actions) ? allValues.audit_exclude_actions : [],
        ),
        audit_ignore_readonly_post: String(allValues.audit_ignore_readonly_post !== false),
        audit_zero_diff_skip: String(allValues.audit_zero_diff_skip !== false),
        retention_days: String(allValues.retention_days ?? 15),
        max_disk_size_mb: String(allValues.max_disk_size_mb ?? 2048),
        auto_clean_enabled: String(Boolean(allValues.auto_clean_enabled)),
        auto_clean_cron: String(allValues.auto_clean_cron || '0 2 * * *'),
        ai_allow_private_llm: String(allValues.ai_allow_private_llm !== false),
        ai_default_sanitize: String(allValues.ai_default_sanitize !== false),
        ai_request_timeout_ms: String(allValues.ai_request_timeout_ms ?? 45000),
        ai_default_employee: String(allValues.ai_default_employee || 'system-error-expert'),
        ai_default_llm_service: defaultLlmService,
        ai_default_llm_model: defaultLlmModel,
      };

      await api.request({
        url: 'loggerPro:updateConfigs',
        method: 'post',
        data: payload,
      });

      message.success('配置已保存并立即热生效');
      fetchStorageStats();
    } catch (err: any) {
      message.error(`保存配置失败: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // 4. 手动清理过期日志文件
  const handleCleanNow = async () => {
    setCleanLoading(true);
    try {
      const res = await api.request({
        url: 'loggerPro:cleanLogs',
        method: 'post',
      });
      const data = res?.data?.data || res?.data || {};
      message.success(`清理完成！共删除 ${data.deletedCount} 个文件，释放空间 ${data.freedFormatted}`);
      fetchStorageStats();
    } catch (err: any) {
      message.error(`清理失败: ${err.message}`);
    } finally {
      setCleanLoading(false);
    }
  };

  // 5. 启动带实时进度条的分批极速清理
  const startCleanWithProgress = async (collectionName: string, days?: number) => {
    cancelCleanRef.current = false;
    setCleanStatus('running');
    setCleanErrorMsg('');
    setProgressVisible(true);

    const isExpired = Boolean(days && Number(days) > 0);
    const modeTitle = isExpired
      ? `清理「${collectionName}」${days} 天前历史数据`
      : `清空「${collectionName}」全部数据`;
    setProgressTitle(modeTitle);

    const queryParams: Record<string, any> = { collectionName };
    if (isExpired) {
      queryParams.days = Number(days);
    }

    try {
      const totalRes = await api.request({
        url: 'loggerPro:getCleanTotalCount',
        params: queryParams,
      });
      const total = Number(totalRes?.data?.data?.totalCount ?? totalRes?.data?.totalCount ?? 0);
      setTotalToClean(total);
      setCleanedCount(0);
      setRemainingCount(total);

      if (total === 0) {
        if (!isExpired) {
          await api.request({
            url: 'loggerPro:cleanTableData',
            method: 'post',
            params: { collectionName },
            data: { collectionName },
          });
        }
        setCleanStatus('completed');
        message.success(`${modeTitle} 已完成`);
        fetchStorageStats();
        return;
      }

      let currentRemaining = total;
      const batchLimit = 20000;

      while (currentRemaining > 0 && !cancelCleanRef.current) {
        const batchRes = await api.request({
          url: 'loggerPro:cleanBatch',
          method: 'post',
          params: { ...queryParams, limit: batchLimit },
          data: { ...queryParams, limit: batchLimit },
        });

        const newRemaining = Number(
          batchRes?.data?.data?.remainingCount ?? batchRes?.data?.remainingCount ?? 0
        );

        if (newRemaining >= currentRemaining) {
          if (!isExpired) {
            await api.request({
              url: 'loggerPro:cleanTableData',
              method: 'post',
              params: { collectionName },
              data: { collectionName },
            });
          }
          setCleanedCount(total);
          setRemainingCount(0);
          break;
        }

        currentRemaining = newRemaining;
        const currentCleaned = Math.max(total - currentRemaining, 0);
        setCleanedCount(currentCleaned);
        setRemainingCount(currentRemaining);

        if (currentRemaining <= 0) break;
      }

      if (cancelCleanRef.current) {
        setCleanStatus('stopped');
        message.warning('已暂停清理，已处理的数据已生效');
      } else {
        setCleanStatus('completed');
        message.success(`${modeTitle} 完成`);
      }

      fetchStorageStats();
    } catch (err: any) {
      setCleanStatus('error');
      setCleanErrorMsg(err.message || '清理异常中断');
      message.error(`清理异常: ${err.message}`);
    }
  };

  // 6. 打包下载所有日志
  const handleDownloadAll = async () => {
    try {
      const res = await api.request({
        url: 'loggerPro:download',
        method: 'post',
        data: {},
        responseType: 'blob',
      });
      const blob = new Blob([res.data], { type: 'application/gzip' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logs_${Date.now()}.tar.gz`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      message.error(`打包下载失败: ${err.message || '请求异常'}`);
    }
  };

  // 数据库表表格列定义
  const tableColumns = [
    {
      title: '数据表名称',
      dataIndex: 'title',
      key: 'title',
      render: (text: string, rec: any) => (
        <div>
          <strong>{text}</strong>
          <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{rec.collection}</div>
        </div>
      ),
    },
    {
      title: '记录行数',
      dataIndex: 'count',
      key: 'count',
      render: (val: number) => <Tag color="blue">{val.toLocaleString()} 行</Tag>,
    },
    {
      title: '预估占用',
      dataIndex: 'estimatedFormatted',
      key: 'estimatedFormatted',
      render: (val: string) => <span style={{ fontWeight: 600, color: token.colorText }}>{val}</span>,
    },
    {
      title: '空间维护',
      key: 'action',
      render: (_: any, rec: any) => (
        rec.count > 0 && rec.collection !== 'logger_configs' && rec.collection !== 'logger_alert_rules' ? (
          <Space size="small">
            {rec.collection === 'logger_audit_logs' && (
              <Popconfirm
                title="清理 15 天前旧数据"
                description="将保留最近 15 天内的审计记录，物理清理 15 天前的历史数据。"
                onConfirm={() => startCleanWithProgress('logger_audit_logs', 15)}
                okText="立即清理"
                cancelText="取消"
              >
                <Button size="middle" type="link">
                  清理15天前
                </Button>
              </Popconfirm>
            )}
            <Popconfirm
              title={`确定清空「${rec.title}」的所有数据？`}
              description="清空后历史数据不可恢复，请谨慎操作。"
              onConfirm={() => startCleanWithProgress(rec.collection)}
              okText="确定清空"
              cancelText="取消"
            >
              <Button size="middle" type="link" danger icon={<DeleteOutlined />}>
                清空
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <span style={{ color: token.colorTextPlaceholder, fontSize: 12 }}>-</span>
        )
      ),
    },
  ];

  const llmSelectOptions = [
    { label: '自动选用首个可用真实 LLM 服务', value: '' },
    ...llmServices.map((s) => {
      const models = s.enabledModels || [];
      if (models.length <= 1 && (models[0]?.value === 'default' || !models.length)) {
        return {
          label: `${s.llmServiceTitle} (${models[0]?.value || 'default'})`,
          value: `${s.llmService}:${models[0]?.value || 'default'}`,
        };
      }
      return {
        label: s.llmServiceTitle,
        options: models.map((m: any) => ({
          label: `${m.label || m.value}`,
          value: `${s.llmService}:${m.value}`,
        })),
      };
    }),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶部精简操作区 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Space>
          <span style={{ fontSize: 15, fontWeight: 600, color: token.colorText }}>核心配置</span>
          {storageStats?.totalSizeFormatted && (
            <Tag color="blue">当前总占用: {storageStats.totalSizeFormatted}</Tag>
          )}
        </Space>
        <Space wrap size={6}>
          <Button size="middle" icon={<HddOutlined />} onClick={() => setStorageDrawerVisible(true)}>
            存储统计与清理
          </Button>
          <Button size="middle" icon={<SlidersOutlined />} onClick={() => setAdvancedDrawerVisible(true)}>
            AI 高级与过滤策略
          </Button>
          <Button size="middle" icon={<ReloadOutlined />} onClick={fetchConfigs} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <Form form={form} layout="vertical" onFinish={handleSave}>
        <Row gutter={[16, 16]}>
          {/* 左列：高频日志与审计开关 */}
          <Col xs={24} lg={12}>
            <Card size="small" title="日志与审计开关" bordered style={{ height: '100%' }}>
              <Form.Item
                name="logger_level"
                label="全局最低日志级别"
                tooltip="低于该级别的日志将直接被忽略，不会写入磁盘。"
              >
                <Radio.Group buttonStyle="solid">
                  <Radio.Button value="debug">DEBUG</Radio.Button>
                  <Radio.Button value="info">INFO</Radio.Button>
                  <Radio.Button value="warn">WARN</Radio.Button>
                  <Radio.Button value="error">ERROR</Radio.Button>
                </Radio.Group>
              </Form.Item>

              <Divider style={{ margin: '12px 0' }} />

              <Row gutter={[16, 8]}>
                <Col span={12}>
                  <Form.Item name="request_logging" label="HTTP 请求日志" valuePropName="checked">
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="sql_logging" label="SQL 执行日志" valuePropName="checked">
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="slow_query_enabled" label="慢查询捕获" valuePropName="checked">
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="slow_query_threshold_ms"
                    label="慢查询阈值 (ms)"
                    tooltip="执行时间超出此阈值的 SQL 将被标记为慢查询。"
                  >
                    <InputNumber min={50} max={60000} step={100} style={{ width: '100%' }} suffix="ms" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="audit_log_enabled" label="操作审计开关" valuePropName="checked">
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="audit_record_diff"
                    label="记录变更 Diff"
                    valuePropName="checked"
                    tooltip="更新和删除时记录字段变更前后对比。"
                  >
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </Col>

          {/* 右列：保留周期与默认 AI 配置 */}
          <Col xs={24} lg={12}>
            <Card size="small" title="保留策略与默认 AI 模型" bordered style={{ height: '100%' }}>
              <Row gutter={[16, 8]}>
                <Col span={8}>
                  <Form.Item
                    name="retention_days"
                    label="日志保留天数"
                    tooltip="超出保留天数的日志文件将被自动清理。0 表示永不过期。"
                  >
                    <InputNumber min={0} max={365} style={{ width: '100%' }} suffix="天" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    name="max_disk_size_mb"
                    label="磁盘上限"
                    tooltip="日志总大小超出此限额时自动清理最早的历史文件。"
                  >
                    <InputNumber min={100} max={102400} step={500} style={{ width: '100%' }} suffix="MB" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="auto_clean_enabled" label="定时自动清理" valuePropName="checked">
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
              </Row>

              <Divider style={{ margin: '12px 0' }} />

              {llmServices.length === 0 && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="尚未检测到可用的真实 LLM 服务，请前往系统【AI 员工 / LLM 服务】配置。"
                />
              )}

              <Form.Item
                name="ai_default_employee"
                label="默认 AI 员工"
                tooltip="未单独切换时，日志诊断与追问默认使用该 AI 员工设定。"
              >
                <Select
                  placeholder="选择默认 AI 员工"
                  options={aiEmployees.map((e) => ({
                    label: e.title || e.name,
                    value: e.name,
                  }))}
                />
              </Form.Item>

              <Form.Item
                name="ai_default_llm_key"
                label="默认 LLM 服务与模型"
                style={{ marginBottom: 0 }}
                tooltip="所有 AI 入口未显式指定模型时统一读取此默认配置。"
              >
                <Select
                  allowClear
                  placeholder="自动选用系统中首个可用真实 LLM 服务"
                  options={llmSelectOptions}
                />
              </Form.Item>
            </Card>
          </Col>
        </Row>

        {/* 底部提交操作条 */}
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
          }}
        >
          <Space size={6}>
            <Button size="middle" icon={<ReloadOutlined />} onClick={fetchConfigs}>
              重置更改
            </Button>
            <Button size="middle" type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
              保存配置
            </Button>
          </Space>
        </div>

        {/* 右侧 Drawer 1：AI 高级策略与审计过滤配置（forceRender 保证字段始终参与表单提交） */}
        <Drawer
          title="AI 高级策略与审计过滤配置"
          placement="right"
          width={620}
          open={advancedDrawerVisible}
          onClose={() => setAdvancedDrawerVisible(false)}
          forceRender
          extra={
            <Button
              type="primary"
              size="middle"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => form.submit()}
            >
              保存配置
            </Button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card size="small" title="AI 安全与超时策略" bordered>
              <Row gutter={[16, 8]}>
                <Col span={12}>
                  <Form.Item
                    name="ai_allow_private_llm"
                    label="允许本地 / 内网大模型"
                    valuePropName="checked"
                    tooltip="允许连接 localhost、127.0.0.1 及内网 IP（如 Ollama）；始终阻断非 http/https 及云元数据地址。"
                  >
                    <Switch checkedChildren="允许内网" unCheckedChildren="仅公网" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="ai_default_sanitize"
                    label="默认日志敏感信息脱敏"
                    valuePropName="checked"
                    tooltip="发送给大模型前自动掩码 Token、API Key、密码、连接串、手机号和邮箱。"
                  >
                    <Switch checkedChildren="默认脱敏" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="ai_request_timeout_ms"
                    label="AI 模型请求超时时间 (毫秒)"
                    style={{ marginBottom: 0 }}
                    tooltip="单次调用 LLM 接口的超时上限，建议 15000 ~ 90000 ms。"
                  >
                    <InputNumber min={3000} max={180000} step={5000} style={{ width: '100%' }} suffix="ms" />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card size="small" title="审计过滤与定时清理规则" bordered>
              <Row gutter={[16, 8]}>
                <Col span={12}>
                  <Form.Item
                    name="audit_ignore_readonly_post"
                    label="过滤只读/心跳 POST"
                    valuePropName="checked"
                    tooltip="自动过滤 list/get/find/check/sync/count/unread 等只读心跳请求。"
                  >
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="audit_zero_diff_skip"
                    label="忽略无变动更新"
                    valuePropName="checked"
                    tooltip="修改前与修改后数据完全一致时跳过审计存储。"
                  >
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="audit_exclude_collections"
                    label="排除审计的数据表"
                    tooltip="配置在此列表中的数据表变更将不会被记录。"
                  >
                    <Select
                      mode="tags"
                      allowClear
                      placeholder="选择或输入排除的数据表名称"
                      style={{ width: '100%' }}
                      options={excludeCollectionOptions}
                    />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="audit_exclude_actions"
                    label="排除审计的操作动作"
                    tooltip="配置在此列表中的 Action 将直接跳过审计记录。"
                  >
                    <Select
                      mode="tags"
                      allowClear
                      placeholder="选择或输入需要忽略的 Action 名称"
                      style={{ width: '100%' }}
                      options={excludeActionOptions}
                    />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="audit_collections"
                    label="重点审计白名单 (选填)"
                    tooltip="留空则审计除排除表外的所有业务表；指定后仅审计白名单内的数据表。"
                  >
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="全部业务数据表 (默认)"
                      style={{ width: '100%' }}
                      options={collectionsList.map((c) => ({
                        label: `${c.title || c.name} (${c.name})`,
                        value: c.name,
                      }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item
                    name="auto_clean_cron"
                    label="自动清理定时表达式 (Cron)"
                    style={{ marginBottom: 0 }}
                    tooltip="标准 5 段 Cron 表达式，默认每天凌晨 2:00 (0 2 * * *)"
                  >
                    <Input placeholder="0 2 * * *" style={{ fontFamily: 'monospace' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </div>
        </Drawer>
      </Form>

      {/* 右侧 Drawer 2：存储空间统计与批量清理 */}
      <Drawer
        title="存储空间统计与清理"
        placement="right"
        width={760}
        open={storageDrawerVisible}
        onClose={() => setStorageDrawerVisible(false)}
        extra={
          <Space>
            <Button size="middle" icon={<DownloadOutlined />} onClick={handleDownloadAll}>
              打包下载全部日志
            </Button>
            <Popconfirm
              title="立即执行过期与超限日志清理？"
              description="将立即扫描并清理超出保留天数或磁盘配额的历史日志。"
              onConfirm={handleCleanNow}
              okText="立即清理"
              cancelText="取消"
            >
              <Button size="middle" icon={<ClearOutlined />} loading={cleanLoading}>
                清理过期文件
              </Button>
            </Popconfirm>
            <Button size="middle" icon={<ReloadOutlined />} loading={statsLoading} onClick={fetchStorageStats}>
              刷新
            </Button>
          </Space>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} sm={8}>
              <Card size="small" style={{ backgroundColor: token.colorInfoBg, borderColor: token.colorInfoBorder }}>
                <Statistic
                  title={
                    <span style={{ color: token.colorInfoText }}>
                      <FileTextOutlined /> 日志文件占用
                    </span>
                  }
                  value={storageStats?.fileStats?.totalSizeFormatted || '0 B'}
                  suffix={<span style={{ fontSize: 12, color: token.colorTextSecondary }}>({storageStats?.fileStats?.totalFiles || 0} 个)</span>}
                  valueStyle={{ color: token.colorInfoText, fontWeight: 600, fontSize: 18 }}
                />
                <div style={{ marginTop: 6, fontSize: 11, color: token.colorTextSecondary }}>
                  请求: {storageStats?.fileStats?.categories?.requestLogs?.formatted || '0 B'} | 系统:{' '}
                  {storageStats?.fileStats?.categories?.systemLogs?.formatted || '0 B'} | SQL:{' '}
                  {storageStats?.fileStats?.categories?.sqlLogs?.formatted || '0 B'}
                </div>
              </Card>
            </Col>

            <Col xs={24} sm={8}>
              <Card size="small" style={{ backgroundColor: token.colorSuccessBg, borderColor: token.colorSuccessBorder }}>
                <Statistic
                  title={
                    <span style={{ color: token.colorSuccess }}>
                      <DatabaseOutlined /> 数据库表占用
                    </span>
                  }
                  value={storageStats?.dbStats?.estimatedSizeFormatted || '0 B'}
                  suffix={
                    <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                      ({(storageStats?.dbStats?.totalRows || 0).toLocaleString()} 行)
                    </span>
                  }
                  valueStyle={{ color: token.colorSuccess, fontWeight: 600, fontSize: 18 }}
                />
                <div style={{ marginTop: 6, fontSize: 11, color: token.colorTextSecondary }}>
                  含审计、AI 诊断、告警等核心表
                </div>
              </Card>
            </Col>

            <Col xs={24} sm={8}>
              <Card size="small" style={{ backgroundColor: token.colorFillAlter, borderColor: token.colorBorderSecondary }}>
                <Statistic
                  title={
                    <span style={{ color: token.colorPrimary }}>
                      <HddOutlined /> 插件总占用
                    </span>
                  }
                  value={storageStats?.totalSizeFormatted || '0 B'}
                  valueStyle={{ color: token.colorPrimary, fontWeight: 600, fontSize: 18 }}
                />
                <div style={{ marginTop: 6, fontSize: 11, color: token.colorTextSecondary }}>
                  磁盘配额上限: {maxDiskSizeMb ?? 2048} MB
                </div>
              </Card>
            </Col>
          </Row>

          <Card size="small" title="插件数据表明细与空间释放" bordered>
            <Table
              size="small"
              pagination={false}
              rowKey="collection"
              loading={statsLoading}
              dataSource={storageStats?.dbStats?.tables || []}
              columns={tableColumns}
            />
          </Card>
        </div>
      </Drawer>

      {/* 数据清理与清空实时进度弹窗 */}
      <Modal
        title={
          <Space>
            {cleanStatus === 'running' && <LoadingOutlined style={{ color: token.colorPrimary }} />}
            {cleanStatus === 'completed' && <CheckCircleOutlined style={{ color: token.colorSuccess }} />}
            {cleanStatus === 'error' && <CloseCircleOutlined style={{ color: token.colorError }} />}
            <span style={{ fontWeight: 600 }}>{progressTitle || '数据清理进度'}</span>
          </Space>
        }
        open={progressVisible}
        closable={cleanStatus !== 'running'}
        maskClosable={false}
        footer={[
          cleanStatus === 'running' && (
            <Button
              key="cancel"
              size="middle"
              danger
              onClick={() => {
                cancelCleanRef.current = true;
              }}
            >
              暂停 / 中止清理
            </Button>
          ),
          cleanStatus !== 'running' && (
            <Button
              key="close"
              size="middle"
              type="primary"
              onClick={() => {
                setProgressVisible(false);
              }}
            >
              完成并关闭
            </Button>
          ),
        ].filter(Boolean)}
        width={560}
      >
        <div style={{ padding: '12px 0' }}>
          <div style={{ marginBottom: 20 }}>
            <Progress
              percent={
                totalToClean > 0
                  ? Math.min(Math.round((cleanedCount / totalToClean) * 100), 100)
                  : cleanStatus === 'completed'
                  ? 100
                  : 0
              }
              status={
                cleanStatus === 'completed'
                  ? 'success'
                  : cleanStatus === 'error'
                  ? 'exception'
                  : cleanStatus === 'stopped'
                  ? 'normal'
                  : 'active'
              }
              strokeColor={{
                '0%': token.colorPrimary,
                '100%': token.colorSuccess,
              }}
              strokeWidth={12}
            />
          </div>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Card size="small" style={{ textAlign: 'center', background: token.colorFillAlter }}>
                <Statistic
                  title="待清理总量"
                  value={totalToClean}
                  formatter={(val) => Number(val).toLocaleString() + ' 行'}
                  valueStyle={{ fontSize: 16, fontWeight: 600 }}
                />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" style={{ textAlign: 'center', background: token.colorSuccessBg, borderColor: token.colorSuccessBorder }}>
                <Statistic
                  title="已成功清理"
                  value={cleanedCount}
                  formatter={(val) => Number(val).toLocaleString() + ' 行'}
                  valueStyle={{ fontSize: 16, fontWeight: 600, color: token.colorSuccess }}
                />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" style={{ textAlign: 'center', background: token.colorInfoBg, borderColor: token.colorInfoBorder }}>
                <Statistic
                  title="剩余待处理"
                  value={remainingCount}
                  formatter={(val) => Number(val).toLocaleString() + ' 行'}
                  valueStyle={{ fontSize: 16, fontWeight: 600, color: token.colorPrimary }}
                />
              </Card>
            </Col>
          </Row>

          {cleanStatus === 'running' && (
            <Alert
              message="正在分批清理中..."
              description="系统采用 20,000 条/批次流水线式清除，零主线程阻塞，请稍候。"
              type="info"
              showIcon
            />
          )}

          {cleanStatus === 'completed' && (
            <Alert
              message="数据清理已全部完成"
              description={`共释放历史记录 ${cleanedCount.toLocaleString()} 行，空间统计数据已自动刷新。`}
              type="success"
              showIcon
            />
          )}

          {cleanStatus === 'stopped' && (
            <Alert
              message="清理操作已由用户手动中止"
              description={`已处理的 ${cleanedCount.toLocaleString()} 行数据已成功释放。`}
              type="warning"
              showIcon
            />
          )}

          {cleanStatus === 'error' && (
            <Alert
              message="清理过程中遇到异常"
              description={cleanErrorMsg || '网络或数据库繁忙，请稍后重试。'}
              type="error"
              showIcon
            />
          )}
        </div>
      </Modal>
    </div>
  );
};
