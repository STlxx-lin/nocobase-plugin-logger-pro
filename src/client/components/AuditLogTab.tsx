import React, { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Input,
  Select,
  Button,
  Space,
  Tag,
  Drawer,
  Descriptions,
  message,
  Spin,
  Alert,
  Typography,
  theme,
} from 'antd';
import {
  SearchOutlined,
  ReloadOutlined,
  DiffOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExportOutlined,
  DeploymentUnitOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useLoggerProAPI } from '../context/LoggerProContext';
import { DiffModal } from './DiffModal';
import { AuditLogExportDrawer } from './AuditLogExportDrawer';
import { TraceDrawer } from './TraceDrawer';
import { AIEngineBadge } from './MarkdownRenderer';

const { Text } = Typography;

export const AuditLogTab: React.FC = () => {
  const { token } = theme.useToken();
  const api = useLoggerProAPI();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // 筛选字段
  const [username, setUsername] = useState('');
  const [collectionName, setCollectionName] = useState<string | undefined>(undefined);
  const [actionName, setActionName] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [nlQuery, setNlQuery] = useState<string>('');
  const [nlLoading, setNlLoading] = useState<boolean>(false);
  const [nlTags, setNlTags] = useState<Array<{ key: string; label: string; value: any }>>([]);
  const [nlExtraFilter, setNlExtraFilter] = useState<Record<string, any>>({});
  const [nlError, setNlError] = useState<{ message: string; errorCode?: string } | null>(null);
  const [nlEngineMeta, setNlEngineMeta] = useState<{ engine?: 'llm' | 'heuristic'; llmService?: string; model?: string } | null>(null);

  // 导出抽屉
  const [exportDrawerVisible, setExportDrawerVisible] = useState(false);

  // 全链路追踪抽屉
  const [traceReqId, setTraceReqId] = useState<string | null>(null);
  const [traceDrawerVisible, setTraceDrawerVisible] = useState(false);

  // 差异对比弹窗
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [diffModalVisible, setDiffModalVisible] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);

  // 详情抽屉（查看 Params / Error）
  const [drawerRecord, setDrawerRecord] = useState<any>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // 系统全部 Collections 列表
  const [collectionsList, setCollectionsList] = useState<any[]>([]);

  // 1. 获取系统数据表列表
  const fetchCollections = async () => {
    try {
      const res = await api.request({ url: 'loggerPro:getCollections' });
      setCollectionsList(res?.data?.data || res?.data || []);
    } catch {}
  };

  // 2. 加载审计日志列表 (字段瘦身优化：不加载大体积快照字段，彻底避免 MySQL 内存排序溢出)
  const fetchAuditLogs = async (
    currentPage = page,
    currentPageSize = pageSize,
    overrideFilter?: Record<string, any>,
    overrideFields?: {
      username?: string;
      collectionName?: string | null;
      actionName?: string | null;
      statusFilter?: string | null;
    },
  ) => {
    setLoading(true);
    try {
      const effectiveUsername = overrideFields && 'username' in overrideFields ? (overrideFields.username || '') : username;
      const effectiveCollection = overrideFields && 'collectionName' in overrideFields ? (overrideFields.collectionName || undefined) : collectionName;
      const effectiveAction = overrideFields && 'actionName' in overrideFields ? (overrideFields.actionName || undefined) : actionName;
      const effectiveStatus = overrideFields && 'statusFilter' in overrideFields ? (overrideFields.statusFilter || undefined) : statusFilter;

      const filter: any = { ...(overrideFilter ?? nlExtraFilter) };
      if (effectiveUsername.trim()) {
        filter['userUsername'] = { $includes: effectiveUsername.trim() };
      }
      if (effectiveCollection) {
        filter['collectionName'] = effectiveCollection;
      }
      if (effectiveAction) {
        filter['actionName'] = effectiveAction;
      }
      if (effectiveStatus === 'success') {
        filter['statusCode'] = { $lt: 400 };
      } else if (effectiveStatus === 'error') {
        filter['statusCode'] = { $gte: 400 };
      }

      const res = await api.request({
        url: 'logger_audit_logs:list',
        params: {
          page: currentPage,
          pageSize: currentPageSize,
          filter,
          sort: ['-createdAt'],
          fields: [
            'id',
            'createdAt',
            'userUsername',
            'userNickname',
            'collectionName',
            'actionName',
            'recordId',
            'path',
            'method',
            'ip',
            'statusCode',
            'durationMs',
            'reqId',
          ],
        },
      });

      const items = res?.data?.data || [];
      const count = res?.data?.meta?.count || items.length;
      setData(items);
      setTotal(count);
    } catch (err: any) {
      message.error(`加载审计日志失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 3. 打开 Diff 对比弹窗 (按需异步获取完整快照)
  const handleOpenDiff = async (record: any) => {
    setSelectedRecord(record);
    setDiffModalVisible(true);
    if (!record.diff && !record.beforeData && !record.afterData) {
      setDiffLoading(true);
      try {
        const res = await api.request({
          url: 'logger_audit_logs:get',
          params: { filterByTk: record.id },
        });
        const fullRecord = res?.data?.data || res?.data || record;
        setSelectedRecord(fullRecord);
      } catch (err: any) {
        message.error(`获取变更详情失败: ${err.message}`);
      } finally {
        setDiffLoading(false);
      }
    }
  };

  // 4. 打开详情抽屉 (按需异步获取完整参数及错误)
  const handleOpenDrawer = async (record: any) => {
    setDrawerRecord(record);
    setDrawerVisible(true);
    if (!record.params && !record.errorMessage && !record.userAgent) {
      setDrawerLoading(true);
      try {
        const res = await api.request({
          url: 'logger_audit_logs:get',
          params: { filterByTk: record.id },
        });
        const fullRecord = res?.data?.data || res?.data || record;
        setDrawerRecord(fullRecord);
      } catch (err: any) {
        message.error(`获取报文详情失败: ${err.message}`);
      } finally {
        setDrawerLoading(false);
      }
    }
  };

  useEffect(() => {
    fetchCollections();
  }, []);

  useEffect(() => {
    fetchAuditLogs(page, pageSize);
  }, [page, pageSize, collectionName, actionName, statusFilter]);

  const handleSearch = () => {
    if (page !== 1) {
      setPage(1);
      return;
    }
    fetchAuditLogs(1, pageSize);
  };

  const handleReset = () => {
    setUsername('');
    setCollectionName(undefined);
    setActionName(undefined);
    setStatusFilter(undefined);
    setNlQuery('');
    setNlTags([]);
    setNlExtraFilter({});
    setNlError(null);
    setNlEngineMeta(null);
    // 第 1 页时依赖不变不会自动翻页，需要主动再拉一次
    if (page !== 1) {
      setPage(1);
      return;
    }
    fetchAuditLogs(1, pageSize, {});
  };

  // 自然语言转结构化查询条件 (NL2Filter)
  const handleNLSearch = async (forceHeuristic = false) => {
    const q = nlQuery.trim();
    if (!q) {
      message.warning('请输入自然语言查询描述');
      return;
    }
    setNlLoading(true);
    setNlError(null);
    try {
      const res = await api.request({
        url: 'loggerPro:nlToFilter',
        method: 'post',
        data: { query: q, forceHeuristic },
      });
      const data = res?.data?.data || res?.data;
      if (data?.success) {
        const ui = data.uiFields || {};
        const f = data.filter || {};
        setUsername(ui.username || '');
        setCollectionName(ui.collectionName || undefined);
        setActionName(ui.actionName || undefined);
        setStatusFilter(ui.statusFilter || undefined);

        const extra: Record<string, any> = {};
        if (f.createdAt) extra.createdAt = f.createdAt;
        if (f.method) extra.method = f.method;
        if (f.path) extra.path = f.path;
        if (typeof f.statusCode === 'number' || (f.statusCode && !ui.statusFilter)) {
          extra.statusCode = f.statusCode;
        }
        setNlExtraFilter(extra);
        setNlTags(Array.isArray(data.tags) ? data.tags : []);
        setNlEngineMeta({
          engine: data.engine,
          llmService: data.llmService,
          model: data.model,
        });
        message.success(data.explanation || '已解析查询条件并自动筛选');

        // 构造完整 filter 立即查询
        const immediateFilter: Record<string, any> = { ...extra };
        if (ui.username) immediateFilter.userUsername = { $includes: ui.username };
        if (ui.collectionName) immediateFilter.collectionName = ui.collectionName;
        if (ui.actionName) immediateFilter.actionName = ui.actionName;
        if (ui.statusFilter === 'success') immediateFilter.statusCode = { $lt: 400 };
        else if (ui.statusFilter === 'error') immediateFilter.statusCode = { $gte: 400 };

        setPage(1);
        fetchAuditLogs(1, pageSize, immediateFilter);
      } else {
        setNlError({
          message: data?.errorMessage || '未能解析自然语言查询条件',
          errorCode: data?.errorCode,
        });
      }
    } catch (err: any) {
      setNlError({ message: `智能查询解析失败: ${err.message}` });
      message.error(`智能查询解析失败: ${err.message}`);
    } finally {
      setNlLoading(false);
    }
  };

  const handleRemoveNLTag = (tagKey: string) => {
    setNlTags((prev) => prev.filter((t) => t.key !== tagKey));
    const nextExtra = { ...nlExtraFilter };
    const overrideFields: {
      username?: string;
      collectionName?: string | null;
      actionName?: string | null;
      statusFilter?: string | null;
    } = {};

    if (tagKey === 'username') {
      setUsername('');
      overrideFields.username = '';
    } else if (tagKey === 'collectionName') {
      setCollectionName(undefined);
      overrideFields.collectionName = null;
    } else if (tagKey === 'actionName') {
      setActionName(undefined);
      overrideFields.actionName = null;
    } else if (tagKey === 'statusFilter') {
      setStatusFilter(undefined);
      overrideFields.statusFilter = null;
    } else if (tagKey === 'statusCode') {
      setStatusFilter(undefined);
      overrideFields.statusFilter = null;
      delete nextExtra.statusCode;
    } else if (tagKey === 'createdAt') {
      delete nextExtra.createdAt;
    } else if (tagKey === 'method') {
      delete nextExtra.method;
    } else if (tagKey === 'path') {
      delete nextExtra.path;
    }
    setNlExtraFilter(nextExtra);
    setPage(1);
    fetchAuditLogs(1, pageSize, nextExtra, overrideFields);
  };

  const getActionTagColor = (act: string) => {
    switch (act) {
      case 'create':
        return 'green';
      case 'update':
        return 'blue';
      case 'destroy':
        return 'red';
      default:
        return 'cyan';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 单行紧凑工具条 */}
      <Card size="small" bordered bodyStyle={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <Space wrap size={8}>
              <Space.Compact size="middle">
                <Input
                  size="middle"
                  prefix={<RobotOutlined style={{ color: token.colorPrimary }} />}
                  placeholder='AI 智能搜索，如 "昨天 admin 删除失败"'
                  style={{ width: 210 }}
                  value={nlQuery}
                  onChange={(e) => setNlQuery(e.target.value)}
                  onPressEnter={() => handleNLSearch(false)}
                  allowClear
                />
                <Button size="middle" type="primary" loading={nlLoading} onClick={() => handleNLSearch(false)}>
                  AI 筛选
                </Button>
              </Space.Compact>

              <Input
                size="middle"
                placeholder="操作人"
                style={{ width: 96 }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onPressEnter={handleSearch}
                allowClear
                onClear={() => setUsername('')}
              />

              <Select
                size="middle"
                placeholder="目标数据表"
                style={{ width: 132 }}
                value={collectionName}
                onChange={(v) => {
                  setPage(1);
                  setCollectionName(v);
                }}
                allowClear
                showSearch
                filterOption={(input, option: any) =>
                  (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                }
                options={collectionsList.map((c) => ({
                  label: `${c.title} (${c.name})`,
                  value: c.name,
                }))}
              />

              <Select
                size="middle"
                placeholder="动作"
                style={{ width: 92 }}
                value={actionName}
                onChange={(v) => {
                  setPage(1);
                  setActionName(v);
                }}
                allowClear
                options={[
                  { label: 'create', value: 'create' },
                  { label: 'update', value: 'update' },
                  { label: 'destroy', value: 'destroy' },
                ]}
              />

              <Select
                size="middle"
                placeholder="状态"
                style={{ width: 92 }}
                value={statusFilter}
                onChange={(v) => {
                  setPage(1);
                  setStatusFilter(v);
                }}
                allowClear
                options={[
                  { label: '成功 (<400)', value: 'success' },
                  { label: '失败 (>=400)', value: 'error' },
                ]}
              />

              <Button size="middle" type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
                查询
              </Button>
              <Button size="middle" onClick={handleReset}>
                重置
              </Button>
            </Space>

            <Space size={6}>
              <Button
                size="middle"
                icon={<ExportOutlined />}
                onClick={() => setExportDrawerVisible(true)}
              >
                导出
              </Button>
              <Button size="middle" icon={<ReloadOutlined />} onClick={() => fetchAuditLogs()} loading={loading}>
                刷新
              </Button>
            </Space>
          </div>

          {nlError && (
            <Alert
              type="error"
              showIcon
              closable
              onClose={() => setNlError(null)}
              message={
                nlError.errorCode === 'LLM_NOT_CONFIGURED'
                  ? '未配置可用的真实 LLM 服务'
                  : 'AI 智能筛选调用失败'
              }
              description={nlError.message}
              action={
                <Button size="middle" type="primary" onClick={() => handleNLSearch(true)} loading={nlLoading}>
                  内置规则兜底
                </Button>
              }
            />
          )}

          {nlTags.length > 0 && (
            <Space wrap size={4}>
              {nlEngineMeta && (
                <AIEngineBadge
                  engine={nlEngineMeta.engine}
                  llmService={nlEngineMeta.llmService}
                  model={nlEngineMeta.model}
                />
              )}
              <span style={{ fontSize: 12, color: token.colorTextSecondary }}>已解析条件:</span>
              {nlTags.map((t) => (
                <Tag key={t.key} color="purple" closable onClose={() => handleRemoveNLTag(t.key)}>
                  {t.label}
                </Tag>
              ))}
            </Space>
          )}
        </div>
      </Card>

      {/* 审计日志核心字段表 */}
      <Card bordered bodyStyle={{ padding: 0 }}>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={data}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: ['15', '30', '50', '100'],
            showTotal: (t) => `共 ${t} 条记录`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
          columns={[
            {
              title: '操作时间',
              dataIndex: 'createdAt',
              width: 168,
              render: (t) => (
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                  {t ? new Date(t).toLocaleString() : '-'}
                </span>
              ),
            },
            {
              title: '操作人',
              dataIndex: 'userUsername',
              width: 140,
              render: (u, r) => (
                <div>
                  <span style={{ fontWeight: 500, color: token.colorText }}>{u || 'Anonymous'}</span>
                  {r.userNickname && <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{r.userNickname}</div>}
                </div>
              ),
            },
            {
              title: '目标数据表',
              dataIndex: 'collectionName',
              ellipsis: true,
              render: (c) => <code style={{ color: token.colorPrimary }}>{c || '-'}</code>,
            },
            {
              title: '操作类型',
              dataIndex: 'actionName',
              width: 110,
              render: (act) => <Tag color={getActionTagColor(act)}>{act}</Tag>,
            },
            {
              title: '状态 / 耗时',
              width: 130,
              render: (_, r) => {
                const isOk = r.statusCode < 400;
                return (
                  <Space size={6}>
                    <Tag icon={isOk ? <CheckCircleOutlined /> : <CloseCircleOutlined />} color={isOk ? 'success' : 'error'}>
                      {r.statusCode || 200}
                    </Tag>
                    <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{r.durationMs ?? 0}ms</span>
                  </Space>
                );
              },
            },
            {
              title: '操作',
              width: 200,
              render: (_, r) => (
                <Space size={2}>
                  <Button size="middle" type="link" icon={<EyeOutlined />} onClick={() => handleOpenDrawer(r)}>
                    详情
                  </Button>
                  <Button size="middle" type="link" icon={<DiffOutlined />} onClick={() => handleOpenDiff(r)}>
                    Diff
                  </Button>
                  <Button
                    size="middle"
                    type="link"
                    icon={<DeploymentUnitOutlined />}
                    disabled={!r.reqId}
                    onClick={() => {
                      setTraceReqId(r.reqId);
                      setTraceDrawerVisible(true);
                    }}
                  >
                    追踪
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* Diff 对比抽屉 */}
      <DiffModal
        visible={diffModalVisible}
        onClose={() => {
          setDiffModalVisible(false);
          setSelectedRecord(null);
        }}
        record={selectedRecord}
        loading={diffLoading}
      />

      {/* 审计日志完整详情右侧 Drawer */}
      <Drawer
        title="审计日志详情"
        placement="right"
        width={620}
        onClose={() => {
          setDrawerVisible(false);
          setDrawerRecord(null);
        }}
        open={drawerVisible}
        extra={
          drawerRecord && (
            <Space>
              <Button size="middle" icon={<DiffOutlined />} onClick={() => handleOpenDiff(drawerRecord)}>
                数据 Diff
              </Button>
              {drawerRecord.reqId && (
                <Button
                  size="middle"
                  icon={<DeploymentUnitOutlined />}
                  onClick={() => {
                    setTraceReqId(drawerRecord.reqId);
                    setTraceDrawerVisible(true);
                  }}
                >
                  全链路追踪
                </Button>
              )}
            </Space>
          )
        }
      >
        <Spin spinning={drawerLoading}>
          {drawerRecord && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="操作人">
                  {drawerRecord.userUsername || 'Anonymous'} {drawerRecord.userNickname ? `(${drawerRecord.userNickname})` : ''}
                </Descriptions.Item>
                <Descriptions.Item label="客户端 IP">{drawerRecord.ip || '-'}</Descriptions.Item>
                <Descriptions.Item label="目标数据表">{drawerRecord.collectionName || '-'}</Descriptions.Item>
                <Descriptions.Item label="操作类型">
                  <Tag color={getActionTagColor(drawerRecord.actionName)}>{drawerRecord.actionName}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="请求路径" span={2}>
                  <Space size={6}>
                    <Tag>{drawerRecord.method}</Tag>
                    <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{drawerRecord.path || '-'}</code>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="ReqId" span={2}>
                  <Text copyable style={{ fontSize: 12, fontFamily: 'monospace' }}>
                    {drawerRecord.reqId || '-'}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="发生时间">
                  {drawerRecord.createdAt ? new Date(drawerRecord.createdAt).toLocaleString() : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="状态 / 耗时">
                  HTTP {drawerRecord.statusCode || 200} ({drawerRecord.durationMs ?? 0} ms)
                </Descriptions.Item>
              </Descriptions>

              {drawerRecord.errorMessage && (
                <div>
                  <div style={{ color: token.colorError, fontWeight: 600, marginBottom: 6 }}>异常错误信息</div>
                  <pre
                    style={{
                      background: token.colorErrorBg,
                      border: `1px solid ${token.colorErrorBorder}`,
                      padding: 12,
                      borderRadius: 6,
                      color: token.colorErrorText,
                      whiteSpace: 'pre-wrap',
                      margin: 0,
                    }}
                  >
                    {drawerRecord.errorMessage}
                  </pre>
                </div>
              )}

              <div>
                <div style={{ fontWeight: 600, color: token.colorText, marginBottom: 6 }}>请求参数 (Params / Values)</div>
                <pre
                  style={{
                    background: token.colorFillAlter,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    color: token.colorText,
                    padding: 12,
                    borderRadius: 6,
                    maxHeight: 280,
                    overflow: 'auto',
                    fontSize: 12,
                    margin: 0,
                  }}
                >
                  {JSON.stringify(drawerRecord.params, null, 2) || '(空)'}
                </pre>
              </div>

              <div>
                <div style={{ fontWeight: 600, color: token.colorText, marginBottom: 6 }}>客户端 User-Agent</div>
                <div
                  style={{
                    background: token.colorFillAlter,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    padding: 10,
                    borderRadius: 6,
                    fontSize: 12,
                    color: token.colorTextSecondary,
                    wordBreak: 'break-all',
                  }}
                >
                  {drawerRecord.userAgent || '-'}
                </div>
              </div>
            </div>
          )}
        </Spin>
      </Drawer>

      {/* 审计日志导出抽屉 */}
      <AuditLogExportDrawer
        visible={exportDrawerVisible}
        onClose={() => setExportDrawerVisible(false)}
        collections={collectionsList}
      />
      {/* 全链路请求追踪抽屉 */}
      <TraceDrawer
        visible={traceDrawerVisible}
        reqId={traceReqId}
        onClose={() => setTraceDrawerVisible(false)}
      />
    </div>
  );
};
