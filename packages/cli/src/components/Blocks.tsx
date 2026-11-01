/**
 * 块级 markdown 渲染 — 盒子边框表格 + 数学公式块。
 * 完成态 renderMarkdown 与流式静态块（assistant-block）共用同一实现。
 */

import React from 'react';
import { Text, Box } from 'ink';
import {
  isPipeRow,
  isSeparatorRow,
  splitPipeRow,
  tableColumnWidths,
  padCell,
  convertMathSpans,
  wrapText,
  mathToUnicode,
} from '../markdown-utils.js';
import { renderInlineMd } from './MessageItem.js';

/** 解析 $$...$$ 块内容 → 去掉定界符后的公式行数组（未闭合也容错） */
export function parseMathBlock(content: string): string[] {
  const lines = content.split('\n');
  const mathLines: string[] = [];
  let i = 0;
  const first = (lines[0] || '').trim();
  let closed = false;
  if (first === '$$') {
    i = 1;
  } else if (first.endsWith('$$') && first.length > 4) {
    mathLines.push(first.replace(/^\$\$/, '').replace(/\$\$$/, '').trim());
    closed = true;
    i = 1;
  } else if (first.startsWith('$$')) {
    mathLines.push(first.replace(/^\$\$/, '').trim());
    i = 1;
  } else {
    mathLines.push(first);
    i = 1;
  }
  while (!closed && i < lines.length) {
    const l = lines[i].trim();
    if (l.endsWith('$$')) {
      const inner = l.replace(/\$\$$/, '').trim();
      if (inner) mathLines.push(inner);
      closed = true;
    } else if (l === '$$') {
      closed = true;
    } else {
      mathLines.push(l);
    }
    i++;
  }
  return mathLines;
}

/** 数学公式块：每行 Unicode 可读化渲染 */
export function MathBlock({ content }: { content: string }): React.ReactElement {
  const mathLines = parseMathBlock(content);
  return (
    <Box flexDirection="column">
      {mathLines.map((l, li) => (
        <Text key={li} color="cyan">  {mathToUnicode(l)}</Text>
      ))}
    </Box>
  );
}

/** 表格块：解析表头/分隔行/数据行 → Codex 风格渲染（表头重分隔线 + 行间轻分隔线，列内折行 + 对齐） */
export function TableBlock({ content }: { content: string }): React.ReactElement {
  const lines = content.split('\n');
  const header = splitPipeRow(lines[0] || '');
  const rows: string[][] = [];
  let i = 1;
  if (isSeparatorRow(lines[i])) i++;
  for (; i < lines.length; i++) {
    if (isPipeRow(lines[i])) rows.push(splitPipeRow(lines[i]));
  }
  // AssistantFrame reserves 5 terminal columns (left indent, padding,
  // and the final safe column). Keep table rows and rules inside that width so
  // the terminal never wraps a rendered separator onto a second line.
  const widths = tableColumnWidths(header, rows, Math.max(1, (process.stdout.columns || 80) - 5));

  return (
    <Box flexDirection="column">
      {renderTableRow(header, widths, true, 'tblh')}
      <Text dimColor>{separatorLine('━', widths)}</Text>
      {rows.map((row, ri) => (
        <Box key={`tblr-${ri}`} flexDirection="column">
          {renderTableRow(row, widths, false, `tblr-${ri}`)}
          {ri < rows.length - 1 ? <Text dimColor>{separatorLine('─', widths)}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

/** 分隔线：每列按列宽重复字符，列间 2 空格（与内容列对齐） */
function separatorLine(ch: string, widths: number[]): string {
  return widths.map(w => ch.repeat(w)).join('  ');
}

/** 表格行渲染（单元格列内折行成多行，逐行按列宽填充，列间 2 空格，表头加粗） */
function renderTableRow(cells: string[], widths: number[], bold: boolean, keyBase: string): React.ReactNode {
  const colCount = Math.max(1, widths.length);
  // 先转换单元格内的数学跨度，再按列宽折行（避免 $...$ 被从中间切开留下裸 $）
  const cellLines = cells.map((cell, c) => wrapText(convertMathSpans(cell), widths[c] || 1));
  const rowHeight = Math.max(1, ...cellLines.map(ls => ls.length));
  return (
    <Box key={keyBase} flexDirection="column">
      {Array.from({ length: rowHeight }, (_, li) => (
        <Text key={li}>
          {Array.from({ length: colCount }, (_, c) => {
            const piece = (cellLines[c] && cellLines[c][li]) || '';
            const content = renderInlineMd(padCell(piece, widths[c] || 1));
            return (
              <Text key={c}>
                {c > 0 ? '  ' : ''}
                {bold ? <Text bold color="cyan">{content}</Text> : content}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}
