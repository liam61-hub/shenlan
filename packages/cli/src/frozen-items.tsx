/**
 * 静态项构建 — 进 <Static> 的内容：
 *   1. logo 头部（首条，随内容滚走）
 *   2. 已完成消息（user / assistant / tool / system，复用 MessageItem）
 *   3. 流式已完成的整行（assistant-line，逐条冻结，每行只写一次）
 *
 * history 是 append-only 的渲染列表（提交/工具结果/流式整行按时间顺序追加），
 * 因此 <Static> 的 index 切片只对新项增量写入，已打印内容永不重绘。
 */
import type { ReactNode } from 'react';
import { Text, Box } from 'ink';
import type { AppState } from './context.js';
import { StatusBar } from './components/StatusBar.js';
import { MessageItem } from './components/MessageItem.js';
import { StreamingLine } from './components/StreamingLine.js';
import { CodeBlock } from './components/CodeBlock.js';
import { MathBlock, TableBlock } from './components/Blocks.js';
import { AssistantFrame } from './components/AssistantFrame.js';

export function buildFrozenItems(state: AppState, version: string, termWidth = process.stdout.columns || 80): ReactNode[] {
  const items: ReactNode[] = [
    <StatusBar key="header" version={version} />,
  ];
  for (const item of state.history) {
    if (item.role === 'tool-step' && item.toolStep) {
      const { name, detail, outcome, durationMs } = item.toolStep;
      const elapsed = `${(durationMs / 1000).toFixed(1)}s`;
      items.push(
        <Box key={item.key} flexDirection="row">
          <Text>  </Text>
          <Text color={outcome === 'done' ? 'green' : undefined}>
            {outcome === 'done' ? '✔' : '✖'}
          </Text>
          <Text> </Text>
          <Text bold>{name}</Text>
          {detail ? <Text dimColor> {detail}</Text> : null}
          <Text dimColor> ({elapsed})</Text>
        </Box>,
      );
    } else if (item.role === 'assistant-line') {
      items.push(
        <StreamingLine key={item.key} text={item.content} code={item.code} termWidth={termWidth} />,
      );
    } else if (item.role === 'assistant-block') {
      // 流式整块（表格/公式）：与 assistant 消息同款 │ 前缀，一次写入
      items.push(
        <AssistantFrame key={item.key} termWidth={termWidth}>
          {item.blockKind === 'table'
            ? <TableBlock content={item.content} />
            : item.blockKind === 'code'
              ? <CodeBlock language={item.lang || ''} code={item.content} />
              : <MathBlock content={item.content} />}
        </AssistantFrame>
      );
    } else if (item.role !== 'tool-step' && item.content) {
      items.push(
        <MessageItem
          key={item.key}
          role={item.role}
          content={item.content}
          ts={item.ts}
          toolError={item.toolError}
          fileChange={item.fileChange}
          termWidth={termWidth}
        />,
      );
    } else {
      continue;
    }
  }
  return items;
}
