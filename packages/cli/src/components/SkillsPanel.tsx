/**
 * /skills 只读面板 — 动态区模态面板
 *
 * 列出内置 / 全局 / 项目 skills（名称、描述、来源、路径），↑/↓ 浏览，Esc 关闭。
 */
import { Box, Text } from 'ink';
import { useContext } from 'react';
import { AppContext } from '../context.js';
import type { SkillsPanelState } from '../context.js';
import { capLine } from '../streaming.js';
import { skillSourceLabel } from '../skills.js';

const LINES_PER_SKILL = 2;

export function SkillsPanelView({ panel }: { panel: SkillsPanelState }) {
  const { termHeight, termWidth } = useContext(AppContext);
  const maxRows = Math.max(1, termHeight - 1);
  const totalLines = panel.skills.length * LINES_PER_SKILL;
  const startLine = totalLines <= maxRows
    ? 0
    : Math.max(0, Math.min(panel.selected * LINES_PER_SKILL - Math.floor(maxRows / 2), totalLines - maxRows));
  const endLine = Math.min(totalLines, startLine + maxRows);
  const visible = panel.skills.slice(
    Math.floor(startLine / LINES_PER_SKILL),
    Math.ceil(endLine / LINES_PER_SKILL),
  );
  const maxWidth = Math.max(8, termWidth - 2);

  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
      <Text bold color="cyan">  Installed Skills ({panel.skills.length})</Text>
      <Text dimColor>  ↑/↓ 浏览 · Esc 关闭</Text>
      {visible.length === 0 && <Text dimColor>  未安装 skills</Text>}
      {visible.map((s, i) => {
        const absIndex = Math.floor(startLine / LINES_PER_SKILL) + i;
        const selected = absIndex === panel.selected;
        const lock = s.source === 'builtin' ? '🔒 ' : '';
        const tag = skillSourceLabel(s.source);
        return (
          <Box key={s.name} flexDirection="column">
            <Text inverse={selected}>
              {selected ? '  ›' : '   '} {lock}{s.name} — {capLine(s.description, maxWidth - 6 - lock.length - tag.length - 2)} [{tag}]
            </Text>
            <Text dimColor>  {capLine(s.dir, maxWidth)}</Text>
          </Box>
        );
      })}
      {endLine < totalLines && <Text dimColor>  … {totalLines - endLine} 行未显示</Text>}
    </Box>
  );
}
