/**
 * 流式行静态项 — 已完成的整行，写入终端回滚区（<Static>），永不重绘。
 *
 * 与完成态 MessageItem 共用行内 markdown 渲染；代码围栏内/围栏标记行用 dim。
 * 围栏状态由 reducer 在冻结行时计算（streamFenceOpen → code）。
 */
import { Text, Box } from 'ink';
import type { ReactNode } from 'react';
import { renderInlineMd } from './MessageItem.js';
import { AssistantFrame } from './AssistantFrame.js';

interface StreamingLineProps {
  text: string;
  code?: boolean;
  termWidth?: number;
}

export function StreamingLine({ text, code, termWidth }: StreamingLineProps) {
  // 空行渲染为空白行（与完成态 MessageItem 的空行一致），不显示孤立的 │
  if (text === '') {
    return <Box height={1} />;
  }
  const isFence = text.trimStart().startsWith('```');
  const dim = Boolean(code) || isFence;
  return (
    <AssistantFrame termWidth={termWidth}>
      {dim ? <Text dimColor>{text}</Text> : renderStreamingLine(text)}
    </AssistantFrame>
  );
}

/**
 * 流式行级 markdown 格式：标题 / 列表 / 任务 / 引用 / 水平线，
 * 与完成态 MessageItem 观感一致；其余走行内渲染。
 */
export function renderStreamingLine(text: string): ReactNode {
  // 标题
  const hMatch = text.match(/^(#{1,6})\s+(.+)/);
  if (hMatch) {
    const level = hMatch[1].length;
    const title = hMatch[2];
    return (
      <Text bold color={level <= 2 ? 'white' : undefined}>
        {level <= 2 ? title : '  ' + title}
      </Text>
    );
  }

  // 水平线
  if (/^(-{3,}|\*{3,})$/.test(text.trim())) {
    return <Text dimColor>{'─'.repeat(Math.min(process.stdout.columns || 80, 80))}</Text>;
  }

  // 无序列表（含任务 ☐/☑）
  const ulMatch = text.match(/^(\s*)[-*]\s+(.+)/);
  if (ulMatch) {
    const taskMatch = ulMatch[2].match(/^\[( |x|X)\]\s+(.+)/);
    if (taskMatch) {
      const mark = taskMatch[1] === ' ' ? '☐' : '☑';
      return (
        <Text>
          {ulMatch[1]}• {mark} {renderInlineMd(taskMatch[2])}
        </Text>
      );
    }
    return (
      <Text>
        {ulMatch[1]}• {renderInlineMd(ulMatch[2])}
      </Text>
    );
  }

  // 有序列表（保留序号）
  const olMatch = text.match(/^(\s*)(\d+)\.\s+(.+)/);
  if (olMatch) {
    return (
      <Text>
        {olMatch[1]}{olMatch[2]}. {renderInlineMd(olMatch[3])}
      </Text>
    );
  }

  // 引用
  const bqMatch = text.match(/^>\s?(.+)/);
  if (bqMatch) {
    return <Text dimColor>│ {bqMatch[1]}</Text>;
  }

  return renderInlineMd(text);
}
