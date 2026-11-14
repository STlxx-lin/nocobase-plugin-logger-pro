import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Card,
  Select,
  Input,
  Button,
  Space,
  Tag,
  Switch,
  message,
  Modal,
  Tooltip,
  Dropdown,
  theme,
} from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  ClearOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SearchOutlined,
  VerticalAlignBottomOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  ExportOutlined,
  FileTextOutlined,
  FileDoneOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import { useLoggerProAPI } from '../context/LoggerProContext';
import { LogFileManagerModal } from './LogFileManagerModal';
import { AILogAnalysisDrawer } from './AILogAnalysisDrawer';

// 统一标准分类配置，对齐后端 LogReaderService.detectCategory
export const LOG_CATEGORY_CONFIG: Record<
  string,
  { label: string; color: string; icon: string; order: number }
> = {
  System: { label: '系统运行', color: 'blue', icon: '⚙️', order: 1 },
  Request: { label: 'API请求', color: 'green', icon: '🌐', order: 2 },
  SQL: { label: 'SQL查询', color: 'purple', icon: '🗄️', order: 3 },
  Workflow: { label: '工作流', color: 'orange', icon: '⚡', order: 4 },
  Notification: { label: '通知管理', color: 'magenta', icon: '🔔', order: 5 },
  Error: { label: '系统异常', color: 'red', icon: '🚨', order: 6 },
  Export: { label: '数据导出', color: 'gold', icon: '📦', order: 7 },
  Sync: { label: '用户同步', color: 'cyan', icon: '🔄', order: 8 },
  Custom: { label: '插件/业务', color: 'default', icon: '🧩', order: 9 },
};

// 容错获取分类标识符
export const getFileCategory = (file: any): string => {
  if (file && typeof file === 'object' && file.category && LOG_CATEGORY_CONFIG[file.category]) {
    return file.category;
  }
  const filePath = (typeof file === 'string' ? file : file?.relativePath || file?.name || '').toLowerCase();
  if (filePath.includes('system_error')) return 'Error';
  if (filePath.startsWith('system') || filePath.includes('/system.')) return 'System';
  if (filePath.includes('workflow')) return 'Workflow';
  if (filePath.includes('notification')) return 'Notification';
  if (filePath.includes('sql')) return 'SQL';
  if (filePath.includes('custom-request') || filePath.includes('request') || filePath.includes('api/')) return 'Request';
  if (filePath.includes('export')) return 'Export';
  if (filePath.includes('user-data-sync') || filePath.includes('sync')) return 'Sync';
  return 'Custom';
};

export const getLogCategoryMeta = (file: any) => {
  const cat = getFileCategory(file);
  const cfg = LOG_CATEGORY_CONFIG[cat] || { label: '插件/业务', color: 'default', icon: '🧩', order: 9 };
  return {
    key: cat,
    text: cfg.label,
    color: cfg.color,
    icon: cfg.icon,
  };
};

