/**
 * /security 提交安全检查面板 — 钩子状态 / 安装卸载 / 手动扫描 / 已跟踪敏感文件提示
 *
 * 菜单（按钩子状态变化）：
 *   - 未安装 → [1] 安装 pre-commit 钩子
 *   - 已安装（本产品）→ [1] 重装钩子 [2] 卸载钩子
 *   - 已存在他人钩子 → [1] 查看（不覆盖）[2] 重新扫描
 * 另有 [重扫] 手动扫描暂存区，Esc/q 关闭。
 */
import { Box, Text } from 'ink';
import { useContext } from 'react';
import { AppContext, securityMenuLength } from '../context.js';
import type { SecurityPanelState } from '../context.js';
import { capLine } from '../streaming.js';

/** 标题 + 状态块 + 2 空行 + 页脚之外的行数（内容行浮动） */
const CHROME_ROWS = 5;

export function SecurityPanelView({ panel }: { panel: SecurityPanelState }) {
  const { termHeight, termWidth } = useContext(AppContext);
  const maxRows = Math.max(1, termHeight - 1);
  const rowBudget = Math.max(1, maxRows - CHROME_ROWS);
  const maxWidth = Math.max(8, termWidth - 2);

  const menu = securityMenu(panel);
  const lines: Array<{ key: string; text: string; dim?: boolean; yellow?: boolean }> = [];

  if (!panel.hook.gitRepo) {
    lines.push({ key: 's1', text: '  当前目录不是 git 仓库 — 钩子不适用', dim: true });
  } else {
    const hookState = !panel.hook.hookExists
      ? '未安装'
      : panel.hook.ours
        ? '已安装（shenlan）'
        : '已存在（非 shenlan，未覆盖）';
    lines.push({ key: 's1', text: `  pre-commit 钩子：${hookState}` });
    lines.push({ key: 's2', text: `  ${capLine(panel.hook.path || '', maxWidth)}`, dim: true });
  }

  if (panel.trackedSensitive.length > 0) {
    lines.push({
      key: 's3',
      text: `  ⚠ 已跟踪敏感配置：${panel.trackedSensitive.join(', ')}（建议 git rm --cached）`,
      yellow: true,
    });
  } else if (panel.hook.gitRepo) {
    lines.push({ key: 's3', text: '  已跟踪敏感配置文件：无', dim: true });
  }

  for (const item of menu) {
    lines.push({
      key: `m${item.index}`,
      text: `  ${item.index === panel.selected ? '❯ ' : '  '}${item.index + 1}. ${item.label}`,
    });
  }

  if (panel.notice) {
    lines.push({ key: 'n', text: `  ℹ ${capLine(panel.notice, maxWidth)}`, yellow: true });
  }
  if (panel.busy) {
    lines.push({ key: 'b', text: '  ⬡ running...', dim: true });
  }

  const shown = lines.slice(0, rowBudget);

  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
      <Text bold color="cyan">  Security</Text>
      <Text dimColor>  提交时安全检查：pre-commit 钩子扫描暂存内容，拦截疑似密钥</Text>
      <Box height={1} />
      {shown.map((l) => (
        <Text key={l.key} dimColor={l.dim} color={l.yellow ? 'yellow' : undefined}>
          {capLine(l.text, maxWidth)}
        </Text>
      ))}
      <Box height={1} />
      <Text dimColor>  ↑/↓ 选择 · Enter 执行 · Esc 关闭</Text>
    </Box>
  );
}

export function securityMenu(panel: SecurityPanelState): Array<{ index: number; label: string; op: string }> {
  if (!panel.hook.gitRepo) return [{ index: 0, label: '重新扫描（暂存区）', op: 'scan' }];
  if (panel.hook.hookExists && !panel.hook.ours) {
    return [
      { index: 0, label: '查看（保留现有钩子，不覆盖）', op: 'inspect' },
      { index: 1, label: '重新扫描（暂存区）', op: 'scan' },
    ];
  }
  const installLabel = panel.hook.hookExists ? '重装钩子' : '安装 pre-commit 钩子';
  return [
    { index: 0, label: installLabel, op: 'install' },
    ...(panel.hook.hookExists ? [{ index: 1, label: '卸载钩子', op: 'uninstall' }] : []),
    { index: panel.hook.hookExists ? 2 : 1, label: '重新扫描（暂存区）', op: 'scan' },
  ];
}
