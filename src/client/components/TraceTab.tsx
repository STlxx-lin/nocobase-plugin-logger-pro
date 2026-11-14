import React, { useState, useEffect } from 'react';
import {
  Card,
  Input,
  Button,
  Space,
  Table,
  Tag,
  message,
  theme,
} from 'antd';
import {
  DeploymentUnitOutlined,
  SearchOutlined,
  ReloadOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import { useLoggerProAPI } from '../context/LoggerProContext';
import { TraceDrawer } from './TraceDrawer';

export const TraceTab: React.FC = () => {
  const { token } = theme.useToken();
  const api = useLoggerProAPI();
  const [reqIdInput, setReqIdInput] = useState('');

  // 最近请求列表
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentTraces, setRecentTraces] = useState<any[]>([]);

  // 右侧全链路追踪 Drawer
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [activeReqId, setActiveReqId] = useState<string | null>(null);

  const fetchRecentTraces = async () => {
    setRecentLoading(true);
    try {
      const res = await api.request({
        url: 'loggerPro:getRecentTraces',
        params: { limit: 30 },
      });
      const list = res?.data?.data || res?.data || [];
      setRecentTraces(Array.isArray(list) ? list : []);
    } catch {
      // ignore
    } finally {
      setRecentLoading(false);
    }
  };

  useEffect(() => {
    fetchRecentTraces();
  }, []);

  const openTraceDrawer = (id?: string) => {
    const trimmed = (id || '').trim();
    if (!trimmed) {
      message.warning('请输入要追踪的 Request ID (reqId)');
      return;
    }
    setActiveReqId(trimmed);
    setDrawerVisible(true);
  };

  const getMethodColor = (method?: string) => {
    const m = (method || '').toUpperCase();
    if (m === 'GET') return 'blue';
    if (m === 'POST') return 'green';
    if (m === 'PUT' || m === 'PATCH') return 'orange';
    if (m === 'DELETE') return 'red';
    return 'default';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 单行紧凑工具条 */}
      <Card bordered size="small" bodyStyle={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Space size={8} style={{ flex: 1, minWidth: 280 }}>
            <Input
              size="middle"
              prefix={<DeploymentUnitOutlined style={{ color: token.colorPrimary }} />}
              placeholder="输入 Request ID (reqId) 追踪全链路"
              style={{ width: 340, maxWidth: '100%' }}
              value={reqIdInput}
              onChange={(e) => setReqIdInput(e.target.value)}
              onPressEnter={() => openTraceDrawer(reqIdInput)}
              allowClear
            />
            <Button size="middle" type="primary" icon={<SearchOutlined />} onClick={() => openTraceDrawer(reqIdInput)}>
              追踪请求
            </Button>
          </Space>

          <Button size="middle" icon={<ReloadOutlined />} onClick={fetchRecentTraces} loading={recentLoading}>
            刷新
          </Button>
        </div>
      </Card>

      {/* 最近 API 请求核心字段列表 */}
      <Card bordered bodyStyle={{ padding: 0 }}>
        <Table
          rowKey={(r) => r.reqId || `${r.method}-${r.path}-${r.startTime || Math.random()}`}
          size="small"
          loading={recentLoading}
          dataSource={recentTraces}
          pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 条最近请求` }}
          onRow={(record) => ({
            onClick: () => {
              if (record.reqId) {
                setReqIdInput(record.reqId);
                openTraceDrawer(record.reqId);
              }
            },
            style: { cursor: record.reqId ? 'pointer' : 'default' },
          })}
          columns={[
            {
              title: '方法',
              dataIndex: 'method',
              width: 86,
              render: (m) => (
                <Tag color={getMethodColor(m)} style={{ margin: 0, fontWeight: 500 }}>
                  {m || '-'}
                </Tag>
              ),
            },
            {
              title: '目标模块 / 摘要',
              dataIndex: 'collectionName',
              ellipsis: true,
              render: (col, r) => (
                <span style={{ fontWeight: 500, color: token.colorText }}>
                  {col || r.path || '-'}
                </span>
              ),
            },
            {
              title: 'Request ID',
              dataIndex: 'reqId',
              width: 190,
              render: (id) => (
                <code style={{ fontSize: 12, color: token.colorTextSecondary }}>
                  {id ? `${id.slice(0, 18)}...` : '-'}
                </code>
              ),
            },
            {
              title: '状态',
              dataIndex: 'statusCode',
              width: 90,
              render: (code) => (
                <Tag color={code < 400 ? 'success' : 'error'} style={{ margin: 0 }}>
                  {code ?? '-'}
                </Tag>
              ),
            },
            {
              title: '耗时',
              dataIndex: 'durationMs',
              width: 95,
              render: (ms) => (
                <span style={{ fontSize: 12, color: ms > 1000 ? token.colorError : token.colorTextSecondary }}>
                  {ms ?? 0} ms
                </span>
              ),
            },
            {
              title: '操作',
              key: 'action',
              width: 100,
              render: (_: any, record: any) => (
                <Button
                  size="middle"
                  type="link"
                  icon={<EyeOutlined />}
                  disabled={!record.reqId}
                  onClick={(e) => {
                    e.stopPropagation();
                    setReqIdInput(record.reqId);
                    openTraceDrawer(record.reqId);
                  }}
                >
                  查看详情
                </Button>
              ),
            },
          ]}
          locale={{ emptyText: '暂无最近 API 请求记录' }}
        />
      </Card>

      {/* 全链路追踪详情右侧 Drawer */}
      <TraceDrawer
        visible={drawerVisible}
        reqId={activeReqId}
        onClose={() => setDrawerVisible(false)}
      />
    </div>
  );
};
