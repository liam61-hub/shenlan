/**
 * 工具状态行 — spinner + 英文工具名 + 结果
 */
import { Text, Box, useAnimation } from 'ink';
import { Spinner } from './Spinner.js';
import type { ToolStatus } from '../context.js';

interface ToolStatusItemProps {
  status: ToolStatus;
}

export function ToolStatusItem({ status }: ToolStatusItemProps) {
  // Force periodic re-render for live elapsed time (~100ms ticks)
  useAnimation();

  const elapsed = status.state === 'running'
    ? `${((Date.now() - status.startTime) / 1000).toFixed(1)}s`
    : status.endTime
      ? `${((status.endTime - status.startTime) / 1000).toFixed(1)}s`
      : null;

  return (
    <Box>
      <Text>  </Text>
      {status.state === 'running' ? (
        <Spinner />
      ) : status.state === 'done' ? (
        <Text color="green">✔</Text>
      ) : (
        <Text color="red">✖</Text>
      )}
      <Text> </Text>
      <Text bold>{status.name}</Text>
      {status.detail ? (
        <Text dimColor> {status.detail}</Text>
      ) : null}
      {elapsed ? (
        <Text dimColor> ({elapsed})</Text>
      ) : null}
    </Box>
  );
}
