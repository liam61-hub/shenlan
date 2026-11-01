/**
 * 助手消息统一缩进。
 *
 * 保留原有正文起始列与安全宽度，但不绘制左侧竖线；这样多行正文、表格和
 * 流式行保持统一缩进，同时避免每行被竖线包围。
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
  // 2 列左缩进 + frameWidth = termWidth - 1；2 列 padding 保持正文起始列，
  // 最后一列留空，防止满宽输出触发终端物理换行并让 Ink 行计数错位。
  const frameWidth = Math.max(3, Math.floor(termWidth) - 3);
  return (
    <Box
      flexDirection="column"
      flexShrink={1}
      marginLeft={2}
      width={frameWidth}
      paddingLeft={2}
    >
      {children}
    </Box>
  );
}
