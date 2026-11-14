import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Table,
  Progress,
  Button,
  Tag,
  Space,
  Alert,
  Empty,
  Drawer,
  Tooltip,
  Spin,
  message,
  theme,
} from 'antd';
import {
  LineChartOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  HddOutlined,
  ReloadOutlined,
  ClockCircleOutlined,
  UserOutlined,
  DatabaseOutlined,
  CopyOutlined,
  CodeOutlined,
  RobotOutlined,
  EyeOutlined,
  PieChartOutlined,
} from '@ant-design/icons';
import { useLoggerProAPI } from '../context/LoggerProContext';
import { streamActionSSE } from '../utils/sseStream';
import { MarkdownRenderer, AIEngineBadge, AIThinkingPanel } from './MarkdownRenderer';

export const DashboardTab: React.FC = () => {
  const { token } = theme.useToken();
  const api = useLoggerProAPI();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [recentAlerts, setRecentAlerts] = useState<any[]>([]);
  const [alertDrawerVisible, setAlertDrawerVisible] = useState(false);
  const [viewingSql, setViewingSql] = useState<{ sql: string; durationMs: number; time: string } | null>(null);
  const [statsDrawerVisible, setStatsDrawerVisible] = useState(false);

  // AI 健康巡检 Drawer 状态
  const [inspecting, setInspecting] = useState(false);
  const [inspectionReport, setInspectionReport] = useState<any>(null);
  const [inspectionVisible, setInspectionVisible] = useState(false);
  const [inspectionError, setInspectionError] = useState<{ message: string; errorCode?: string } | null>(null);
  const inspectingRef = React.useRef(false);
  const latestInspectionLoadedRef = React.useRef(false);

  const fetchLatestInspection = async () => {
    try {
      const res = await api.request({ url: 'loggerPro:getLatestHealthInspection' });
      const rec = res?.data?.data || res?.data;
      if (rec && rec.analysisReport && !inspectingRef.current) {
        setInspectionReport(rec);
      }
    } catch {} finally {
      latestInspectionLoadedRef.current = true;
    }
  };

  const handleRunHealthInspection = async (forceHeuristic = false) => {
    inspectingRef.current = true;
    setInspecting(true);
    setInspectionVisible(true);
    setInspectionError(null);
    let accumulated = '';
    let accumulatedReasoning = '';
    let analyzerName = 'AI 系统健康巡检';
    let metaInfo: Record<string, any> = {};
    let businessError: { message: string; errorCode?: string } | null = null;

    try {
      let done = false;
      await streamActionSSE(api, 'loggerPro:healthInspectionStream', { forceHeuristic }, (ev) => {
        if (ev.type === 'meta') {
          analyzerName = ev.analyzerName || analyzerName;
          metaInfo = { engine: ev.engine, llmService: ev.llmService, model: ev.model };
          setInspectionReport({
            analyzerName,
            ...metaInfo,
            analysisReport: '',
            reasoningContent: '',
            createdAt: new Date().toISOString(),
          });
        } else if (ev.type === 'reasoning') {
          accumulatedReasoning += ev.content || '';
          setInspectionReport({
            analyzerName,
            ...metaInfo,
            reasoningContent: accumulatedReasoning,
            analysisReport: accumulated,
            createdAt: new Date().toISOString(),
          });
        } else if (ev.type === 'chunk') {
          accumulated += ev.content || '';
          setInspectionReport({
            analyzerName,
            ...metaInfo,
            reasoningContent: accumulatedReasoning,
            analysisReport: accumulated,
            createdAt: new Date().toISOString(),
          });
        } else if (ev.type === 'done') {
          done = true;
          setInspectionReport({
            ...ev,
            reasoningContent: ev.reasoningContent || accumulatedReasoning,
          });
          message.success(
            ev.engine === 'heuristic'
              ? '已使用内置规则引擎生成健康巡检报告（非真实 AI）'
              : 'AI 系统健康巡检报告已生成并归档',
          );
        } else if (ev.type === 'error') {
          businessError = { message: ev.message || '健康巡检失败', errorCode: ev.errorCode };
          throw new Error(businessError.message);
        }
      });
      if (done) {
        inspectingRef.current = false;
        setInspecting(false);
        return;
      }
    } catch {
      if (businessError) {
        setInspectionError(businessError);
        setInspectionReport(null);
        inspectingRef.current = false;
        setInspecting(false);
        return;
      }
    }

    try {
      const res = await api.request({
        url: 'loggerPro:healthInspection',
        method: 'post',
        data: { forceHeuristic },
      });
      const resData = res?.data?.data || res?.data;
      if (resData?.success === false) {
        setInspectionError({
          message: resData.errorMessage || resData.analysisReport || '健康巡检失败',
          errorCode: resData.errorCode,
        });
        setInspectionReport(null);
      } else if (resData?.analysisReport) {
        setInspectionReport(resData);
        message.success(
          resData.engine === 'heuristic'
            ? '已使用内置规则引擎生成健康巡检报告（非真实 AI）'
            : 'AI 系统健康巡检报告已生成',
        );
      }
    } catch (err: any) {
      setInspectionError({ message: `健康巡检失败: ${err.message}` });
      message.error(`健康巡检失败: ${err.message}`);
    } finally {
      inspectingRef.current = false;
      setInspecting(false);
    }
  };

  const handleOpenInspectionDrawer = () => {
    setInspectionVisible(true);
    if (latestInspectionLoadedRef.current && !inspectionReport && !inspectionError && !inspectingRef.current) {
      handleRunHealthInspection(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [overviewRes, alertsRes] = await Promise.all([
        api.request({ url: 'loggerPro:dashboard' }),
        api
          .request({
            url: 'logger_alert_logs:list',
            params: { pageSize: 10, sort: ['-createdAt'] },
          })
          .catch(() => ({ data: { data: [] } })),
      ]);
      setData(overviewRes?.data?.data || overviewRes?.data);
      const alertList = alertsRes?.data?.data || [];
      setRecentAlerts(Array.isArray(alertList) ? alertList : []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    fetchLatestInspection();
  }, []);

  const summary = data?.summary || {};
  const trend = data?.trend || [];
  const categoryStats = data?.categoryStats || [];
  const topSlowQueries = data?.topSlowQueries || [];
  const topUsers = data?.topUsers || [];
  const topCollections = data?.topCollections || [];

  const maxTrendVal = Math.max(...trend.map((t: any) => Math.max(t.requests || 0, t.errors || 0)), 10);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶部精简操作区 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: token.colorText }}>运维概览</span>
        <Space size={6}>
          <Button
            size="middle"
            type="primary"
            style={{ backgroundColor: '#722ed1', borderColor: '#722ed1' }}
            icon={<RobotOutlined />}
            loading={inspecting}
            onClick={handleOpenInspectionDrawer}
          >
            AI 健康巡检
          </Button>
          <Button size="middle" icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      {/* 4 个核心指标卡 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <Card
            bordered
            hoverable
            style={{
              background: `linear-gradient(135deg, rgba(24, 144, 255, 0.12) 0%, ${token.colorBgContainer} 100%)`,
              backgroundColor: token.colorBgContainer,
            }}
          >
            <Statistic
              title={
                <span style={{ fontWeight: 500 }}>
                  <LineChartOutlined /> 今日操作审计量
                </span>
              }
              value={summary.todayAuditCount ?? 0}
              valueStyle={{ color: token.colorInfo, fontWeight: 'bold' }}
              suffix={<span style={{ fontSize: 13, color: token.colorTextTertiary }}>/ 累计 {summary.totalAuditCount ?? 0}</span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card
            bordered
            hoverable
            style={{
              background: `linear-gradient(135deg, rgba(255, 77, 79, 0.12) 0%, ${token.colorBgContainer} 100%)`,
              backgroundColor: token.colorBgContainer,
            }}
          >
            <Statistic
              title={
                <span style={{ fontWeight: 500 }}>
                  <ExclamationCircleOutlined /> 今日异常错误数
                </span>
              }
              value={summary.todayErrorCount ?? 0}
              valueStyle={{ color: summary.todayErrorCount > 0 ? token.colorError : token.colorSuccess, fontWeight: 'bold' }}
              suffix={<span style={{ fontSize: 13, color: token.colorTextTertiary }}>次</span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card
            bordered
            hoverable
            style={{
              background: `linear-gradient(135deg, rgba(82, 196, 26, 0.12) 0%, ${token.colorBgContainer} 100%)`,
              backgroundColor: token.colorBgContainer,
            }}
          >
            <Statistic
              title={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 500 }}>
                    <FileTextOutlined /> 今日告警触发
                  </span>
                  <Button
                    type="link"
                    size="middle"
                    style={{ padding: 0, height: 'auto', fontSize: 12 }}
                    onClick={() => setAlertDrawerVisible(true)}
                  >
                    查看详情
                  </Button>
                </div>
              }
              value={summary.todayAlertCount ?? 0}
              valueStyle={{ color: summary.todayAlertCount > 0 ? token.colorWarning : token.colorSuccess, fontWeight: 'bold' }}
              suffix={<span style={{ fontSize: 13, color: token.colorTextTertiary }}>次</span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card
            bordered
            hoverable
            style={{
              background: `linear-gradient(135deg, rgba(114, 46, 209, 0.12) 0%, ${token.colorBgContainer} 100%)`,
              backgroundColor: token.colorBgContainer,
            }}
          >
            <Statistic
              title={
                <span style={{ fontWeight: 500 }}>
                  <HddOutlined /> 日志磁盘占用
                </span>
              }
              value={summary.totalDiskFormatted ?? '0 MB'}
              valueStyle={{ color: '#722ed1', fontWeight: 'bold' }}
              suffix={<span style={{ fontSize: 13, color: token.colorTextTertiary }}>({summary.totalLogFiles ?? 0} 个文件)</span>}
            />
          </Card>
        </Col>
      </Row>

      {/* 7 日趋势 */}
      <Card title="近 7 天请求量与异常走势" bordered size="small">
        {trend.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, fontSize: 12, color: token.colorTextSecondary }}>
              <span>
                <span style={{ display: 'inline-block', width: 10, height: 10, background: token.colorInfo, borderRadius: 2, marginRight: 4 }} />
                操作请求量
              </span>
              <span>
                <span style={{ display: 'inline-block', width: 10, height: 10, background: token.colorError, borderRadius: 2, marginRight: 4 }} />
                异常错误量
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                height: 160,
                gap: 12,
                paddingBottom: 22,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              {trend.map((item: any, idx: number) => {
                const reqHeight = Math.max((item.requests / maxTrendVal) * 116, 6);
                const errHeight = Math.max((item.errors / maxTrendVal) * 116, item.errors > 0 ? 6 : 0);
                return (
                  <div
                    key={idx}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}
                  >
                    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', width: '100%', justifyContent: 'center' }}>
                      <Tooltip title={`请求: ${item.requests}`}>
                        <div
                          style={{
                            width: '38%',
                            height: reqHeight,
                            background: token.colorInfo,
                            borderRadius: '4px 4px 0 0',
                            transition: 'height 0.3s',
                          }}
                        />
                      </Tooltip>
                      <Tooltip title={`错误: ${item.errors}`}>
                        <div
                          style={{
                            width: '38%',
                            height: errHeight,
                            background: token.colorError,
                            borderRadius: '4px 4px 0 0',
                            transition: 'height 0.3s',
                          }}
                        />
                      </Tooltip>
                    </div>
                    <span style={{ fontSize: 11, color: token.colorTextSecondary, marginTop: 6 }}>{item.date}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无趋势数据" />
        )}
      </Card>

      {/* 紧凑的慢查与异常/分布摘要 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card
            size="small"
            bordered
            title={
              <Space>
                <ClockCircleOutlined style={{ color: token.colorWarning }} />
                <span>Top 慢 SQL 摘要</span>
                {topSlowQueries.length > 0 && <Tag color="orange">{topSlowQueries.length} 条</Tag>}
              </Space>
            }
          >
            <Table
              size="small"
              rowKey={(_r, idx) => String(idx)}
              dataSource={topSlowQueries.slice(0, 5)}
              pagination={false}
              columns={[
                {
                  title: '耗时',
                  dataIndex: 'durationMs',
                  width: 88,
                  render: (v) => <Tag color={v > 1000 ? 'red' : 'orange'}>{v} ms</Tag>,
                },
                {
                  title: 'SQL 语句',
                  dataIndex: 'sql',
                  ellipsis: true,
                  render: (sql, record: any) => (
                    <span
                      style={{
                        cursor: 'pointer',
                        fontFamily: 'Consolas, Monaco, monospace',
                        fontSize: 12,
                        color: token.colorPrimary,
                      }}
                      onClick={() =>
                        setViewingSql({
                          sql: record.sql,
                          durationMs: record.durationMs,
                          time: record.time,
                        })
                      }
                    >
                      <code>{sql}</code>
                    </span>
                  ),
                },
                {
                  title: '时间',
                  dataIndex: 'time',
                  width: 95,
                  render: (t) => (
                    <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                      {t ? new Date(t).toLocaleTimeString() : '-'}
                    </span>
                  ),
                },
                {
                  title: '操作',
                  key: 'action',
                  width: 90,
                  render: (_: any, record: any) => (
                    <Button
                      type="link"
                      size="middle"
                      icon={<EyeOutlined />}
                      onClick={() =>
                        setViewingSql({
                          sql: record.sql,
                          durationMs: record.durationMs,
                          time: record.time,
                        })
                      }
                    >
                      查看详情
                    </Button>
                  ),
                },
              ]}
              locale={{ emptyText: '暂无慢 SQL 记录' }}
            />
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card
            size="small"
            bordered
            title={
              <Space>
                <PieChartOutlined style={{ color: token.colorPrimary }} />
                <span>运行分布与活跃摘要</span>
              </Space>
            }
            extra={
              <Button type="link" size="middle" icon={<EyeOutlined />} onClick={() => setStatsDrawerVisible(true)}>
                查看详情
              </Button>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 6 }}>日志磁盘分类</div>
                {categoryStats.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {categoryStats.slice(0, 4).map((item: any, idx: number) => (
                      <Tag key={idx} color="blue">
                        {item.name}: {item.formatted}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <span style={{ fontSize: 12, color: token.colorTextTertiary }}>暂无分类数据</span>
                )}
              </div>

              <div>
                <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 6 }}>活跃用户 Top 3</div>
                {topUsers.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {topUsers.slice(0, 3).map((u: any, idx: number) => (
                      <Tag key={idx} color={idx === 0 ? 'gold' : 'default'}>
                        {u.username} ({u.count})
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <span style={{ fontSize: 12, color: token.colorTextTertiary }}>暂无操作记录</span>
                )}
              </div>

              <div>
                <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 6 }}>高频变更数据表 Top 3</div>
                {topCollections.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {topCollections.slice(0, 3).map((c: any, idx: number) => (
                      <Tag key={idx} color="purple">
                        {c.collection} ({c.count})
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <span style={{ fontSize: 12, color: token.colorTextTertiary }}>暂无变更记录</span>
                )}
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* AI 健康巡检右侧 Drawer */}
      <Drawer
        title={
          <Space>
            <RobotOutlined style={{ color: '#722ed1', fontSize: 17 }} />
            <span>{inspectionReport?.analyzerName || 'AI 系统健康巡检'}</span>
            {inspectionReport && (
              <AIEngineBadge
                streaming={inspecting}
                engine={inspectionReport.engine}
                llmService={inspectionReport.llmService}
                model={inspectionReport.model}
                analyzerName={inspectionReport.analyzerName}
              />
            )}
          </Space>
        }
        placement="right"
        width={760}
        open={inspectionVisible}
        onClose={() => setInspectionVisible(false)}
        extra={
          <Space>
            {inspectionReport?.analysisReport && (
              <Button
                size="middle"
                icon={<CopyOutlined />}
                onClick={() => {
                  navigator.clipboard.writeText(inspectionReport.analysisReport || '');
                  message.success('巡检报告已复制');
                }}
              >
                复制报告
              </Button>
            )}
            <Button
              size="middle"
              type="primary"
              style={{ backgroundColor: '#722ed1', borderColor: '#722ed1' }}
              icon={<RobotOutlined />}
              loading={inspecting}
              onClick={() => handleRunHealthInspection(false)}
            >
              重新巡检
            </Button>
          </Space>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {inspectionError && (
            <Alert
              type="error"
              showIcon
              message={
                inspectionError.errorCode === 'LLM_NOT_CONFIGURED'
                  ? '未配置可用的真实 LLM 服务'
                  : 'AI 健康巡检调用真实 LLM 失败'
              }
              description={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span>{inspectionError.message}</span>
                  <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
                    请前往 NocoBase 管理后台【AI 员工 / LLM 服务】配置真实大模型，或在「日志配置」标签页设置默认 LLM 服务。
                  </span>
                </div>
              }
              action={
                <Space direction="vertical" size="small">
                  <Button size="middle" type="primary" onClick={() => handleRunHealthInspection(true)} loading={inspecting}>
                    内置规则兜底巡检
                  </Button>
                  <Button size="middle" onClick={() => handleRunHealthInspection(false)} loading={inspecting}>
                    重试真实 AI
                  </Button>
                </Space>
              }
            />
          )}

          {inspecting || inspectionReport?.analysisReport || inspectionReport?.reasoningContent ? (
            <div>
              {inspectionReport?.createdAt && (
                <div style={{ marginBottom: 10, fontSize: 12, color: token.colorTextSecondary }}>
                  生成时间: {new Date(inspectionReport.createdAt).toLocaleString()}
                </div>
              )}
              <AIThinkingPanel
                reasoning={
                  inspectionReport?.reasoningContent ||
                  (Array.isArray(inspectionReport?.messages)
                    ? inspectionReport.messages.find((m: any) => m.role === 'assistant' && m.reasoningContent)?.reasoningContent
                    : undefined)
                }
                streaming={inspecting}
                hasContent={Boolean(inspectionReport?.analysisReport)}
              />
              <MarkdownRenderer
                content={inspectionReport?.analysisReport}
                streaming={inspecting && Boolean(inspectionReport?.analysisReport)}
              />
            </div>
          ) : !inspectionError ? (
            <Empty description="点击右上角「重新巡检」生成最新系统健康评估报告" />
          ) : null}
        </div>
      </Drawer>

      {/* 慢 SQL 详情右侧 Drawer */}
      <Drawer
        title={
          <Space>
            <ClockCircleOutlined style={{ color: token.colorWarning }} />
            <span>慢 SQL 查询详情</span>
            {viewingSql && (
              <Tag color={viewingSql.durationMs > 1000 ? 'red' : 'orange'}>耗时: {viewingSql.durationMs} ms</Tag>
            )}
          </Space>
        }
        placement="right"
        width={680}
        open={!!viewingSql}
        onClose={() => setViewingSql(null)}
        extra={
          viewingSql?.sql && (
            <Button
              size="middle"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(viewingSql.sql);
                message.success('SQL 语句已复制到剪贴板');
              }}
            >
              复制 SQL
            </Button>
          )
        }
      >
        {viewingSql && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
              发生时间: {viewingSql.time ? new Date(viewingSql.time).toLocaleString() : '-'}
            </div>
            <pre
              style={{
                backgroundColor: '#141414',
                color: '#d4d4d4',
                padding: 16,
                borderRadius: token.borderRadiusSM,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                fontSize: 13,
                lineHeight: '22px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                border: `1px solid ${token.colorBorderSecondary}`,
                margin: 0,
              }}
            >
              {viewingSql.sql}
            </pre>
          </div>
        )}
      </Drawer>

      {/* 运行分布与活跃榜单详情 Drawer */}
      <Drawer
        title="运行分布与活跃榜单详情 (近 7 天)"
        placement="right"
        width={600}
        open={statsDrawerVisible}
        onClose={() => setStatsDrawerVisible(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Card size="small" title="日志分类磁盘分布" bordered>
            {categoryStats.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {categoryStats.map((item: any, idx: number) => {
                  const totalBytes = summary.totalDiskBytes || 1;
                  const percent = Math.round((item.value / totalBytes) * 100);
                  const colors = ['#1890ff', '#52c41a', '#faad14', '#ff4d4f', '#722ed1'];
                  const color = colors[idx % colors.length];
                  return (
                    <div key={idx}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                        <span style={{ fontWeight: 500, color: token.colorText }}>{item.name} 日志</span>
                        <span style={{ color: token.colorTextSecondary }}>
                          {item.formatted} ({percent}%)
                        </span>
                      </div>
                      <Progress percent={percent} strokeColor={color} showInfo={false} size="small" />
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分类数据" />
            )}
          </Card>

          <Card
            size="small"
            bordered
            title={
              <Space>
                <UserOutlined style={{ color: token.colorPrimary }} />
                <span>活跃用户 Top 5</span>
              </Space>
            }
          >
            <Space wrap>
              {topUsers.length > 0 ? (
                topUsers.map((u: any, idx: number) => (
                  <Tag key={idx} color={idx === 0 ? 'gold' : 'blue'}>
                    {u.username}: <strong>{u.count}</strong> 次操作
                  </Tag>
                ))
              ) : (
                <span style={{ fontSize: 12, color: token.colorTextTertiary }}>暂无操作记录</span>
              )}
            </Space>
          </Card>

          <Card
            size="small"
            bordered
            title={
              <Space>
                <DatabaseOutlined style={{ color: '#722ed1' }} />
                <span>高频变更数据表 Top 5</span>
              </Space>
            }
          >
            <Space wrap>
              {topCollections.length > 0 ? (
                topCollections.map((c: any, idx: number) => (
                  <Tag key={idx} color="purple">
                    {c.collection}: <strong>{c.count}</strong> 次变更
                  </Tag>
                ))
              ) : (
                <span style={{ fontSize: 12, color: token.colorTextTertiary }}>暂无变更记录</span>
              )}
            </Space>
          </Card>
        </div>
      </Drawer>
      {/* 近期告警记录右侧 Drawer */}
      <Drawer
        title="近期告警触发记录"
        placement="right"
        width={680}
        open={alertDrawerVisible}
        onClose={() => setAlertDrawerVisible(false)}
        extra={
          <Button size="middle" icon={<ReloadOutlined />} loading={loading} onClick={fetchData}>
            刷新
          </Button>
        }
      >
        <Table
          rowKey={(r, idx) => String(r.id || idx)}
          size="small"
          loading={loading}
          dataSource={recentAlerts}
          pagination={false}
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
                  <div style={{ fontWeight: 500, color: token.colorText }}>{title || '-'}</div>
                  {r.errorMsg && <div style={{ color: token.colorError, fontSize: 12 }}>{r.errorMsg}</div>}
                </div>
              ),
            },
          ]}
          locale={{ emptyText: '暂无近期告警记录' }}
        />
      </Drawer>
    </div>
  );
};
