import React, { useEffect, useRef, useState } from 'react';
import { Button, Collapse, Space, Tag, theme, Typography } from 'antd';
import {
  ApiOutlined,
  BulbOutlined,
  CheckOutlined,
  CopyOutlined,
  ExperimentOutlined,
  LoadingOutlined,
  SyncOutlined,
} from '@ant-design/icons';

export interface AIEngineBadgeProps {
  streaming?: boolean;
  engine?: 'llm' | 'heuristic' | string;
  llmService?: string;
  model?: string;
  analyzerName?: string;
}

export const AIEngineBadge: React.FC<AIEngineBadgeProps> = ({
  streaming,
  engine,
  llmService,
  model,
  analyzerName,
}) => {
  if (streaming) {
    return (
      <Tag color="processing" icon={<SyncOutlined spin />} style={{ margin: 0 }}>
        流式生成中...
      </Tag>
    );
  }

  const isHeuristic =
    engine === 'heuristic' ||
    llmService === 'builtin' ||
    model === 'heuristic' ||
    (!llmService && analyzerName?.includes('内置'));

  if (isHeuristic) {
    return (
      <Tag color="warning" icon={<ExperimentOutlined />} style={{ margin: 0 }}>
        非真实 AI · 启发式兜底
      </Tag>
    );
  }

  const serviceLabel = llmService || 'LLM';
  const modelLabel = model && model !== 'default' ? ` / ${model}` : '';
  return (
    <Tag color="purple" icon={<ApiOutlined />} style={{ margin: 0 }}>
      真实 AI · {serviceLabel}
      {modelLabel}
    </Tag>
  );
};

interface CodeBlockProps {
  language?: string;
  code: string;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
  const { token } = theme.useToken();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div
      style={{
        margin: '10px 0',
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${token.colorBorderSecondary}`,
        backgroundColor: token.colorFillAlter,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 12px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          backgroundColor: token.colorFillQuaternary,
          fontSize: 12,
          color: token.colorTextSecondary,
        }}
      >
        <span style={{ fontFamily: 'monospace', textTransform: 'lowercase' }}>
          {language || 'text'}
        </span>
        <Button
          type="text"
          size="middle"
          icon={copied ? <CheckOutlined style={{ color: token.colorSuccess }} /> : <CopyOutlined />}
          onClick={handleCopy}
          style={{ fontSize: 12, color: copied ? token.colorSuccess : token.colorTextSecondary, height: 22, padding: '0 6px' }}
        >
          {copied ? '已复制' : '复制代码'}
        </Button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          overflowX: 'auto',
          fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
          fontSize: 12.5,
          lineHeight: '20px',
          color: token.colorText,
          backgroundColor: 'transparent',
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
};

function renderInlineNodes(
  text: string,
  token: ReturnType<typeof theme.useToken>['token'],
  keyPrefix: string,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // 匹配行内代码 `...`、粗体 **...**、斜体 *...*、链接 [text](url)
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];
    const k = `${keyPrefix}-${idx++}`;

    if (raw.startsWith('`') && raw.endsWith('`')) {
      nodes.push(
        <code
          key={k}
          style={{
            backgroundColor: token.colorFillSecondary,
            color: token.colorText,
            border: `1px solid ${token.colorBorderSecondary}`,
            padding: '1px 5px',
            borderRadius: token.borderRadiusSM,
            fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
            fontSize: '0.9em',
            wordBreak: 'break-word',
          }}
        >
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      nodes.push(
        <strong key={k} style={{ fontWeight: 600, color: token.colorText }}>
          {renderInlineNodes(raw.slice(2, -2), token, `${k}-b`)}
        </strong>,
      );
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      nodes.push(
        <em key={k} style={{ fontStyle: 'italic' }}>
          {raw.slice(1, -1)}
        </em>,
      );
    } else if (raw.startsWith('[')) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <Typography.Link key={k} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
            {linkMatch[1]}
          </Typography.Link>,
        );
      } else {
        nodes.push(raw);
      }
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export interface AIThinkingPanelProps {
  reasoning?: string;
  streaming?: boolean;
  hasContent?: boolean;
}

export const AIThinkingPanel: React.FC<AIThinkingPanelProps> = ({
  reasoning,
  streaming,
  hasContent,
}) => {
  const { token } = theme.useToken();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isThinking = Boolean(streaming && !hasContent);
  const [activeKeys, setActiveKeys] = useState<string[]>(isThinking ? ['thinking'] : []);

  useEffect(() => {
    if (streaming && reasoning && !hasContent) {
      setActiveKeys(['thinking']);
    }
  }, [streaming, reasoning, hasContent]);

  useEffect(() => {
    if (scrollRef.current && streaming && reasoning) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reasoning, streaming]);

  if (!reasoning && !isThinking) {
    return null;
  }

  if (!reasoning && isThinking) {
    return (
      <div
        style={{
          marginBottom: 12,
          padding: '10px 14px',
          borderRadius: token.borderRadiusLG,
          backgroundColor: token.colorFillAlter,
          border: `1px dashed ${token.colorPrimaryBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: token.colorTextSecondary,
        }}
      >
        <LoadingOutlined style={{ color: token.colorPrimary }} />
        <span>正在连接大模型并深度推理分析，思考过程与正文将实时流式呈现...</span>
      </div>
    );
  }

  const label = isThinking ? (
    <Space size={6}>
      <SyncOutlined spin style={{ color: token.colorPrimary }} />
      <span style={{ fontWeight: 600, color: token.colorPrimaryText }}>AI 深度思考中...</span>
      <Tag color="processing" style={{ margin: 0 }}>
        {reasoning!.length} 字
      </Tag>
    </Space>
  ) : (
    <Space size={6}>
      <BulbOutlined style={{ color: token.colorWarning }} />
      <span style={{ fontWeight: 600, color: token.colorTextSecondary }}>AI 思考过程</span>
      <Tag style={{ margin: 0 }}>{reasoning!.length} 字</Tag>
    </Space>
  );

  return (
    <Collapse
      size="small"
      activeKey={activeKeys}
      onChange={(keys) => setActiveKeys(Array.isArray(keys) ? keys : [keys])}
      style={{
        marginBottom: 12,
        backgroundColor: token.colorFillAlter,
        borderColor: isThinking ? token.colorPrimaryBorder : token.colorBorderSecondary,
      }}
      items={[
        {
          key: 'thinking',
          label,
          children: (
            <div
              ref={scrollRef}
              style={{
                maxHeight: 240,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: '20px',
                color: token.colorTextSecondary,
                fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
              }}
            >
              {reasoning}
              {isThinking && (
                <span style={{ color: token.colorPrimary, fontWeight: 700, marginLeft: 2 }}>▌</span>
              )}
            </div>
          ),
        },
      ]}
    />
  );
};

