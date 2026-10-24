/**
 * /config 交互配置面板 — 动态区模态面板（对齐 Claude Code CLI 配置交互）
 *
 * 列出全部配置项（schema 键 + providerKeys/providerBaseUrls 动态键）；
 * ←/→ 切换布尔（取反）/ 枚举（循环 allowedValues）；Enter 进入行内编辑
 * （预填当前值，粘贴支持，Enter 保存 / Esc 取消）；d 恢复默认；
 * g/p 切作用域（默认 project，与 /config set 一致）；Esc/q 关闭。
 * 骨架文案随 config.language 双语切换（默认 en）。
 */
import { Box, Text } from 'ink';
import { useContext } from 'react';
import { AppContext } from '../context.js';
import type { ConfigPanelState } from '../context.js';
import { sourceLabel } from '../commands/config.js';
import { UI, langOf } from '../i18n.js';
import { capLine } from '../streaming.js';

const KEY_COL = 34;
/** 标题 + 副标题 + 空行 + notice 位 + 页脚（列表行之外的固定骨架）；每个配置项占 2 行（值行 + 注释行） */
const CHROME_ROWS = 6;

export function ConfigPanelView({ panel }: { panel: ConfigPanelState }) {
  const { termHeight, termWidth, config } = useContext(AppContext);
  const lang = langOf(config.language);
  const ui = UI[lang];
  const maxRows = Math.max(1, termHeight - 1);
  // 每项 2 行：值行 + 注释行（每个配置项都列出注释）
  const winItems = Math.max(1, Math.floor(Math.max(1, maxRows - CHROME_ROWS) / 2));
  const n = panel.rows.length;
  const start = n <= winItems
    ? 0
    : Math.max(0, Math.min(panel.selected - Math.floor((winItems - 1) / 2), n - winItems));
  const shown = panel.rows.slice(start, start + winItems);
  const maxWidth = Math.max(8, termWidth - 2);
  const selected = panel.rows[panel.selected];
  const scopeLabel = ui.scopeLabel(panel.scope);

  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
      <Text bold color="cyan">  Config</Text>
      <Text dimColor>  {ui.panelSubtitle}</Text>
      <Box height={1} />
      {panel.editing ? (
        <Box flexDirection="column">
          <Text dimColor>{`  ${ui.editPrefix} ${selected?.key ?? ''} — ${selected?.description ?? ''}`}</Text>
          <Box>
            <Text dimColor>  {'> '}</Text>
            <Text>{panel.editText}</Text>
            <Text>█</Text>
          </Box>
          <Box height={1} />
        </Box>
      ) : (
        <Box flexDirection="column">
          {shown.map((r, i) => {
            const idx = start + i;
            const isSel = idx === panel.selected;
            const line = capLine(
              `${isSel ? '❯ ' : '  '}${r.key.padEnd(KEY_COL)}  ${r.display}  (${sourceLabel(r.source, lang)})`,
              maxWidth,
            );
            const desc = capLine(
              `    ${r.description}${r.allowedValues ? `（${r.allowedValues.join(' / ')}）` : ''}`,
              maxWidth,
            );
            return (
              <Box key={r.key} flexDirection="column">
                <Text inverse={isSel}>{line}</Text>
                <Text dimColor>{desc}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      {panel.notice && (
        <Text color="yellow">  ℹ {capLine(panel.notice, maxWidth)}</Text>
      )}
      <Text dimColor>
        {panel.editing
          ? `  ${ui.footerEdit}`
          : `  ${ui.footerList(scopeLabel)}`}
      </Text>
    </Box>
  );
}
