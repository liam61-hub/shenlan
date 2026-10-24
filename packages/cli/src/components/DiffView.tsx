/**
 * Diff 变更预览 — 绿 + / 红 - ，超出折叠
 */
import { Text, Box } from 'ink';
import type { DiffHunk } from '../context.js';

interface DiffViewProps {
  filePath: string;
  hunks: DiffHunk[];
}

export function DiffView({ filePath, hunks }: DiffViewProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text dimColor>  ── {filePath} ──</Text>
      {hunks.map((hunk, hi) => (
        <Box key={hi} flexDirection="column">
          <Text dimColor>
            {'  @@ -' + hunk.oldStart + ',' + hunk.oldLines +
             ' +' + hunk.newStart + ',' + hunk.newLines + ' @@'}
          </Text>
          {hunk.lines.map((line, li) => {
            const prefix = line[0] || ' ';
            const rest = line.slice(1);
            if (prefix === '+') {
              return (
                <Text key={li}>
                  <Text color="green">  + {rest}</Text>
                </Text>
              );
            } else if (prefix === '-') {
              return (
                <Text key={li}>
                  <Text color="red">  - {rest}</Text>
                </Text>
              );
            }
            return <Text key={li} dimColor>{'  ' + line}</Text>;
          })}
        </Box>
      ))}
      <Text dimColor>  ──</Text>
    </Box>
  );
}
