/**
 * 消息项 — 已完成消息的 markdown 渲染（含代码高亮）
 */

import React from 'react';
import { Text, Box } from 'ink';
import { CodeBlock } from './CodeBlock.js';
import { MathBlock, TableBlock } from './Blocks.js';
import {
  displayWidth,
  isPipeRow,
  isSeparatorRow,
  hasUnclosedBacktick,
  parseInline,
} from '../markdown-utils.js';
import { truncateWidth, TOOL_SUMMARY_MAX_WIDTH } from '../tool-summary.js';
import type { FileChange } from '../file-change.js';
import { FILE_CHANGE_PREVIEW_MAX_WIDTH } from '../file-change.js';
import { AssistantFrame } from './AssistantFrame.js';

interface MessageItemProps {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** 消息创建时间戳（毫秒），用于轮次分隔线 */
  ts?: number;
  /** 工具结果行：是否为错误（红色渲染） */
  toolError?: boolean;
  /** 文件变更卡片（write/edit 成功路径；缺失时按旧单行摘要渲染） */
  fileChange?: FileChange;
  /** 静态消息写入时的终端宽度；用户消息按安全宽度预折行 */
  termWidth?: number;
}

export const MessageItem = React.memo(function MessageItem({
  role,
  content,
  ts,
  toolError,
  fileChange,
  termWidth = process.stdout.columns || 80,
}: MessageItemProps) {
  if (!content) return null;

  const elements = renderMarkdown(content);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {role === 'user' && (
        <Box flexDirection="column">
          {ts ? (
            <Box marginTop={1} marginBottom={1}>
              <Text dimColor>{formatDivider(ts, termWidth)}</Text>
            </Box>
          ) : null}
          <Box flexDirection="column">
            {formatUserBlock(content, termWidth).map((line, i) => (
              <Text key={i}>
                <Text color={i === 0 ? 'cyan' : undefined}>{line.slice(0, 1)}</Text>
                <Text bold>{line.slice(1)}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )}
      {role === 'assistant' && (
        <AssistantFrame termWidth={termWidth}>{elements}</AssistantFrame>
      )}
      {role === 'tool' && fileChange && (
        <FileChangeCard fileChange={fileChange} />
      )}
      {role === 'tool' && !fileChange && (
        <Box flexDirection="row">
          <Text dimColor>  ↳ </Text>
          <Text color={toolError ? 'red' : undefined} dimColor={!toolError}>
            {toolError ? content : compactToolLine(content)}
          </Text>
        </Box>
      )}
      {role === 'system' && (
        <Box flexDirection="column">
          {content.split('\n').filter(l => l.trim() !== '').map((line, i) => (
            <Text key={i} color="yellow">  ℹ {line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
});

/** 文件变更卡片：✏️ Added/Updated <路径> + 预览行（│ 前缀 dim，edit 的 -/+ 行红/绿） */
function FileChangeCard({ fileChange }: { fileChange: FileChange }) {
  const label = fileChange.kind === 'add' ? 'Added' : 'Updated';
  return (
    <Box flexDirection="column">
      <Text bold>
        ✏️ {label} {truncateWidth(fileChange.path, FILE_CHANGE_PREVIEW_MAX_WIDTH)}
      </Text>
      {fileChange.lines.map((line, i) => {
        const isRemoved = line.startsWith('- ');
        const isAdded = line.startsWith('+ ');
        return (
          <Box key={i} flexDirection="row">
            <Text dimColor>  │ </Text>
            <Text color={isRemoved ? 'red' : isAdded ? 'green' : undefined}>
              {truncateWidth(line, FILE_CHANGE_PREVIEW_MAX_WIDTH)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** 轮次分隔线：── MM-DD HH:mm ── */
export function formatDivider(ts: number, termWidth: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  // 宽度取 termWidth - 1：与用户消息反显块同理，满宽行会让终端自动换行，
  // 多出一行幻影 → Ink 行计数错位（Windows/Wave 左移的成因之一）。
  const w = Math.max(1, Math.floor(termWidth) - 1);
  const label = ` ${mm}-${dd} ${hh}:${mi} `;
  if (w <= label.length + 2) return truncateWidth(label.trim(), w);
  const side = Math.max(1, Math.floor((w - label.length) / 2));
  return '─'.repeat(side) + label + '─'.repeat(Math.max(1, w - label.length - side));
}

/** 用户消息：首行青蓝圆点、续行对齐；逻辑行最多 120 字符，再按显示宽度硬换行。 */
export function formatUserBlock(content: string, termWidth: number): string[] {
  const rowWidth = Math.max(1, Math.floor(termWidth) - 1);
  const bodyWidth = Math.max(1, rowWidth - 2);
  const rows: string[] = [];
  let firstVisualLine = true;

  for (const logicalLine of content.split('\n')) {
    const capped = Array.from(logicalLine).slice(0, 120).join('');
    const visualLines = wrapPlainLine(capped, bodyWidth);
    for (const visualLine of visualLines) {
      const prefix = firstVisualLine ? '● ' : '  ';
      rows.push(truncateWidth(`${prefix}${visualLine}`, rowWidth));
      firstVisualLine = false;
    }
  }
  return rows;
}

function wrapPlainLine(text: string, width: number): string[] {
  if (text === '') return [''];
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (current && currentWidth + charWidth > width) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    current += char;
    currentWidth += charWidth;
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

/**
 * 工具行压缩 — 新行已是 formatter 产出的单行摘要（此处为 no-op）；
 * 兼容旧会话：resume 出的多行原始工具输出仍压缩为单行首行，避免一墙输出。
 */
function compactToolLine(content: string): string {
  const firstLine = content.split('\n').find(l => l.trim()) || '';
  return truncateWidth(firstLine, TOOL_SUMMARY_MAX_WIDTH);
}

/**
 * Markdown → React node 数组
 * 支持：标题、加粗、斜体、行内代码、代码块、列表、引用、水平线
 * （流式组件复用同一渲染器）
 */
export function renderMarkdown(md: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = md.split('\n');
  let i = 0;

  // 跟踪是否在代码块内
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  let inCodeBlock = false;

  function flushCodeBlock() {
    if (codeBlockLines.length > 0 || codeBlockLang) {
      nodes.push(
        <CodeBlock
          key={`cb-${nodes.length}`}
          language={codeBlockLang}
          code={codeBlockLines.join('\n')}
        />
      );
      codeBlockLines = [];
      codeBlockLang = '';
    }
  }

  for (i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        codeBlockLang = line.slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // 数学公式块 $$...$$（单行或多行）
    if (line.trim().startsWith('$$')) {
      let j = i;
      let closed = false;
      const first = line.trim();
      if (first === '$$') {
        j = i + 1;
      } else if (first.endsWith('$$') && first.length > 4) {
        closed = true;
        j = i + 1;
      } else {
        j = i + 1;
      }
      while (!closed && j < lines.length) {
        const l = lines[j].trim();
        if (l.endsWith('$$') || l === '$$') closed = true;
        j++;
      }
      nodes.push(<MathBlock key={`math-${i}`} content={lines.slice(i, j).join('\n')} />);
      i = j - 1;
      continue;
    }

    // 表格：管道行 + 下一行分隔行
    if (isPipeRow(line) && isSeparatorRow(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && isPipeRow(lines[j])) j++;
      // 表格在上一行非空时前加 1 空行（适度留白）
      const tableNodes: React.ReactNode[] = [];
      if (i > 0 && lines[i - 1].trim() !== '') {
        tableNodes.push(<Box key={`tblblank-${i}`} height={1} />);
      }
      tableNodes.push(
        <TableBlock key={`tbl-${i}`} content={lines.slice(i, j).join('\n')} />
      );
      nodes.push(...tableNodes);
      i = j - 1;
      continue;
    }

    // 空行
    if (line.trim() === '') {
      nodes.push(<Box key={`empty-${i}`} height={1} />);
      continue;
    }

    // 标题
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const text = hMatch[2];
      // 标题在上一行非空时前加 1 空行（适度留白）
      const headingNodes: React.ReactNode[] = [];
      if (i > 0 && lines[i - 1].trim() !== '') {
        headingNodes.push(<Box key={`hblank-${i}`} height={1} />);
      }
      headingNodes.push(
        <Text key={`h-${i}`} bold color={level <= 2 ? 'white' : undefined}>
          {level <= 2 ? text : '  ' + text}
        </Text>
      );
      nodes.push(...headingNodes);
      continue;
    }

    // 水平线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      const w = process.stdout.columns || 80;
      nodes.push(<Text key={`hr-${i}`} dimColor>{'─'.repeat(Math.min(w, 80))}</Text>);
      continue;
    }

    // 无序列表
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      const taskMatch = ulMatch[2].match(/^\[( |x|X)\]\s+(.+)/);
      if (taskMatch) {
        const mark = taskMatch[1] === ' ' ? '☐' : '☑';
        nodes.push(
          <Text key={`ul-${i}`}>
            {ulMatch[1]}• {mark} {renderInlineMd(taskMatch[2])}
          </Text>
        );
      } else {
        nodes.push(
          <Text key={`ul-${i}`}>
            {ulMatch[1]}• {renderInlineMd(ulMatch[2])}
          </Text>
        );
      }
      continue;
    }

    // 有序列表
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (olMatch) {
      nodes.push(
        <Text key={`ol-${i}`}>
          {olMatch[1]}{olMatch[2]}. {renderInlineMd(olMatch[3])}
        </Text>
      );
      continue;
    }

    // 引用（连续 > 行合并）
    const bqMatch = line.match(/^>\s?(.+)/);
    if (bqMatch) {
      const quoteLines = [bqMatch[1]];
      let j = i + 1;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        quoteLines.push(lines[j].replace(/^>\s?/, ''));
        j++;
      }
      nodes.push(
        <Box key={`bq-${i}`} flexDirection="column">
          {quoteLines.map((q, qi) => (
            <Text key={qi} dimColor>│ {renderInlineMdPlain(q)}</Text>
          ))}
        </Box>
      );
      i = j - 1;
      continue;
    }

    // 普通文本行（含行内格式）：行内代码 span 跨行时合并到闭合为止
    // （parseInline 支持跨行 span，但逐行调用永远配不成对 → 原样显示反引号）
    let text = line;
    while (hasUnclosedBacktick(text) && i + 1 < lines.length) {
      text += '\n' + lines[++i];
    }
    nodes.push(
      <Text key={`p-${i}`}>{renderInlineMd(text)}</Text>
    );
  }

  // 处理未闭合的代码块
  if (inCodeBlock) {
    flushCodeBlock();
  }

  return nodes;
}

/**
 * 行内 markdown 渲染（返回 React node）
 * 供完成态 MessageItem 与流式 StreamingLine 共用。
 */
export function renderInlineMd(text: string): React.ReactNode {
  const parts = parseInline(text);
  if (parts.length === 1 && parts[0].type === 'text') {
    return <Text>{parts[0].text}</Text>;
  }
  return (
    <Text>
      {parts.map((part, i) => {
        switch (part.type) {
          case 'text': return <Text key={i}>{part.text}</Text>;
          case 'bold': return <Text key={i} bold>{part.text}</Text>;
          case 'italic': return <Text key={i} italic>{part.text}</Text>;
          case 'code': return <Text key={i} color="cyan">{part.text}</Text>;
          case 'math': return <Text key={i} color="cyan">{part.text}</Text>;
          case 'link': return <Text key={i} color="blue">{part.text}</Text>;
          case 'strike': return <Text key={i} strikethrough>{part.text}</Text>;
          case 'image': return <Text key={i} dimColor>{part.text}</Text>;
          default: return <Text key={i}>{part.text}</Text>;
        }
      })}
    </Text>
  );
}

/**
 * 行内 markdown 渲染（返回纯字符串，用于引用等 dim 行）
 */
function renderInlineMdPlain(text: string): string {
  return parseInline(text).map(t => t.text).join('');
}