export interface MarkdownRendererProps {
  content?: string;
  streaming?: boolean;
  style?: React.CSSProperties;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, streaming, style }) => {
  const { token } = theme.useToken();

  if (!content) return null;

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. 代码块 ```
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i++;
      }
      blocks.push(<CodeBlock key={`code-${i}`} language={lang} code={codeLines.join('\n')} />);
      continue;
    }

    // 2. 空行
    if (!trimmed) {
      i++;
      continue;
    }

    // 3. 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(
        <hr
          key={`hr-${i}`}
          style={{
            border: 'none',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            margin: '12px 0',
          }}
        />,
      );
      i++;
      continue;
    }

    // 4. 标题 # ~ ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const fontSizeMap: Record<number, number> = { 1: 18, 2: 16, 3: 15, 4: 14, 5: 13.5, 6: 13 };
      blocks.push(
        <div
          key={`h-${i}`}
          style={{
            fontSize: fontSizeMap[level] || 14,
            fontWeight: 600,
            color: level <= 3 ? token.colorPrimaryText : token.colorText,
            marginTop: level <= 2 ? 14 : 10,
            marginBottom: 6,
            lineHeight: 1.45,
          }}
        >
          {renderInlineNodes(text, token, `h-${i}`)}
        </div>,
      );
      i++;
      continue;
    }

    // 5. Markdown 表格
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headers = parseTableRow(line);
      const alignments = parseTableRow(lines[i + 1]).map((cell) => {
        if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
        if (cell.endsWith(':')) return 'right';
        return 'left';
      }) as Array<'left' | 'center' | 'right'>;

      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && !lines[i].trim().startsWith('```')) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }

      blocks.push(
        <div
          key={`table-${i}`}
          style={{
            margin: '10px 0',
            overflowX: 'auto',
            borderRadius: token.borderRadius,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12.5,
              color: token.colorText,
            }}
          >
            <thead>
              <tr style={{ backgroundColor: token.colorFillAlter }}>
                {headers.map((h, hIdx) => (
                  <th
                    key={hIdx}
                    style={{
                      padding: '8px 10px',
                      textAlign: alignments[hIdx] || 'left',
                      fontWeight: 600,
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                      borderRight: hIdx < headers.length - 1 ? `1px solid ${token.colorBorderSecondary}` : undefined,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {renderInlineNodes(h, token, `th-${i}-${hIdx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr
                  key={rIdx}
                  style={{
                    backgroundColor: rIdx % 2 === 1 ? token.colorFillQuaternary : token.colorBgContainer,
                  }}
                >
                  {headers.map((_, cIdx) => (
                    <td
                      key={cIdx}
                      style={{
                        padding: '6px 10px',
                        textAlign: alignments[cIdx] || 'left',
                        borderBottom: rIdx < rows.length - 1 ? `1px solid ${token.colorBorderSecondary}` : undefined,
                        borderRight: cIdx < headers.length - 1 ? `1px solid ${token.colorBorderSecondary}` : undefined,
                        verticalAlign: 'top',
                      }}
                    >
                      {renderInlineNodes(r[cIdx] ?? '', token, `td-${i}-${rIdx}-${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 6. 引用块 >
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={`quote-${i}`}
          style={{
            margin: '8px 0',
            padding: '6px 12px',
            borderLeft: `3px solid ${token.colorPrimary}`,
            backgroundColor: token.colorFillAlter,
            borderRadius: `0 ${token.borderRadiusSM}px ${token.borderRadiusSM}px 0`,
            color: token.colorTextSecondary,
          }}
        >
          {quoteLines.map((ql, qIdx) => (
            <div key={qIdx} style={{ marginBottom: qIdx < quoteLines.length - 1 ? 4 : 0 }}>
              {renderInlineNodes(ql, token, `q-${i}-${qIdx}`)}
            </div>
          ))}
        </blockquote>,
      );
      continue;
    }

    // 7. 无序列表
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: Array<{ indent: number; text: string }> = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)[-*•]\s+(.*)$/);
        if (m) {
          items.push({ indent: Math.min(Math.floor(m[1].length / 2), 3), text: m[2] });
        }
        i++;
      }
      blocks.push(
        <ul
          key={`ul-${i}`}
          style={{
            margin: '6px 0',
            paddingLeft: 20,
            color: token.colorText,
          }}
        >
          {items.map((item, itemIdx) => (
            <li
              key={itemIdx}
              style={{
                marginLeft: item.indent * 14,
                marginBottom: 4,
              }}
            >
              {renderInlineNodes(item.text, token, `ul-${i}-${itemIdx}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 8. 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: Array<{ indent: number; text: string }> = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)\d+\.\s+(.*)$/);
        if (m) {
          items.push({ indent: Math.min(Math.floor(m[1].length / 2), 3), text: m[2] });
        }
        i++;
      }
      blocks.push(
        <ol
          key={`ol-${i}`}
          style={{
            margin: '6px 0',
            paddingLeft: 22,
            color: token.colorText,
          }}
        >
          {items.map((item, itemIdx) => (
            <li
              key={itemIdx}
              style={{
                marginLeft: item.indent * 14,
                marginBottom: 4,
              }}
            >
              {renderInlineNodes(item.text, token, `ol-${i}-${itemIdx}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // 9. 普通段落
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('>') &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !(lines[i].trim().includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`p-${i}`} style={{ margin: '6px 0', color: token.colorText }}>
        {paraLines.map((pl, pIdx) => (
          <React.Fragment key={pIdx}>
            {pIdx > 0 && <br />}
            {renderInlineNodes(pl, token, `p-${i}-${pIdx}`)}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return (
    <div
      style={{
        fontSize: 13,
        lineHeight: '22px',
        color: token.colorText,
        wordBreak: 'break-word',
        ...style,
      }}
    >
      {blocks}
      {streaming && (
        <div
          style={{
            marginTop: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: token.colorPrimaryText,
          }}
        >
          <span style={{ fontWeight: 700 }}>▍</span>
          <span>正在实时生成文本...（{content.length} 字）</span>
        </div>
      )}
    </div>
  );
};