// 提取文件所属日期 (YYYY-MM-DD)
const extractFileDate = (file: any): string => {
  const filePath = file?.relativePath || file?.name || '';
  const match = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  if (file?.mtime) {
    const d = new Date(file.mtime);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return '';
};

export const LogConsoleTab: React.FC = () => {
  const { token } = theme.useToken();
  const api = useLoggerProAPI();
  const [files, setFiles] = useState<any[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [lines, setLines] = useState<string[]>([]);
  const [totalMatched, setTotalMatched] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [fileManagerVisible, setFileManagerVisible] = useState(false);

  // 1. 生成按时间倒序的时间序列列表（有日志可点，无日志置灰禁用）
  const dateOptions = useMemo(() => {
    const dateCounts: Record<string, number> = {};
    for (const f of files) {
      const d = extractFileDate(f);
      if (d) {
        dateCounts[d] = (dateCounts[d] || 0) + 1;
      }
    }

    const today = new Date();
    const list: Array<{ dateStr: string; label: string; count: number; hasLogs: boolean }> = [];

    // 获取最早的日志日期，以生成完整时间序列
    const allLogDates = Object.keys(dateCounts).sort();
    const earliestTime = allLogDates.length > 0 ? new Date(allLogDates[0]).getTime() : today.getTime();
    const totalDays = Math.max(10, Math.ceil((today.getTime() - earliestTime) / (1000 * 3600 * 24)) + 1);

    for (let i = 0; i <= totalDays; i++) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;

      const count = dateCounts[dateStr] || 0;
      const hasLogs = count > 0;

      let desc = '';
      if (i === 0) desc = ' (今天)';
      else if (i === 1) desc = ' (昨天)';
      else if (i === 2) desc = ' (前天)';

      list.push({
        dateStr,
        label: `${dateStr}${desc}`,
        count,
        hasLogs,
      });
    }

    return list;
  }, [files]);

  // 日志通道分类选择器状态 (Feature 16)
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

  // 统计各分类通道下的文件数
  const categoryOptions = useMemo(() => {
    const counts: Record<string, number> = { ALL: files.length };
    for (const f of files) {
      const cat = getFileCategory(f);
      counts[cat] = (counts[cat] || 0) + 1;
    }

    const list = [
      {
        value: 'ALL',
        label: '全部通道',
        count: files.length,
      },
      ...Object.entries(LOG_CATEGORY_CONFIG)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([key, cfg]) => ({
          value: key,
          label: cfg.label,
          count: counts[key] || 0,
        })),
    ];
    return list;
  }, [files]);

  // 根据选中的日期与分类双重联动筛选日志文件
  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      const matchDate = !selectedDate || extractFileDate(f) === selectedDate;
      const fileCat = getFileCategory(f);
      const matchCat = selectedCategory === 'ALL' || fileCat === selectedCategory;
      return matchDate && matchCat;
    });
  }, [files, selectedDate, selectedCategory]);

  // 分类切换联动校正
  const handleCategoryChange = (cat: string) => {
    setSelectedCategory(cat);
    setIsTailing(false);

    const nextFiles = files.filter((f) => {
      const matchDate = !selectedDate || extractFileDate(f) === selectedDate;
      const fileCat = getFileCategory(f);
      const matchCat = cat === 'ALL' || fileCat === cat;
      return matchDate && matchCat;
    });

    const isCurrentFileValid = nextFiles.some((f) => (f.relativePath || f.name) === selectedFile);
    if (!isCurrentFileValid) {
      if (nextFiles.length > 0) {
        const defaultF = nextFiles.find((f: any) => (f.relativePath || f.name).startsWith('system.') || (f.relativePath || f.name).includes('/system.')) || nextFiles[0];
        setSelectedFile(defaultF.relativePath || defaultF.name);
      } else {
        setSelectedFile('');
        setLines([]);
      }
    }
  };

  // 过滤条件
  const [level, setLevel] = useState<string>('ALL');
  const [keyword, setKeyword] = useState<string>('');
  const [lineCount, setLineCount] = useState<number>(500);

  // AI 错误诊断
  const [aiDrawerVisible, setAiDrawerVisible] = useState<boolean>(false);
  const [aiLogText, setAiLogText] = useState<string>('');
  const [aiContext, setAiContext] = useState<any>(undefined);

  // 智能错误聚类视图开关
  const [clusterMode, setClusterMode] = useState<boolean>(false);
  const [clusters, setClusters] = useState<any[]>([]);
  const [clusterLoading, setClusterLoading] = useState<boolean>(false);

  const fetchClusters = async (file = selectedFile) => {
    setClusterLoading(true);
    try {
      const res = await api.request({
        url: 'loggerPro:clusterErrorLogs',
        method: 'post',
        data: {
          fileName: file || undefined,
          lines: 1000,
          logLines: !file && lines.length > 0 ? lines : undefined,
        },
      });
      const data = res?.data?.data || res?.data;
      setClusters(Array.isArray(data?.clusters) ? data.clusters : []);
    } catch (err: any) {
      message.error(`错误聚类失败: ${err.message}`);
    } finally {
      setClusterLoading(false);
    }
  };

  const handleToggleClusterMode = (checked: boolean) => {
    setClusterMode(checked);
    if (checked) {
      setIsTailing(false);
      fetchClusters(selectedFile);
    }
  };

  const handleOpenAIDiagnosis = (specificText?: string, extraCtx?: any) => {
    setAiContext(extraCtx);
    if (typeof specificText === 'string' && specificText.trim()) {
      setAiLogText(specificText.trim());
      setAiDrawerVisible(true);
      return;
    }

    // 自动收集当前视图中的错误日志行
    const errorLines = lines.filter((l) => /\[error\]|Error:|stack=/i.test(l));
    if (errorLines.length > 0) {
      setAiLogText(errorLines.slice(-30).join('\n'));
    } else if (lines.length > 0) {
      setAiLogText(lines.slice(-20).join('\n'));
    } else {
      setAiLogText('（暂无日志行，请在上方选择包含报错的日志文件）');
    }
    setAiDrawerVisible(true);
  };

  // 实时 Tail 相关
  const [isTailing, setIsTailing] = useState<boolean>(false);
  const tailTimerRef = useRef<any>(null);
  const consoleBodyRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  // 供轮询定时器读取的最新值（定时器只在开关变化时创建，内部必须走 ref 取最新游标/文件）
  const selectedFileRef = useRef<string>('');
  const tailOffsetRef = useRef<number>(0);
  const autoScrollRef = useRef<boolean>(true);
  const lineCountRef = useRef<number>(500);
  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);
  useEffect(() => {
    lineCountRef.current = lineCount;
  }, [lineCount]);

  // 切换文件时重置游标，避免把上一个文件的 offset 用于新文件
  const resetTailOffset = (offset: number) => {
    tailOffsetRef.current = offset;
  };

  // 1. 获取日志文件列表
  const fetchFiles = async () => {
    try {
      const res = await api.request({ url: 'loggerPro:files' });
      const list = res?.data?.data || res?.data || [];
      setFiles(list);
      if (list.length > 0) {
        const dates = Array.from(new Set(list.map((f: any) => extractFileDate(f)).filter(Boolean))).sort().reverse();
        const latestDate = (dates[0] as string) || null;
        if (!selectedDate && latestDate) {
          setSelectedDate(latestDate);
        }
        if (!selectedFile) {
          const currentList = latestDate ? list.filter((f: any) => extractFileDate(f) === latestDate) : list;
          const defaultF = currentList.find((f: any) => f.name.startsWith('system.')) || currentList[0] || list[0];
          if (defaultF) {
            setSelectedFile(defaultF.relativePath || defaultF.name);
          }
        }
      }
    } catch (err: any) {
      message.error(`获取日志文件列表失败: ${err.message}`);
    }
  };

  // 2. 加载日志内容（静态批量加载）
  const fetchLogContent = async (fileToRead = selectedFile) => {
    if (!fileToRead) return;
    setLoading(true);
    try {
      const res = await api.request({
        url: 'loggerPro:readLines',
        params: {
          fileName: fileToRead,
          lines: lineCount,
          level: level !== 'ALL' ? level : undefined,
          keyword: keyword.trim() || undefined,
        },
      });
      const data = res?.data?.data || res?.data || {};
      const newLines = data.lines || [];
      setLines(newLines);
      setTotalMatched(data.totalMatched || newLines.length);
      resetTailOffset(data.totalSize || 0);

      if (autoScroll && consoleBodyRef.current) {
        setTimeout(() => {
          if (consoleBodyRef.current) {
            consoleBodyRef.current.scrollTop = consoleBodyRef.current.scrollHeight;
          }
        }, 100);
      }
    } catch (err: any) {
      message.error(`读取日志失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 3. 增量 Tail 拉取（通过 ref 读取最新游标，避免定时器闭包读到过期 offset 造成重复拉取）
  const fetchingTailRef = useRef<boolean>(false);
  const fetchTail = async () => {
    if (!selectedFile || fetchingTailRef.current) return;
    fetchingTailRef.current = true;
    try {
      const res = await api.request({
        url: 'loggerPro:tail',
        params: {
          fileName: selectedFileRef.current,
          offsetBytes: tailOffsetRef.current,
        },
      });
      const data = res?.data?.data || res?.data || {};
      const newLines = data.lines || [];

      if (newLines.length > 0) {
        setLines((prev) => {
          const combined = [...prev, ...newLines];
          return combined.slice(-Math.max(lineCountRef.current, 100) * 2); // 保持窗口
        });
      }
      // 无论是否有新增行都推进游标（文件被轮转/清空时后端会重置游标）
      if (typeof data.newOffset === 'number') {
        resetTailOffset(data.newOffset);
      }

      if (newLines.length > 0 && autoScrollRef.current && consoleBodyRef.current) {
        consoleBodyRef.current.scrollTop = consoleBodyRef.current.scrollHeight;
      }
    } catch (err: any) {
      // tail 错误不弹打扰提示，静默记录
    } finally {
      fetchingTailRef.current = false;
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  useEffect(() => {
    if (selectedFile) {
      fetchLogContent(selectedFile);
      if (clusterMode) {
        fetchClusters(selectedFile);
      }
    }
  }, [selectedFile, level, lineCount]);

  // 管理 Tail 轮询定时器：仅依赖开关，切换文件/滚动时不断开重连
  useEffect(() => {
    if (!isTailing) {
      return;
    }
    tailTimerRef.current = setInterval(() => {
      fetchTail();
    }, 1500);
    return () => {
      if (tailTimerRef.current) {
        clearInterval(tailTimerRef.current);
        tailTimerRef.current = null;
      }
    };
  }, [isTailing]);

  // 清空当前文件
  const handleClearFile = async () => {
    if (!selectedFile) return;
    try {
      await api.request({
        url: 'loggerPro:clearFile',
        method: 'post',
        data: { fileName: selectedFile },
      });
      message.success(`日志文件 ${selectedFile} 已清空`);
      setLines([]);
      resetTailOffset(0);
      fetchFiles();
    } catch (err: any) {
      message.error(`清空失败: ${err.message}`);
    }
  };

  // 删除当前文件
  const handleDeleteFile = async () => {
    if (!selectedFile) return;
    try {
      await api.request({
        url: 'loggerPro:deleteFile',
        method: 'post',
        data: { fileName: selectedFile },
      });
      message.success(`日志文件 ${selectedFile} 已删除`);
      setLines([]);
      setSelectedFile('');
      fetchFiles();
    } catch (err: any) {
      message.error(`删除失败: ${err.message}`);
    }
  };

  // 单文件下载
  const handleDownload = async () => {
    if (!selectedFile) return;
    try {
      const res = await api.request({
        url: 'loggerPro:download',
        method: 'post',
        data: { files: [selectedFile] },
        responseType: 'blob',
      });
      const blob = new Blob([res.data], { type: 'application/gzip' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = selectedFile.replace(/[\\/]/g, '_');
      a.download = `${baseName}.tar.gz`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      message.error(`下载日志文件失败: ${err.message || '请求异常'}`);
    }
  };

  // 纯客户端导出当前视图 (Feature 17)
  const handleExportCurrentView = (format: 'txt' | 'json') => {
    if (!lines || lines.length === 0) {
      message.warning('当前视图无日志内容可导出');
      return;
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const catMeta = getLogCategoryMeta(selectedFile);
    const cleanFileName = (selectedFile || 'console').replace(/[/\\?%*:|"<>]/g, '_');
    const downloadFileName = `console-view-${catMeta.text}-${cleanFileName}-${timestamp}.${format}`;

    // 清洗 ANSI 控制字符
    const cleanAnsiLines = lines.map((l) =>
      l ? l.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\[[0-9]{1,2}m/g, '') : ''
    );

    let blob: Blob;

    if (format === 'json') {
      const jsonData = {
        exportedAt: now.toISOString(),
        source: {
          file: selectedFile || null,
          category: catMeta.text,
          categoryKey: catMeta.key,
          level: level !== 'ALL' ? level : 'ALL',
          keyword: keyword.trim() || null,
          totalExportedLines: lines.length,
          totalMatchedInFile: totalMatched,
        },
        lines: cleanAnsiLines,
      };
      blob = new Blob([JSON.stringify(jsonData, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
    } else {
      const header = [
        '# ==============================================================================#',
        '# NocoBase Logger Pro - Console View Export',
        `# Exported At: ${now.toLocaleString()}`,
        `# Source File: ${selectedFile || 'None'}`,
        `# Category:    ${catMeta.text} (${catMeta.key})`,
        `# Level:       ${level}`,
        `# Keyword:     ${keyword.trim() || 'None'}`,
        `# Total Lines: ${lines.length} (Matched in file: ${totalMatched})`,
        '# ==============================================================================#',
        '',
      ].join('\r\n');

      const textContent = header + cleanAnsiLines.join('\r\n');
      blob = new Blob([textContent], {
        type: 'text/plain;charset=utf-8',
      });
    }

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    message.success(`已成功导出当前视图 (${lines.length} 行) 为 ${format.toUpperCase()} 文件`);
  };

  // 日志行语法着色高亮渲染
  const renderLogLine = (rawLine: string, index: number) => {
    const line = rawLine ? rawLine.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\[[0-9]{1,2}m/g, '') : '';
    let color = '#d4d4d4';
    let lineBg = 'transparent';

    const lineUpper = line.toUpperCase();
    if (lineUpper.includes('[ERROR]') || lineUpper.includes('"LEVEL":"ERROR"') || lineUpper.includes(' ERROR ')) {
      color = '#ff7875';
      lineBg = 'rgba(255, 77, 79, 0.1)';
    } else if (lineUpper.includes('[WARN]') || lineUpper.includes('"LEVEL":"WARN"') || lineUpper.includes(' WARN ')) {
      color = '#ffd666';
      lineBg = 'rgba(250, 173, 20, 0.08)';
    } else if (lineUpper.includes('[DEBUG]') || lineUpper.includes('"LEVEL":"DEBUG"')) {
      color = '#87e8de';
    } else if (lineUpper.includes('[INFO]') || lineUpper.includes('"LEVEL":"INFO"')) {
      color = '#bae7ff';
    }

    // 关键词高亮
    let contentNode: React.ReactNode = line;
    if (keyword.trim()) {
      const parts = line.split(new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
      contentNode = parts.map((part, i) =>
        part.toLowerCase() === keyword.toLowerCase() ? (
          <span key={i} style={{ background: '#fadb14', color: '#000', fontWeight: 'bold', padding: '0 2px', borderRadius: 2 }}>
            {part}
          </span>
        ) : (
          part
        ),
      );
    }

    return (
      <div
        key={index}
        style={{
          display: 'flex',
          padding: '2px 8px',
          backgroundColor: lineBg,
          lineHeight: '20px',
          fontFamily: 'Consolas, Monaco, "Courier New", monospace',
          fontSize: 13,
          borderBottom: '1px solid #262626',
        }}
      >
        <span style={{ color: '#595959', width: 48, userSelect: 'none', textAlign: 'right', marginRight: 12 }}>
          {index + 1}
        </span>
        <span style={{ color, wordBreak: 'break-all', whiteSpace: 'pre-wrap', flex: 1 }}>{contentNode}</span>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 单行紧凑工具条 */}
      <Card size="small" bordered bodyStyle={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <Space wrap size={8}>
            <Select
              size="middle"
              showSearch
              placeholder="日期"
              filterOption={(input, option) => {
                const val = String(option?.value || '').toLowerCase();
                const label = String(option?.selectedLabel || '').toLowerCase();
                const q = input.toLowerCase().trim();
                return val.includes(q) || label.includes(q);
              }}
              style={{ width: 136 }}
              popupMatchSelectWidth={false}
              dropdownStyle={{ minWidth: 260 }}
              optionLabelProp="selectedLabel"
              value={selectedDate || ''}
              onChange={(val) => {
                const dStr = val || null;
                setSelectedDate(dStr);
                setIsTailing(false);
                const nextFiles = files.filter((f) => {
                  const matchDate = !dStr || extractFileDate(f) === dStr;
                  const fileCat = getFileCategory(f);
                  const matchCat = selectedCategory === 'ALL' || fileCat === selectedCategory;
                  return matchDate && matchCat;
                });
                if (nextFiles.length > 0) {
                  const defaultF =
                    nextFiles.find(
                      (f: any) => (f.relativePath || f.name).startsWith('system.') || (f.relativePath || f.name).includes('/system.'),
                    ) || nextFiles[0];
                  setSelectedFile(defaultF.relativePath || defaultF.name);
                } else {
                  setSelectedFile('');
                  setLines([]);
                }
              }}
              options={[
                {
                  label: (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>全部日期</span>
                      <Tag style={{ margin: 0, fontSize: 11 }}>{files.length}</Tag>
                    </div>
                  ),
                  selectedLabel: '全部日期',
                  value: '',
                },
                ...dateOptions.map((item) => ({
                  label: (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                        opacity: item.hasLogs ? 1 : 0.45,
                      }}
                    >
                      <span style={{ fontWeight: item.hasLogs ? 600 : 'normal' }}>{item.label}</span>
                      {item.hasLogs ? (
                        <Tag color="blue" style={{ fontSize: 11, margin: 0, padding: '0 4px' }}>
                          {item.count}
                        </Tag>
                      ) : (
                        <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>无日志</span>
                      )}
                    </div>
                  ),
                  selectedLabel: item.label,
                  value: item.dateStr,
                  disabled: !item.hasLogs,
                })),
              ]}
            />

            <Select
              size="middle"
              value={selectedCategory}
              onChange={handleCategoryChange}
              style={{ width: 120 }}
              popupMatchSelectWidth={false}
              options={categoryOptions.map((item) => ({
                value: item.value,
                label: (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span>{item.label}</span>
                    <Tag style={{ margin: 0, fontSize: 11 }}>{item.count}</Tag>
                  </div>
                ),
              }))}
            />

            <Select
              size="middle"
              showSearch
              placeholder="选择日志文件"
              filterOption={(input, option) => {
                const val = String(option?.value || '').toLowerCase();
                const q = input.toLowerCase().trim();
                return val.includes(q);
              }}
              style={{ width: 220 }}
              popupMatchSelectWidth={false}
              dropdownStyle={{ minWidth: 440 }}
              optionLabelProp="selectedLabel"
              value={selectedFile}
              onChange={(val) => {
                setSelectedFile(val);
                setIsTailing(false);
              }}
              options={filteredFiles.map((f) => {
                const filePath = f.relativePath || f.name;
                const cat = getLogCategoryMeta(filePath);
                return {
                  label: (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                      <Space style={{ flex: 1, overflow: 'hidden' }}>
                        <Tag color={cat.color} style={{ fontSize: 11, padding: '0 6px', margin: 0 }}>
                          {cat.text}
                        </Tag>
                        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{filePath}</span>
                      </Space>
                      <span style={{ color: token.colorTextSecondary, fontSize: 12, fontFamily: 'monospace', flexShrink: 0 }}>
                        {f.sizeFormatted}
                      </span>
                    </div>
                  ),
                  selectedLabel: filePath,
                  value: filePath,
                };
              })}
            />

            <Select
              size="middle"
              value={level}
              onChange={(v) => setLevel(v)}
              style={{ width: 92 }}
              options={[
                { label: 'ALL', value: 'ALL' },
                { label: 'ERROR', value: 'ERROR' },
                { label: 'WARN', value: 'WARN' },
                { label: 'INFO', value: 'INFO' },
                { label: 'DEBUG', value: 'DEBUG' },
              ]}
            />

            <Input
              size="middle"
              placeholder="关键词 (Enter)"
              prefix={<SearchOutlined style={{ color: token.colorTextPlaceholder }} />}
              style={{ width: 150 }}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onPressEnter={() => fetchLogContent()}
              allowClear
            />
          </Space>

          <Space wrap size={6}>
            <Tooltip title={isTailing ? '暂停实时 Tail 轮询' : '开启实时 Tail'}>
              <Button
                size="middle"
                type={isTailing ? 'primary' : 'default'}
                danger={isTailing}
                icon={isTailing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                onClick={() => setIsTailing(!isTailing)}
              >
                {isTailing ? '暂停' : 'Tail'}
              </Button>
            </Tooltip>

            <Button size="middle" icon={<ReloadOutlined />} onClick={() => fetchLogContent()} loading={loading}>
              刷新
            </Button>

            <Button
              size="middle"
              type={clusterMode ? 'primary' : 'default'}
              icon={<ThunderboltOutlined />}
              onClick={() => handleToggleClusterMode(!clusterMode)}
            >
              {clusterMode ? '终端视图' : '错误聚类'}
            </Button>

            <Button
              size="middle"
              type="primary"
              style={{ backgroundColor: '#722ed1', borderColor: '#722ed1' }}
              icon={<RobotOutlined />}
              onClick={() => handleOpenAIDiagnosis()}
            >
              AI 诊断
            </Button>

            <Button size="middle" icon={<FolderOpenOutlined />} onClick={() => setFileManagerVisible(true)}>
              文件管理
            </Button>

            <Dropdown
              menu={{
                items: [
                  {
                    key: 'lines',
                    label: `显示行数 (当前 ${lineCount} 行)`,
                    children: [100, 500, 1000, 2000].map((cnt) => ({
                      key: `line-${cnt}`,
                      label: `最新 ${cnt} 行${lineCount === cnt ? ' ✓' : ''}`,
                      onClick: () => setLineCount(cnt),
                    })),
                  },
                  { type: 'divider' },
                  {
                    key: 'export-txt',
                    icon: <FileTextOutlined />,
                    label: '导出当前视图 (.txt)',
                    disabled: lines.length === 0,
                    onClick: () => handleExportCurrentView('txt'),
                  },
                  {
                    key: 'export-json',
                    icon: <FileDoneOutlined />,
                    label: '导出当前视图 (.json)',
                    disabled: lines.length === 0,
                    onClick: () => handleExportCurrentView('json'),
                  },
                  {
                    key: 'download',
                    icon: <DownloadOutlined />,
                    label: '下载当前文件 (.tar.gz)',
                    disabled: !selectedFile,
                    onClick: handleDownload,
                  },
                  { type: 'divider' },
                  {
                    key: 'clear',
                    icon: <ClearOutlined />,
                    label: '清空当前文件',
                    disabled: !selectedFile,
                    onClick: () => {
                      Modal.confirm({
                        title: '确定清空当前日志文件？',
                        content: '清空后历史日志内容将归零，不可恢复。',
                        okText: '确认清空',
                        cancelText: '取消',
                        onOk: handleClearFile,
                      });
                    },
                  },
                  {
                    key: 'delete',
                    icon: <DeleteOutlined />,
                    danger: true,
                    label: '删除当前文件',
                    disabled: !selectedFile,
                    onClick: () => {
                      Modal.confirm({
                        title: `确定删除当前日志文件 (${selectedFile})？`,
                        content: '删除后该文件将彻底从磁盘移除。',
                        okText: '确认删除',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: handleDeleteFile,
                      });
                    },
                  },
                ],
              }}
            >
              <Button size="middle" icon={<MoreOutlined />}>
                更多
              </Button>
            </Dropdown>
          </Space>
        </div>
      </Card>

      {/* 终端控制台主体 / 智能错误聚类视图 */}
      {clusterMode ? (
        <Card
          size="small"
          bordered
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Space>
                <ThunderboltOutlined style={{ color: '#722ed1' }} />
                <span>智能错误日志聚类去重 (共 {clusters.length} 个独立异常簇)</span>
              </Space>
              <Button size="middle" icon={<ReloadOutlined />} loading={clusterLoading} onClick={() => fetchClusters(selectedFile)}>
                重新聚类
              </Button>
            </div>
          }
        >
          {clusters.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: token.colorTextSecondary }}>
              {clusterLoading ? '正在扫描并计算错误指纹聚类...' : '当前日志文件最近 1000 行未发现 ERROR/WARN 异常簇'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '64vh', overflowY: 'auto' }}>
              {clusters.map((cluster: any) => (
                <Card
                  key={cluster.fingerprint}
                  size="small"
                  style={{ borderLeft: `4px solid ${cluster.level === 'WARN' ? token.colorWarning : token.colorError}` }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <Space wrap style={{ marginBottom: 6 }}>
                        <Tag color={cluster.level === 'WARN' ? 'warning' : 'error'}>{cluster.level}</Tag>
                        <Tag color="purple">出现 {cluster.count} 次</Tag>
                        <Tag style={{ fontFamily: 'monospace' }}>指纹: {cluster.fingerprint}</Tag>
                        {cluster.lastSeen && (
                          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>最近: {cluster.lastSeen}</span>
                        )}
                      </Space>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: token.colorText }}>
                        {cluster.pattern}
                      </div>
                      <pre
                        style={{
                          backgroundColor: '#141414',
                          color: '#ff7875',
                          padding: 8,
                          borderRadius: 4,
                          fontSize: 11,
                          maxHeight: 96,
                          overflowY: 'auto',
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        }}
                      >
                        {cluster.sample}
                      </pre>
                    </div>
                    <Button
                      type="primary"
                      size="middle"
                      style={{ backgroundColor: '#722ed1', borderColor: '#722ed1' }}
                      icon={<RobotOutlined />}
                      onClick={() =>
                        handleOpenAIDiagnosis(cluster.rawSample || cluster.sample, {
                          actionName: `Cluster(${cluster.fingerprint}, count=${cluster.count})`,
                        })
                      }
                    >
                      AI 诊断此簇
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Card>
      ) : (
      <div
        style={{
          background: '#141414',
          borderRadius: 8,
          border: '1px solid #303030',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          height: '68vh',
        }}
      >
        {/* 控制台顶部 Titlebar */}
        <div
          style={{
            background: '#1f1f1f',
            padding: '8px 16px',
            borderBottom: '1px solid #303030',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 12,
            color: '#a6a6a6',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#ff5f56' }} />
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e' }} />
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#27c93f' }} />
            <span style={{ marginLeft: 8, color: '#e6e6e6', fontWeight: 600 }}>
              Console: {selectedFile || '无选中日志'}
            </span>
            {selectedFile && (
              <Tag color={getLogCategoryMeta(selectedFile).color} style={{ marginLeft: 4 }}>
                {getLogCategoryMeta(selectedFile).text}
              </Tag>
            )}
            {isTailing && (
              <Tag color="success" style={{ marginLeft: 4 }}>
                LIVE STREAMING
              </Tag>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span>匹配行数: <strong style={{ color: '#fff' }}>{lines.length}</strong> / {totalMatched}</span>
            <Space size="small">
              <span>自动滚屏:</span>
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
            </Space>
            <Button
              size="middle"
              type="text"
              icon={<VerticalAlignBottomOutlined style={{ color: '#8c8c8c' }} />}
              onClick={() => {
                if (consoleBodyRef.current) {
                  consoleBodyRef.current.scrollTop = consoleBodyRef.current.scrollHeight;
                }
              }}
            >
              到底部
            </Button>
          </div>
        </div>

        {/* 控制台文本渲染区 */}
        <div
          ref={consoleBodyRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'auto',
            padding: '8px 0',
            backgroundColor: '#0d1117',
          }}
        >
          {lines.length > 0 ? (
            lines.map((line, idx) => renderLogLine(line, idx))
          ) : (
            <div style={{ padding: 40, textAlign: 'center', color: '#595959', fontSize: 14 }}>
              {loading ? '正在读取日志数据...' : '日志文件为空或未匹配到符合条件的日志行'}
            </div>
          )}
        </div>
      </div>
      )}

      {/* 日志文件清理与管理模态框 */}
      <LogFileManagerModal
        visible={fileManagerVisible}
        onClose={() => setFileManagerVisible(false)}
        onFilesChanged={() => {
          fetchFiles();
          if (selectedFile) {
            fetchLogContent(selectedFile);
          }
        }}
      />

      {/* AI 错误日志诊断抽屉 */}
      <AILogAnalysisDrawer
        visible={aiDrawerVisible}
        initialLogText={aiLogText}
        context={aiContext}
        onClose={() => setAiDrawerVisible(false)}
      />
    </div>
  );
};
