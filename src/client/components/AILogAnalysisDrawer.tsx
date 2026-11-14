import React, { useState, useEffect, useRef } from 'react';
import {
  Drawer,
  Spin,
  Button,
  Input,
  Select,
  Card,
  Space,
  Tag,
  Switch,
  Modal,
  message,
  Row,
  Col,
  Tabs,
  List,
  Popconfirm,
  Badge,
  Empty,
  Divider,
  Descriptions,
  Alert,
  theme,
} from 'antd';
import {
  RobotOutlined,
  ThunderboltOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  ApiOutlined,
  HistoryOutlined,
  DeleteOutlined,
  ReloadOutlined,
  EyeOutlined,
  ClockCircleOutlined,
  ClearOutlined,
  DeploymentUnitOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
  MessageOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useLoggerProAPI } from '../context/LoggerProContext';
import { streamActionSSE } from '../utils/sseStream';
import { MarkdownRenderer, AIEngineBadge, AIThinkingPanel } from './MarkdownRenderer';

const { TextArea } = Input;
const LOCAL_STORAGE_AI_RECORDS = 'nocobase_logger_ai_analysis_history';

export interface AILogAnalysisDrawerProps {
  visible: boolean;
  onClose: () => void;
  initialLogText?: string;
  context?: {
    reqId?: string;
    method?: string;
    path?: string;
    statusCode?: number;
    durationMs?: number;
    username?: string;
    ip?: string;
    collectionName?: string;
    actionName?: string;
    sqlQueries?: string[];
    timelineCount?: number;
    [key: string]: any;
  };
}

