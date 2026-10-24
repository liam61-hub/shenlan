/**
 * /mcp 交互面板 — 动态区模态面板（对齐 Claude Code /mcp）
 *
 * 两级视图：
 *   列表：所有 server 的启用/连接状态，↑/↓ 选择，Enter 进入详情，f 全部重连
 *   详情：Status / Command / Config location / Capabilities / Tools + 操作菜单
 *        （View tools · Reconnect/Connect · Disable/Enable）
 *   工具：View tools 后的工具名列表，Esc 返回
 * 输入框隐藏，按键由 InputBox useInput 捕获。
 */
import { Box, Text } from 'ink';
import { useContext } from 'react';
import { AppContext, mcpMenuFor } from '../context.js';
import type { McpPanelState } from '../context.js';
import { capLine } from '../streaming.js';
import { mcpScopeLabel } from '../mcp.js';

/** 每个 server 固定占 2 行：状态行 + 工具摘要行 */
const LINES_PER_SERVER = 2;
const LIST_HINT = '↑/↓ to navigate · Enter to view · f refresh all · Esc to close';
const MENU_HINT = '↑/↓ to navigate · Enter to select · Esc to back';

function detailLabel(value: string): string {
  return value.padEnd(18);
}

export function McpPanelView({ panel }: { panel: McpPanelState }) {
  const { termHeight, termWidth } = useContext(AppContext);
  const maxRows = Math.max(1, termHeight - 1); // 输入框隐藏，底部留白 1 行
  const maxWidth = Math.max(8, termWidth - 2);

  // 工具列表视图
  if (panel.detail && panel.toolsView) {
    const tools = panel.detail.tools;
    const visible = tools.slice(0, maxRows - 3);
    return (
      <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
        <Text bold color="cyan">  Tools — {panel.detail.name}</Text>
        {tools.length === 0 && <Text dimColor>  (no tools discovered)</Text>}
        {visible.map(t => (
          <Text key={t}>  • {capLine(t, maxWidth)}</Text>
        ))}
        {visible.length < tools.length && <Text dimColor>  … {tools.length - visible.length} more</Text>}
        <Text dimColor>  Esc to back</Text>
      </Box>
    );
  }

  // 详情视图
  if (panel.detail) {
    const s = panel.detail;
    const menu = mcpMenuFor(s);
    return (
      <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
        <Text bold color="cyan">  {s.name} MCP Server</Text>
        <Text>  </Text>
        <Text>  {detailLabel('Status:')}{s.enabled
          ? (s.connected ? '✔ connected' : s.error ? `✗ error: ${capLine(s.error, maxWidth - 24)}` : '○ not connected')
          : '○ disabled'}
        </Text>
        <Text>  {detailLabel('Command:')}{capLine(
          s.transport === 'http'
            ? (s.url || '—')
            : [s.command, ...(s.args || [])].filter(Boolean).join(' ') || '—',
          maxWidth - 24,
        )}</Text>
        <Text>  {detailLabel('Config location:')}{capLine(s.configFile, maxWidth - 24)}</Text>
        <Text>  {detailLabel('Capabilities:')}{s.capabilities.length > 0 ? s.capabilities.join(' · ') : 'tools'}</Text>
        <Text>  {detailLabel('Tools:')}{s.toolCount} tools</Text>
        <Text>  </Text>
        {panel.busy && <Text dimColor>  {panel.notice || 'working...'}</Text>}
        {menu.map((item, i) => (
          <Text key={item.op} inverse={i === panel.detailMenu && !panel.busy}>
            {i === panel.detailMenu ? '  ❯' : '   '} {i + 1}. {item.label}
          </Text>
        ))}
        {panel.busy && <Text>  </Text>}
        <Text dimColor>  {MENU_HINT}</Text>
      </Box>
    );
  }

  // 列表视图
  const totalLines = panel.servers.length * LINES_PER_SERVER;
  const startLine = totalLines <= maxRows
    ? 0
    : Math.max(0, Math.min(panel.selected * LINES_PER_SERVER - Math.floor(maxRows / 2), totalLines - maxRows));
  const endLine = Math.min(totalLines, startLine + maxRows);
  const visible = panel.servers.slice(
    Math.floor(startLine / LINES_PER_SERVER),
    Math.ceil(endLine / LINES_PER_SERVER),
  );

  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
      <Text bold color="cyan">  MCP Servers</Text>
      <Text dimColor>  {panel.busy ? (panel.notice || 'working...') : LIST_HINT}</Text>
      {visible.length === 0 && <Text dimColor>{`  No MCP servers configured（exit and run /mcp add <name> -- <command>）`}</Text>}
      {visible.map((s, i) => {
        const absIndex = Math.floor(startLine / LINES_PER_SERVER) + i;
        const selected = absIndex === panel.selected;
        const statusText = !s.enabled
          ? '○ disabled'
          : s.connected
            ? `✔ connected (${s.toolCount} tools)`
            : s.error
              ? `✗ error`
              : '○ not connected';
        const toolsText = s.tools.length > 0
          ? `tools: ${s.tools.join(', ')}`
          : '(no tools discovered)';
        return (
          <Box key={s.name} flexDirection="column">
            <Text inverse={selected}>
              {selected ? '  ❯' : '   '} {s.name}  {s.transport}  {mcpScopeLabel(s.scope)}  {capLine(statusText, maxWidth - 8)}
            </Text>
            <Text dimColor>  {capLine(toolsText, maxWidth)}</Text>
          </Box>
        );
      })}
      {endLine < totalLines && <Text dimColor>  … {totalLines - endLine} lines not shown</Text>}
    </Box>
  );
}
