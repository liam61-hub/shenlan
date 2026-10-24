/**
 * 助手消息统一边框。
 *
 * 用 Ink 的左边框而不是单独的 `Text("  │ ")`：内容自动折行后，边框会随
 * 每个视觉行继续绘制，避免第二行丢竖线或从错误列开始。整体始终保留终端
 * 最后一列，防止满宽输出触发终端物理换行并让 Ink 行计数错位。
 */
import type { ReactNode } from 'react';
import { Box } from 'ink';

export interface AssistantFrameProps {
  children: ReactNode;
  termWidth?: number;
}

export function AssistantFrame({
  children,
  termWidth = process.stdout.columns || 80,
}: AssistantFrameProps) {
  // 2 列左缩进 + frameWidth = termWidth - 1；frameWidth 内含 1 列边框
  // 与 1 列 padding，正文可用宽度等价于旧前缀 `  │ ` 后的剩余空间。
  const frameWidth = Math.max(3, Math.floor(termWidth) - 3);
  return (
    <Box
      flexDirection="column"
      flexShrink={1}
      marginLeft={2}
      width={frameWidth}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
    >
      {children}
    </Box>
  );
}