export const AILogAnalysisDrawer: React.FC<AILogAnalysisDrawerProps> = ({
  visible,
  onClose,
  initialLogText = '',
  context,
}) => {
  const { token } = theme.useToken();
  const api = useLoggerProAPI();
  const [activeTab, setActiveTab] = useState<'analyze' | 'history'>('analyze');
  const [logText, setLogText] = useState(initialLogText);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);

  // 隐私脱敏开关与预览
  const [sanitizeEnabled, setSanitizeEnabled] = useState<boolean>(true);
  const [previewVisible, setPreviewVisible] = useState<boolean>(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);

  // 1. 已配置的 AI 员工列表
  const [employees, setEmployees] = useState<any[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string>('system-error-expert');

  // 2. 已配置的 LLM 服务列表
  const [llmServices, setLlmServices] = useState<any[]>([]);
  const [selectedLLMKey, setSelectedLLMKey] = useState<string>('');

  // 3. 当前诊断结果 & 多轮追问对话
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [analysisError, setAnalysisError] = useState<{ message: string; errorCode?: string } | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<number | string | undefined>(undefined);
  const [chatMessages, setChatMessages] = useState<Array<{
    role: string;
    content: string;
    reasoningContent?: string;
    createdAt?: string;
    engine?: 'llm' | 'heuristic' | string;
    llmService?: string;
    model?: string;
  }>>([]);
  const [followUpInput, setFollowUpInput] = useState<string>('');
  const [followUpLoading, setFollowUpLoading] = useState<boolean>(false);
  const [followUpStreamingReply, setFollowUpStreamingReply] = useState<string>('');
  const [followUpStreamingReasoning, setFollowUpStreamingReasoning] = useState<string>('');
  const [followUpError, setFollowUpError] = useState<{ message: string; errorCode?: string; question: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 4. 历史记录数据
  const [historyRecords, setHistoryRecords] = useState<any[]>([]);
  const [historyTotal, setHistoryTotal] = useState<number>(0);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [viewingRecord, setViewingRecord] = useState<any>(null);

  const fetchAIMetadata = async () => {
    try {
      const [empRes, llmRes, cfgRes] = await Promise.all([
        api.request({ url: 'loggerPro:getAIEmployees' }).catch(() => ({ data: [] })),
        api.request({ url: 'loggerPro:getLLMServices' }).catch(() => ({ data: [] })),
        api.request({ url: 'loggerPro:getConfigs' }).catch(() => ({ data: {} })),
      ]);

      const empList = empRes?.data?.data || empRes?.data || [];
      const llmList = llmRes?.data?.data || llmRes?.data || [];
      const configs = cfgRes?.data?.data || cfgRes?.data || {};

      if (Array.isArray(empList) && empList.length > 0) {
        setEmployees(empList);
        const defaultEmp = configs.ai_default_employee;
        setSelectedEmployee((prev) => {
          if (prev && prev !== 'system-error-expert') return prev;
          if (defaultEmp && empList.some((e: any) => e.name === defaultEmp)) return defaultEmp;
          return empList[0].name;
        });
      }

      if (Array.isArray(llmList) && llmList.length > 0) {
        setLlmServices(llmList);
        const defaultSvc = configs.ai_default_llm_service;
        const defaultModel = configs.ai_default_llm_model;
        setSelectedLLMKey((prev) => {
          if (prev) return prev;
          if (defaultSvc) {
            const matched = llmList.find((s: any) => String(s.llmService) === String(defaultSvc));
            if (matched) {
              const mVal = defaultModel || matched?.enabledModels?.[0]?.value || 'default';
              return `${matched.llmService}:${mVal}`;
            }
          }
          const first = llmList[0];
          const modelVal = first?.enabledModels?.[0]?.value || 'default';
          return `${first.llmService}:${modelVal}`;
        });
      } else {
        setLlmServices([]);
        setSelectedLLMKey('');
      }
    } catch {}
  };

  const getLocalRecords = (): any[] => {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_AI_RECORDS);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const saveLocalRecord = (record: any) => {
    try {
      const list = getLocalRecords();
      const updated = [record, ...list.filter((r) => String(r.id) !== String(record.id))].slice(0, 50);
      localStorage.setItem(LOCAL_STORAGE_AI_RECORDS, JSON.stringify(updated));
    } catch {}
  };

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await api.request({
        url: 'loggerPro:getAIAnalysisHistory',
        params: { page: 1, pageSize: 50 },
      });
      const data = res?.data?.data || res?.data;
      if (data && Array.isArray(data.rows) && data.rows.length > 0) {
        setHistoryRecords(data.rows);
        setHistoryTotal(data.count || data.rows.length);
      } else {
        const localList = getLocalRecords();
        setHistoryRecords(localList);
        setHistoryTotal(localList.length);
      }
    } catch {
      const localList = getLocalRecords();
      setHistoryRecords(localList);
      setHistoryTotal(localList.length);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      setActiveTab('analyze');
      setViewingRecord(null);
      fetchAIMetadata();
      fetchHistory();
      setLogText(initialLogText);
      setAnalysisResult(null);
      setAnalysisError(null);
      setActiveRecordId(undefined);
      setChatMessages([]);
      setFollowUpInput('');
      setFollowUpStreamingReply('');
      setFollowUpError(null);
    } else {
      abortControllerRef.current?.abort();
    }
  }, [visible, initialLogText]);

  const getLLMSelection = () => {
    if (!selectedLLMKey) return undefined;
    const parts = selectedLLMKey.split(':');
    return {
      llmService: parts[0],
      model: parts.slice(1).join(':'),
    };
  };

  // 预览脱敏与压缩后文本
  const handlePreviewSanitized = async () => {
    if (!logText || !logText.trim()) {
      message.warning('请先输入日志文本');
      return;
    }
    setPreviewLoading(true);
    setPreviewVisible(true);
    try {
      const res = await api.request({
        url: 'loggerPro:previewSanitizedLog',
        method: 'post',
        data: {
          logText: logText.trim(),
          sanitize: sanitizeEnabled,
        },
      });
      setPreviewData(res?.data?.data || res?.data || null);
    } catch (err: any) {
      message.error(`预览失败: ${err.message}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  // 执行 AI 诊断（优先 SSE 流式，仅在通道不可用时降级同步；真实 LLM 报错时明确提示并提供可选兜底）
  const handleAnalyze = async (forceHeuristic = false) => {
    if (!logText || !logText.trim()) {
      message.warning('请输入或提供错误日志文本进行分析');
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setStreaming(true);
    setAnalysisResult(null);
    setAnalysisError(null);
    setActiveRecordId(undefined);
    setChatMessages([]);
    setFollowUpError(null);

    const llmSelection = forceHeuristic ? undefined : getLLMSelection();
    const payload = {
      logText: logText.trim(),
      employeeName: selectedEmployee,
      llmSelection,
      context,
      sanitize: sanitizeEnabled,
      forceHeuristic,
    };

    let accumulated = '';
    let accumulatedReasoning = '';
    let currentAnalyzerName = 'AI 诊断专家';
    let currentMeta: Record<string, any> = {};
    let streamSucceeded = false;
    let businessError: { message: string; errorCode?: string } | null = null;

    try {
      await streamActionSSE(
        api,
        'loggerPro:analyzeErrorLogStream',
        payload,
        (ev) => {
          if (ev.type === 'meta') {
            currentAnalyzerName = ev.analyzerName || currentAnalyzerName;
            currentMeta = {
              engine: ev.engine,
              llmService: ev.llmService,
              model: ev.model,
            };
            setAnalysisResult({
              success: true,
              analyzerName: currentAnalyzerName,
              ...currentMeta,
              analysisReport: '',
              reasoningContent: '',
              durationMs: 0,
              maskedCount: ev.maskedCount,
              maskedTypes: ev.maskedTypes,
              compressedStats: ev.compressedStats,
            });
          } else if (ev.type === 'reasoning') {
            accumulatedReasoning += ev.content || '';
            setAnalysisResult((prev: any) => ({
              ...(prev || {}),
              success: true,
              analyzerName: currentAnalyzerName,
              ...currentMeta,
              reasoningContent: accumulatedReasoning,
            }));
          } else if (ev.type === 'chunk') {
            accumulated += ev.content || '';
            setAnalysisResult((prev: any) => ({
              ...(prev || {}),
              success: true,
              analyzerName: currentAnalyzerName,
              ...currentMeta,
              reasoningContent: prev?.reasoningContent || accumulatedReasoning,
              analysisReport: accumulated,
            }));
          } else if (ev.type === 'done') {
            streamSucceeded = true;
            const finalData = {
              id: ev.id,
              success: ev.success !== false,
              analyzerName: ev.analyzerName || currentAnalyzerName,
              engine: ev.engine || currentMeta.engine,
              llmService: ev.llmService || currentMeta.llmService,
              model: ev.model || currentMeta.model,
              analysisReport: ev.analysisReport || accumulated,
              reasoningContent: ev.reasoningContent || accumulatedReasoning,
              durationMs: ev.durationMs || 0,
              messages: ev.messages || [],
              maskedCount: ev.maskedCount,
              maskedTypes: ev.maskedTypes,
              compressedStats: ev.compressedStats,
            };
            setAnalysisResult(finalData);
            setActiveRecordId(finalData.id);
            setChatMessages(finalData.messages || []);
            saveLocalRecord({
              id: finalData.id || `rec_${Date.now()}`,
              analyzerName: finalData.analyzerName,
              employeeName: selectedEmployee,
              llmService: finalData.llmService || llmSelection?.llmService || 'builtin',
              model: finalData.model || llmSelection?.model || 'default',
              logSummary: (logText.trim().split(/\r?\n/)[0] || '').slice(0, 150),
              logText: logText.trim(),
              analysisReport: finalData.analysisReport,
              messages: finalData.messages || [],
              durationMs: finalData.durationMs,
              createdAt: new Date().toISOString(),
            });
            message.success(
              finalData.engine === 'heuristic'
                ? '已使用内置规则引擎完成兜底分析（非真实 AI）'
                : '🎉 AI 错误日志诊断分析完成，已保存至历史记录！',
            );
            fetchHistory();
          } else if (ev.type === 'error') {
            businessError = { message: ev.message || '流式诊断异常', errorCode: ev.errorCode };
            throw new Error(businessError.message);
          }
        },
        controller.signal,
      );

      if (streamSucceeded) {
        setLoading(false);
        setStreaming(false);
        return;
      }
    } catch (streamErr: any) {
      if (controller.signal.aborted) {
        setLoading(false);
        setStreaming(false);
        return;
      }
      if (businessError) {
        setStreaming(false);
        setLoading(false);
        setAnalysisResult(null);
        setAnalysisError(businessError);
        return;
      }
      // 仅当 SSE 传输层异常时降级为同步请求
    }

    setStreaming(false);
    try {
      const res = await api.request({
        url: 'loggerPro:analyzeErrorLog',
        method: 'post',
        data: payload,
      });

      const data = res?.data?.data || res?.data;
      if (data?.success) {
        setAnalysisResult(data);
        setActiveRecordId(data.id);
        setChatMessages(data.messages || []);
        saveLocalRecord({
          id: data.id || `rec_${Date.now()}`,
          analyzerName: data.analyzerName || 'AI 诊断专家',
          employeeName: selectedEmployee,
          llmService: data.llmService || llmSelection?.llmService || 'builtin',
          model: data.model || llmSelection?.model || 'default',
          logSummary: (logText.trim().split(/\r?\n/)[0] || '').slice(0, 150),
          logText: logText.trim(),
          analysisReport: data.analysisReport,
          messages: data.messages || [],
          durationMs: data.durationMs || 0,
          createdAt: new Date().toISOString(),
        });

        message.success(
          data.engine === 'heuristic'
            ? '已使用内置规则引擎完成兜底分析（非真实 AI）'
            : '🎉 AI 错误日志诊断分析完成（同步模式），已保存至历史记录！',
        );
        fetchHistory();
      } else {
        setAnalysisResult(null);
        setAnalysisError({
          message: data?.errorMessage || data?.analysisReport || 'AI 诊断调用失败',
          errorCode: data?.errorCode,
        });
      }
    } catch (err: any) {
      setAnalysisError({ message: `AI 诊断失败: ${err.message || '网络异常'}` });
      message.error(`AI 诊断失败: ${err.message || '网络异常'}`);
    } finally {
      setLoading(false);
    }
  };

  // 发送多轮追问（SSE 流式优先 + 同步传输降级；真实 LLM 失败时明确报错并提供兜底）
  const handleSendFollowUp = async (forceHeuristic = false, overrideQuestion?: string) => {
    const q = (overrideQuestion ?? followUpInput).trim();
    if (!q || followUpLoading) return;

    setFollowUpLoading(true);
    if (!overrideQuestion) {
      setFollowUpInput('');
    }
    setFollowUpStreamingReply('');
    setFollowUpStreamingReasoning('');
    setFollowUpError(null);

    const optimisticUserMsg = { role: 'user', content: q, createdAt: new Date().toISOString() };
    const prevMessages = [...chatMessages];
    setChatMessages([...prevMessages, optimisticUserMsg]);

    const llmSelection = forceHeuristic ? undefined : getLLMSelection();
    const payload = {
      recordId: activeRecordId,
      question: q,
      messages: prevMessages,
      logText: logText.trim(),
      employeeName: selectedEmployee,
      llmSelection,
      sanitize: sanitizeEnabled,
      forceHeuristic,
    };

    let accumulated = '';
    let accumulatedReasoning = '';
    let doneHandled = false;
    let businessError: { message: string; errorCode?: string } | null = null;

    try {
      await streamActionSSE(api, 'loggerPro:aiFollowUpStream', payload, (ev) => {
        if (ev.type === 'reasoning') {
          accumulatedReasoning += ev.content || '';
          setFollowUpStreamingReasoning(accumulatedReasoning);
        } else if (ev.type === 'chunk') {
          accumulated += ev.content || '';
          setFollowUpStreamingReply(accumulated);
        } else if (ev.type === 'done') {
          doneHandled = true;
          setFollowUpStreamingReply('');
          setFollowUpStreamingReasoning('');
          if (Array.isArray(ev.messages)) {
            setChatMessages(ev.messages);
          } else {
            setChatMessages([
              ...prevMessages,
              optimisticUserMsg,
              {
                role: 'assistant',
                content: ev.reply || accumulated,
                reasoningContent: ev.reasoningContent || accumulatedReasoning || undefined,
                createdAt: new Date().toISOString(),
              },
            ]);
          }
          fetchHistory();
        } else if (ev.type === 'error') {
          businessError = { message: ev.message || '追问流式异常', errorCode: ev.errorCode };
          throw new Error(businessError.message);
        }
      });

      if (doneHandled) {
        setFollowUpLoading(false);
        return;
      }
    } catch {
      setFollowUpStreamingReply('');
      setFollowUpStreamingReasoning('');
      if (businessError) {
        setChatMessages(prevMessages);
        setFollowUpError({ ...businessError, question: q });
        setFollowUpLoading(false);
        return;
      }
    }

    try {
      const res = await api.request({
        url: 'loggerPro:aiFollowUp',
        method: 'post',
        data: payload,
      });
      const data = res?.data?.data || res?.data;
      if (data?.success) {
        setChatMessages(
          data.messages || [...prevMessages, optimisticUserMsg, { role: 'assistant', content: data.reply }],
        );
        fetchHistory();
      } else {
        setChatMessages(prevMessages);
        setFollowUpError({
          message: data?.errorMessage || data?.reply || '追问调用 LLM 失败',
          errorCode: data?.errorCode,
          question: q,
        });
      }
    } catch (err: any) {
      setChatMessages(prevMessages);
      setFollowUpError({
        message: `追问失败: ${err.message || '网络异常'}`,
        question: q,
      });
    } finally {
      setFollowUpLoading(false);
    }
  };

  // 删除单条历史
  const handleDeleteRecord = async (id: number | string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.request({
        url: 'loggerPro:deleteAIAnalysisRecord',
        params: { id },
      });
    } catch {}

    try {
      const list = getLocalRecords();
      const updated = list.filter((r) => String(r.id) !== String(id));
      localStorage.setItem(LOCAL_STORAGE_AI_RECORDS, JSON.stringify(updated));
    } catch {}

    message.success('已删除该条诊断记录');
    if (viewingRecord?.id === id) {
      setViewingRecord(null);
    }
    fetchHistory();
  };

  // 清空所有历史
  const handleClearHistory = async () => {
    try {
      await api.request({
        url: 'loggerPro:clearAIAnalysisHistory',
        method: 'post',
      });
    } catch {}

    try {
      localStorage.removeItem(LOCAL_STORAGE_AI_RECORDS);
    } catch {}

    message.success('历史诊断记录已全部清空');
    setHistoryRecords([]);
    setHistoryTotal(0);
    setViewingRecord(null);
  };

  // 打开历史记录详情
  const handleViewRecord = async (rec: any) => {
    if (rec?.analysisReport && rec?.logText) {
      setViewingRecord(rec);
      return;
    }
    setViewingRecord(rec);
    if (rec?.id === undefined || rec?.id === null) return;
    try {
      const res = await api.request({
        url: 'loggerPro:getAIAnalysisRecord',
        params: { id: rec.id },
      });
      const full = res?.data?.data || res?.data;
      if (full && typeof full === 'object' && Object.keys(full).length > 0) {
        setViewingRecord({ ...rec, ...full });
        saveLocalRecord({ ...rec, ...full });
      }
    } catch {}
  };

  // 载入历史记录到诊断工作台并恢复多轮对话继续追问
  const handleLoadHistoryToAnalyze = async (rec: any) => {
    let full = rec;
    if ((!rec.logText || !rec.messages) && rec?.id !== undefined && rec?.id !== null) {
      try {
        const res = await api.request({
          url: 'loggerPro:getAIAnalysisRecord',
          params: { id: rec.id },
        });
        const data = res?.data?.data || res?.data;
        if (data && typeof data === 'object') {
          full = { ...rec, ...data };
        }
      } catch {}
    }
    setLogText(full.logText || '');
    if (full.employeeName) setSelectedEmployee(full.employeeName);
    if (full.llmService && full.llmService !== 'builtin') {
      setSelectedLLMKey(`${full.llmService}:${full.model || 'default'}`);
    }
    setActiveRecordId(full.id);
    setAnalysisResult({
      id: full.id,
      success: true,
      analyzerName: full.analyzerName,
      engine: full.llmService === 'builtin' || full.model === 'heuristic' ? 'heuristic' : 'llm',
      llmService: full.llmService,
      model: full.model,
      analysisReport: full.analysisReport,
      durationMs: full.durationMs || 0,
    });
    const loadedMessages = Array.isArray(full.messages)
      ? full.messages
      : full.analysisReport
        ? [
            { role: 'user', content: full.logSummary || '历史日志诊断' },
            { role: 'assistant', content: full.analysisReport },
          ]
        : [];
    setChatMessages(loadedMessages);
    setViewingRecord(null);
    setActiveTab('analyze');
    message.info('已恢复历史诊断报告与对话上下文，可直接继续追问');
  };

  const handleCopyReport = (reportText?: string) => {
    const content = reportText || analysisResult?.analysisReport || viewingRecord?.analysisReport;
    if (content) {
      navigator.clipboard.writeText(content);
      message.success('诊断报告已复制到剪贴板');
    }
  };

  const employeeOptions = employees.map((e) => ({
    label: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <RobotOutlined style={{ color: '#722ed1' }} />
        <span>{e.title}</span>
      </div>
    ),
    value: e.name,
  }));

  const llmOptions = llmServices.map((s) => {
    const models = s.enabledModels || [];
    if (models.length === 1 && models[0].value === 'default') {
      return {
        label: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ApiOutlined style={{ color: '#1890ff' }} />
            <span>{s.llmServiceTitle}</span>
          </div>
        ),
        value: `${s.llmService}:default`,
      };
    }

    return {
      label: `🌐 ${s.llmServiceTitle}`,
      options: models.map((m: any) => ({
        label: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ApiOutlined style={{ color: '#1890ff' }} />
            <span>{m.label || m.value}</span>
          </div>
        ),
        value: `${s.llmService}:${m.value}`,
      })),
    };
  });

  // 过滤出多轮追问的后续消息（跳过第 1 轮原始 prompt 与首份报告）
  const followUpChatList = chatMessages.length > 2 ? chatMessages.slice(2) : [];

  return (
    <Drawer
      title={
        <Space align="center" style={{ width: '100%' }}>
          <RobotOutlined style={{ color: '#722ed1', fontSize: 18 }} />
          <span style={{ fontWeight: 600, fontSize: 15 }}>AI 错误日志智能诊断 (AI Error Diagnostics)</span>
          {streaming && <Tag color="processing">SSE 实时流式输出中...</Tag>}
        </Space>
      }
      open={visible}
      onClose={onClose}
      width={900}
      extra={
        <Space size={6} align="center">
          {(analysisResult || viewingRecord) && (
            <Button
              size="middle"
              icon={<CopyOutlined />}
              onClick={() => handleCopyReport()}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              复制报告
            </Button>
          )}
          <Button size="middle" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center' }}>
            关闭
          </Button>
          {activeTab === 'analyze' && (
            <Button
              size="middle"
              type="primary"
              style={{
                backgroundColor: '#722ed1',
                borderColor: '#722ed1',
                display: 'inline-flex',
                alignItems: 'center',
              }}
              icon={<ThunderboltOutlined />}
              loading={loading}
              onClick={() => handleAnalyze(false)}
            >
              ⚡ 开始 AI 诊断
            </Button>
          )}
        </Space>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={(key: any) => {
          setActiveTab(key);
          if (key === 'history') fetchHistory();
        }}
        items={[
          {
            key: 'analyze',
            label: (
              <Space>
                <ThunderboltOutlined />
                <span>智能诊断分析</span>
              </Space>
            ),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* 1. 选择 AI 员工与 LLM 服务 + 脱敏开关 */}
                <Card size="small" bordered style={{ backgroundColor: token.colorPrimaryBg, borderColor: token.colorPrimaryBorder }}>
                  <Row gutter={[16, 12]}>
                    <Col xs={24} sm={12}>
                      <div style={{ marginBottom: 6, fontWeight: 600, color: token.colorPrimaryText }}>
                        🤖 选择已配置的 AI 员工:
                      </div>
                      <Select
                        value={selectedEmployee}
                        onChange={setSelectedEmployee}
                        style={{ width: '100%' }}
                        options={employeeOptions}
                        placeholder="选择 AI 员工"
                      />
                    </Col>

                    <Col xs={24} sm={12}>
                      <div style={{ marginBottom: 6, fontWeight: 600, color: token.colorPrimaryText }}>
                        🧠 选择已配置的 LLM 服务:
                      </div>
                      <Select
                        value={selectedLLMKey}
                        onChange={setSelectedLLMKey}
                        style={{ width: '100%' }}
                        options={llmOptions}
                        placeholder="留空则使用插件默认或首个可用真实 LLM"
                        allowClear
                      />
                    </Col>

                    <Col xs={24}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <Space>
                          <SafetyCertificateOutlined style={{ color: sanitizeEnabled ? '#52c41a' : '#8c8c8c' }} />
                          <span style={{ fontSize: 13, fontWeight: 500 }}>发送前自动脱敏敏感信息 (Token / 密钥 / 连接串 / 手机号 / 邮箱)</span>
                          <Switch checked={sanitizeEnabled} onChange={setSanitizeEnabled} size="small" />
                        </Space>
                        <Button size="middle" icon={<EyeOutlined />} onClick={handlePreviewSanitized}>
                          预览脱敏与压缩文本
                        </Button>
                      </div>
                    </Col>
                  </Row>
                </Card>

                {/* 全链路追踪绑定上下文 */}
                {context && (context.reqId || context.path) && (
                  <Card
                    size="small"
                    style={{
                      backgroundColor: token.colorInfoBg,
                      borderColor: token.colorInfoBorder,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <Space>
                        <DeploymentUnitOutlined style={{ color: token.colorInfo, fontSize: 16 }} />
                        <strong style={{ color: token.colorInfoText, fontSize: 13 }}>
                          🌐 已深度绑定全链路追踪上下文 (Trace Context Attached)
                        </strong>
                      </Space>
                      {context.reqId && (
                        <Tag color="blue" style={{ fontFamily: 'monospace', margin: 0 }}>
                          ReqId: {context.reqId}
                        </Tag>
                      )}
                    </div>
                    <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }} bordered style={{ backgroundColor: token.colorBgContainer }}>
                      <Descriptions.Item label="请求接口">
                        <Tag color="green">{context.method || 'GET'}</Tag>
                        <code>{context.path || '-'}</code>
                      </Descriptions.Item>
                      <Descriptions.Item label="请求状态">
                        <Tag color={(context as any).statusCode && (context as any).statusCode < 400 ? 'success' : 'error'}>
                          HTTP {(context as any).statusCode || 200}
                        </Tag>
                        {(context as any).durationMs !== undefined && (
                          <span style={{ fontSize: 12, color: '#8c8c8c' }}> ({(context as any).durationMs}ms)</span>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="操作用户">
                        <span>{(context as any).username || '系统访问'}</span>
                        {(context as any).ip && <span style={{ fontSize: 11, color: '#8c8c8c' }}> ({(context as any).ip})</span>}
                      </Descriptions.Item>
                      <Descriptions.Item label="关联模块/动作">
                        <span>{context.collectionName || '-'}{context.actionName ? ` : ${context.actionName}` : ''}</span>
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                )}

                {/* 2. 待诊断错误日志输入 */}
                <Card
                  size="small"
                  title={
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Space>
                        <CodeOutlined style={{ color: '#ff4d4f' }} />
                        <strong>待分析的错误日志 / 调用堆栈 (Error Log & Stacktrace)</strong>
                      </Space>
                      <Button size="middle" type="link" onClick={() => setLogText('')}>
                        清空
                      </Button>
                    </div>
                  }
                >
                  <TextArea
                    rows={6}
                    value={logText}
                    onChange={(e) => setLogText(e.target.value)}
                    placeholder="粘贴错误日志行或异常调用堆栈..."
                    style={{
                      backgroundColor: '#141414',
                      color: '#ff7875',
                      fontFamily: 'Consolas, Monaco, monospace',
                      fontSize: 12,
                      borderRadius: 6,
                    }}
                  />
                </Card>

                {/* 3. AI 诊断报告 */}
                <Spin spinning={loading && !analysisResult} tip="AI 正在深度解析日志堆栈并生成根因分析...">
                  {analysisError ? (
                    <Alert
                      type="error"
                      showIcon
                      message={
                        analysisError.errorCode === 'LLM_NOT_CONFIGURED'
                          ? '未配置可用的真实 LLM 服务'
                          : '真实 AI 诊断调用失败'
                      }
                      description={
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span>{analysisError.message}</span>
                          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                            💡 请前往 NocoBase 管理后台【AI 员工 / LLM 服务】配置真实大模型，或在「配置管理」标签页设置默认 LLM 服务。
                          </span>
                        </div>
                      }
                      action={
                        <Space direction="vertical" size="small">
                          <Button type="primary" size="middle" onClick={() => handleAnalyze(true)} loading={loading}>
                            使用内置规则兜底分析
                          </Button>
                          <Button size="middle" onClick={() => handleAnalyze(false)} loading={loading}>
                            重试真实 AI
                          </Button>
                        </Space>
                      }
                    />
                  ) : analysisResult ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <Card
                        size="small"
                        bordered
                        style={{
                          backgroundColor: token.colorBgContainer,
                          borderLeft: `4px solid ${token.colorPrimary}`,
                        }}
                        title={
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                            <Space wrap>
                              <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 16 }} />
                              <strong>诊断分析报告 ({analysisResult.analyzerName})</strong>
                              <AIEngineBadge
                                streaming={streaming}
                                engine={analysisResult.engine}
                                llmService={analysisResult.llmService}
                                model={analysisResult.model}
                                analyzerName={analysisResult.analyzerName}
                              />
                            </Space>
                            <Space wrap>
                              {analysisResult.maskedCount > 0 && (
                                <Tag color="purple">🔒 已脱敏 {analysisResult.maskedCount} 处</Tag>
                              )}
                              {analysisResult.compressedStats?.deduplicatedLines > 0 && (
                                <Tag color="blue">🗜️ 已去重 {analysisResult.compressedStats.deduplicatedLines} 行</Tag>
                              )}
                              {analysisResult.durationMs > 0 && (
                                <Tag color="cyan">⏱️ 耗时: {analysisResult.durationMs} ms</Tag>
                              )}
                              {!streaming && <Tag color="green">💾 已归档</Tag>}
                            </Space>
                          </div>
                        }
                      >
                        <AIThinkingPanel
                          reasoning={analysisResult.reasoningContent}
                          streaming={streaming}
                          hasContent={Boolean(analysisResult.analysisReport)}
                        />
                        <MarkdownRenderer
                          content={analysisResult.analysisReport}
                          streaming={streaming && Boolean(analysisResult.analysisReport)}
                        />
                      </Card>

                      {/* 4. 多轮追问对话区 */}
                      <Card
                        size="small"
                        bordered
                        title={
                          <Space>
                            <MessageOutlined style={{ color: token.colorPrimary }} />
                            <strong>多轮追问对话 (上下文已持久化)</strong>
                          </Space>
                        }
                      >
                        {followUpChatList.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12, maxHeight: 340, overflowY: 'auto' }}>
                            {followUpChatList.map((msg, idx) => (
                              <div
                                key={idx}
                                style={{
                                  padding: '10px 12px',
                                  borderRadius: token.borderRadiusLG,
                                  backgroundColor: msg.role === 'user' ? token.colorFillAlter : token.colorBgContainer,
                                  border: `1px solid ${msg.role === 'user' ? token.colorBorderSecondary : token.colorPrimaryBorder}`,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    marginBottom: 6,
                                    color: msg.role === 'user' ? token.colorTextSecondary : token.colorPrimaryText,
                                  }}
                                >
                                  <span>
                                    {msg.role === 'user' ? <><UserOutlined /> 你的追问</> : <><RobotOutlined /> AI 回复</>}
                                  </span>
                                  {msg.role !== 'user' && (
                                    <AIEngineBadge
                                      engine={msg.engine || analysisResult.engine}
                                      llmService={msg.llmService || analysisResult.llmService}
                                      model={msg.model || analysisResult.model}
                                      analyzerName={analysisResult.analyzerName}
                                    />
                                  )}
                                </div>
                                {msg.role === 'user' ? (
                                  <div style={{ fontSize: 13, color: token.colorText }}>{msg.content}</div>
                                ) : (
                                  <>
                                    <AIThinkingPanel reasoning={msg.reasoningContent} hasContent={Boolean(msg.content)} />
                                    <MarkdownRenderer content={msg.content} />
                                  </>
                                )}
                              </div>
                            ))}
                            {(followUpLoading || followUpStreamingReply || followUpStreamingReasoning) && (
                              <div
                                style={{
                                  padding: '10px 12px',
                                  borderRadius: token.borderRadiusLG,
                                  backgroundColor: token.colorBgContainer,
                                  border: `1px solid ${token.colorPrimaryBorder}`,
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6, color: token.colorPrimaryText }}>
                                  <span><RobotOutlined /> AI 回复</span>
                                  <AIEngineBadge streaming={followUpLoading} />
                                </div>
                                <AIThinkingPanel
                                  reasoning={followUpStreamingReasoning}
                                  streaming={followUpLoading}
                                  hasContent={Boolean(followUpStreamingReply)}
                                />
                                <MarkdownRenderer
                                  content={followUpStreamingReply}
                                  streaming={followUpLoading && Boolean(followUpStreamingReply)}
                                />
                              </div>
                            )}
                          </div>
                        )}

                        {followUpChatList.length === 0 && (followUpLoading || followUpStreamingReply || followUpStreamingReasoning) && (
                          <div
                            style={{
                              padding: '10px 12px',
                              borderRadius: token.borderRadiusLG,
                              backgroundColor: token.colorBgContainer,
                              border: `1px solid ${token.colorPrimaryBorder}`,
                              marginBottom: 12,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6, color: token.colorPrimaryText }}>
                              <span><RobotOutlined /> AI 回复</span>
                              <AIEngineBadge streaming={followUpLoading} />
                            </div>
                            <AIThinkingPanel
                              reasoning={followUpStreamingReasoning}
                              streaming={followUpLoading}
                              hasContent={Boolean(followUpStreamingReply)}
                            />
                            <MarkdownRenderer
                              content={followUpStreamingReply}
                              streaming={followUpLoading && Boolean(followUpStreamingReply)}
                            />
                          </div>
                        )}

                        {followUpError && (
                          <Alert
                            type="error"
                            showIcon
                            closable
                            style={{ marginBottom: 12 }}
                            onClose={() => setFollowUpError(null)}
                            message="追问调用真实 LLM 失败"
                            description={followUpError.message}
                            action={
                              <Space>
                                <Button
                                  size="middle"
                                  type="primary"
                                  loading={followUpLoading}
                                  onClick={() => handleSendFollowUp(true, followUpError.question)}
                                >
                                  使用内置规则兜底回答
                                </Button>
                                <Button
                                  size="middle"
                                  loading={followUpLoading}
                                  onClick={() => handleSendFollowUp(false, followUpError.question)}
                                >
                                  重试
                                </Button>
                              </Space>
                            }
                          />
                        )}

                        <Space.Compact size="middle" style={{ width: '100%' }}>
                          <Input
                            size="middle"
                            value={followUpInput}
                            onChange={(e) => setFollowUpInput(e.target.value)}
                            onPressEnter={() => handleSendFollowUp(false)}
                            placeholder="继续追问，例如：给出具体修复代码 / 这会影响哪些业务表？"
                            disabled={loading || followUpLoading}
                          />
                          <Button
                            size="middle"
                            type="primary"
                            icon={<SendOutlined />}
                            loading={followUpLoading}
                            onClick={() => handleSendFollowUp(false)}
                          >
                            发送追问
                          </Button>
                        </Space.Compact>
                      </Card>
                    </div>
                  ) : (
                    <div
                      style={{
                        textAlign: 'center',
                        padding: '48px 24px',
                        color: token.colorTextSecondary,
                        border: `1px dashed ${token.colorBorder}`,
                        borderRadius: token.borderRadiusLG,
                        backgroundColor: token.colorFillAlter,
                      }}
                    >
                      <RobotOutlined style={{ fontSize: 42, color: token.colorPrimary, marginBottom: 16 }} />
                      <div style={{ fontSize: 14, fontWeight: 600, color: token.colorText, marginBottom: 6 }}>
                        准备就绪，等待诊断
                      </div>
                      <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 16 }}>
                        支持 SSE 实时流式输出与多轮追问，已默认开启敏感信息脱敏
                      </div>
                      <Button
                        type="primary"
                        icon={<ThunderboltOutlined />}
                        size="middle"
                        onClick={() => handleAnalyze(false)}
                      >
                        ⚡ 立即开始 AI 诊断
                      </Button>
                    </div>
                  )}
                </Spin>
              </div>
            ),
          },
          {
            key: 'history',
            label: (
              <Space>
                <HistoryOutlined />
                <span>AI 诊断历史记录</span>
                {historyTotal > 0 && <Badge count={historyTotal} style={{ backgroundColor: '#722ed1' }} />}
              </Space>
            ),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space>
                    <span style={{ fontSize: 13, color: token.colorTextSecondary }}>
                      共保存了 <strong>{historyTotal}</strong> 条 AI 诊断分析记录
                    </span>
                  </Space>
                  <Space size={6}>
                    <Button size="middle" icon={<ReloadOutlined />} onClick={fetchHistory} loading={historyLoading}>
                      刷新
                    </Button>
                    {historyRecords.length > 0 && (
                      <Popconfirm
                        title="确定清空所有 AI 诊断历史记录？"
                        description="清空后将无法找回历史分析记录，确定继续？"
                        onConfirm={handleClearHistory}
                        okText="确定清空"
                        cancelText="取消"
                      >
                        <Button size="middle" danger icon={<ClearOutlined />}>
                          清空全部记录
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                </div>

                {viewingRecord ? (
                  <Card
                    size="small"
                    style={{
                      backgroundColor: token.colorBgContainer,
                      borderLeft: `4px solid ${token.colorPrimary}`,
                      boxShadow: token.boxShadowSecondary,
                    }}
                    title={
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                        <Space wrap>
                          <RobotOutlined style={{ color: token.colorPrimary }} />
                          <strong>历史诊断详情: {viewingRecord.analyzerName}</strong>
                          <AIEngineBadge
                            llmService={viewingRecord.llmService}
                            model={viewingRecord.model}
                            analyzerName={viewingRecord.analyzerName}
                          />
                        </Space>
                        <Space size={6}>
                          <Button size="middle" icon={<CopyOutlined />} onClick={() => handleCopyReport(viewingRecord.analysisReport)}>
                            复制报告
                          </Button>
                          <Button
                            size="middle"
                            type="primary"
                            style={{ backgroundColor: '#722ed1', borderColor: '#722ed1' }}
                            icon={<MessageOutlined />}
                            onClick={() => handleLoadHistoryToAnalyze(viewingRecord)}
                          >
                            载入并继续追问
                          </Button>
                          <Popconfirm
                            title="确定删除此条诊断记录？"
                            onConfirm={(e: any) => handleDeleteRecord(viewingRecord.id, e)}
                            okText="删除"
                            cancelText="取消"
                          >
                            <Button size="middle" danger icon={<DeleteOutlined />}>
                              删除此条
                            </Button>
                          </Popconfirm>
                          <Button size="middle" onClick={() => setViewingRecord(null)}>
                            返回列表
                          </Button>
                        </Space>
                      </div>
                    }
                  >
                    <div style={{ marginBottom: 12, padding: '8px 12px', backgroundColor: token.colorFillAlter, borderRadius: token.borderRadius, fontSize: 12 }}>
                      <Space size="middle" wrap>
                        <span><ClockCircleOutlined /> <strong>诊断时间:</strong> {new Date(viewingRecord.createdAt).toLocaleString()}</span>
                        <span>⏱️ <strong>耗时:</strong> {viewingRecord.durationMs} ms</span>
                        <AIEngineBadge
                          llmService={viewingRecord.llmService}
                          model={viewingRecord.model}
                          analyzerName={viewingRecord.analyzerName}
                        />
                      </Space>
                    </div>

                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: token.colorTextSecondary, marginBottom: 4 }}>
                        📄 原始错误日志片段:
                      </div>
                      <pre
                        style={{
                          backgroundColor: '#141414',
                          color: '#ff7875',
                          padding: 8,
                          borderRadius: 4,
                          fontSize: 11,
                          maxHeight: 120,
                          overflowY: 'auto',
                          margin: 0,
                        }}
                      >
                        {viewingRecord.logText}
                      </pre>
                    </div>

                    <Divider style={{ margin: '12px 0' }} />

                    <div>
                      <AIThinkingPanel
                        reasoning={
                          Array.isArray(viewingRecord.messages)
                            ? viewingRecord.messages.find((m: any) => m.role === 'assistant' && m.reasoningContent)?.reasoningContent
                            : undefined
                        }
                        hasContent={Boolean(viewingRecord.analysisReport)}
                      />
                      <MarkdownRenderer content={viewingRecord.analysisReport} />
                    </div>

                    {Array.isArray(viewingRecord.messages) && viewingRecord.messages.length > 2 && (
                      <>
                        <Divider style={{ margin: '12px 0' }} />
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: token.colorPrimaryText }}>
                          💬 历史追问对话 ({Math.floor((viewingRecord.messages.length - 2) / 2)} 轮)
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {viewingRecord.messages.slice(2).map((m: any, idx: number) => (
                            <div
                              key={idx}
                              style={{
                                padding: '8px 12px',
                                borderRadius: token.borderRadius,
                                backgroundColor: m.role === 'user' ? token.colorFillAlter : token.colorBgContainer,
                                border: `1px solid ${m.role === 'user' ? token.colorBorderSecondary : token.colorPrimaryBorder}`,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, fontWeight: 600, marginBottom: 4, color: token.colorTextSecondary }}>
                                <span>{m.role === 'user' ? '用户追问' : 'AI 回复'}</span>
                                {m.role !== 'user' && (
                                  <AIEngineBadge
                                    engine={m.engine}
                                    llmService={m.llmService || viewingRecord.llmService}
                                    model={m.model || viewingRecord.model}
                                    analyzerName={viewingRecord.analyzerName}
                                  />
                                )}
                              </div>
                              {m.role === 'user' ? (
                                <div style={{ color: token.colorText }}>{m.content}</div>
                              ) : (
                                <MarkdownRenderer content={m.content} />
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </Card>
                ) : (
                  <Spin spinning={historyLoading}>
                    {historyRecords.length === 0 ? (
                      <Empty description="暂无 AI 诊断历史记录，去开始一次诊断吧！" style={{ padding: 48 }} />
                    ) : (
                      <List
                        dataSource={historyRecords}
                        renderItem={(rec) => (
                          <List.Item
                            key={rec.id}
                            style={{
                              padding: '12px 16px',
                              marginBottom: 10,
                              backgroundColor: token.colorBgContainer,
                              border: `1px solid ${token.colorBorderSecondary}`,
                              borderRadius: token.borderRadiusLG,
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                            }}
                            onClick={() => handleViewRecord(rec)}
                            actions={[
                              <Button
                                size="middle"
                                type="link"
                                icon={<EyeOutlined />}
                                onClick={() => handleViewRecord(rec)}
                              >
                                查看报告
                              </Button>,
                              <Popconfirm
                                title="确定删除此条诊断记录？"
                                onConfirm={(e: any) => handleDeleteRecord(rec.id, e)}
                                okText="删除"
                                cancelText="取消"
                              >
                                <Button
                                  size="middle"
                                  type="text"
                                  danger
                                  icon={<DeleteOutlined />}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  删除
                                </Button>
                              </Popconfirm>,
                            ]}
                          >
                            <List.Item.Meta
                              avatar={<RobotOutlined style={{ fontSize: 24, color: token.colorPrimary, marginTop: 4 }} />}
                              title={
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <span style={{ fontWeight: 600, color: token.colorText }}>{rec.analyzerName}</span>
                                  <AIEngineBadge
                                    llmService={rec.llmService}
                                    model={rec.model}
                                    analyzerName={rec.analyzerName}
                                  />
                                  {rec.recordType === 'health_inspection' && <Tag color="purple">健康巡检</Tag>}
                                  <Tag color="cyan">⏱️ {rec.durationMs || 0}ms</Tag>
                                  <span style={{ fontSize: 11, color: token.colorTextTertiary, marginLeft: 'auto' }}>
                                    <ClockCircleOutlined /> {new Date(rec.createdAt).toLocaleString()}
                                  </span>
                                </div>
                              }
                              description={
                                <div style={{ marginTop: 4 }}>
                                  <code
                                    style={{
                                      backgroundColor: token.colorFillSecondary,
                                      color: token.colorText,
                                      border: `1px solid ${token.colorBorderSecondary}`,
                                      padding: '2px 6px',
                                      borderRadius: token.borderRadiusSM,
                                      fontSize: 11,
                                      display: 'inline-block',
                                      maxWidth: '100%',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {rec.logSummary || rec.logText?.slice(0, 100) || '系统错误诊断'}
                                  </code>
                                </div>
                              }
                            />
                          </List.Item>
                        )}
                      />
                    )}
                  </Spin>
                )}
              </div>
            ),
          },
        ]}
      />

      {/* 脱敏与压缩预览弹窗 */}
      <Modal
        title="🔒 发送给大模型前的脱敏与智能压缩预览"
        open={previewVisible}
        onCancel={() => setPreviewVisible(false)}
        footer={[
          <Button key="close" size="middle" onClick={() => setPreviewVisible(false)}>
            关闭
          </Button>,
        ]}
        width={760}
      >
        <Spin spinning={previewLoading}>
          {previewData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Space wrap>
                <Tag color={previewData.maskedCount > 0 ? 'green' : 'default'}>
                  脱敏命中: {previewData.maskedCount || 0} 处
                </Tag>
                {(previewData.maskedTypes || []).map((t: string) => (
                  <Tag key={t} color="purple">{t}</Tag>
                ))}
                {previewData.compressedStats && (
                  <Tag color="blue">
                    压缩前后: {previewData.compressedStats.originalLength} → {previewData.compressedStats.compressedLength} 字符
                    (去重 {previewData.compressedStats.deduplicatedLines} 行)
                  </Tag>
                )}
              </Space>
              <pre
                style={{
                  backgroundColor: '#141414',
                  color: '#d9f7be',
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 12,
                  maxHeight: 420,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  margin: 0,
                }}
              >
                {previewData.processedText}
              </pre>
            </div>
          )}
        </Spin>
      </Modal>
    </Drawer>
  );
};
