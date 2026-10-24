/**
 * /model 模型选择面板 — 动态区模态面板（对齐 Codex CLI /model 样式）
 *
 * 置顶 Default（自动路由）项，随后按 provider 分组列出全部模型（组标题行不编号、
 * 不可选，仅用于区分官方端点与百炼托管模型）：
 *   - ↑/↓ 浏览（跳过无 key 置灰项）、数字键直选
 *   - Enter 设为默认（manual 锁定 + 全局持久化）
 *   - s 仅本次会话（不写全局配置）
 *   - Esc 取消
 *
 * 高度预算：可见行 = 模型行 + 组标题行 + 组前空白行 ≤ rowBudget（= maxRows - CHROME_ROWS），
 * 保证动态帧总高 ≤ 终端行数 - 1（AGENTS.md 硬性规则，不出整屏清屏序列）。
 */
import { Box, Text } from 'ink';
import { useContext } from 'react';
import { AppContext } from '../context.js';
import type { ModelOption, ModelPanelState } from '../context.js';
import { capLine } from '../streaming.js';

/** 上下文窗口展示：1M / 128k / ... */
function formatCtx(n: number): string {
  if (n >= 1_000_000) return '1M';
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const NAME_COL = 30;
/** 标题 + 副标题 + 2 空行 + 页脚（模型行之外的固定骨架） */
const CHROME_ROWS = 5;

export interface PanelWindow {
  start: number;
  count: number;
}

function isGroupStart(models: ModelOption[], i: number): boolean {
  return i === 0 || models[i]!.group !== models[i - 1]!.group;
}

/**
 * 计算面板可见模型行窗口（组标题行与组前空白行计入 rowBudget）：
 * 以选中行为中心，循环求最大模型行数 k 满足 k + 窗口内标题/空白行数 ≤ rowBudget；
 * 窗口收缩后回拉 start，保证尾部可见。
 */
export function computePanelWindow(
  models: ModelOption[],
  selected: number,
  rowBudget: number,
): PanelWindow {
  const n = models.length;
  if (n === 0) return { start: 0, count: 0 };
  /** 组标题行 + 组前空白行（窗口顶部的组标题不加空白，顶部已有 chrome 空白） */
  const extraRows = (startIdx: number, count: number): number => {
    let headers = 0;
    for (let i = startIdx; i < startIdx + count; i++) {
      if (isGroupStart(models, i)) headers++;
    }
    if (headers === 0) return 0;
    return headers * 2 - (isGroupStart(models, startIdx) ? 1 : 0);
  };

  // 以选中行为中心；窗口收缩（组标题扣预算）后若选中行落出窗口，
  // 向选中行方向移动窗口并重新校验，保证选中行始终可见
  let start = Math.max(0, Math.min(selected - Math.floor((rowBudget - 1) / 2), Math.max(0, n - 1)));
  let count = Math.min(rowBudget, n - start);
  while (count > 0 && count + extraRows(start, count) > rowBudget) count--;
  for (let guard = 0; guard < n && count > 0; guard++) {
    if (selected >= start && selected < start + count) break;
    if (selected >= start + count) {
      start = Math.min(n - count, start + 1);
    } else {
      start = Math.max(0, start - 1);
    }
    while (count > 0 && count + extraRows(start, count) > rowBudget) count--;
  }
  return { start, count };
}

export function ModelPanelView({ panel }: { panel: ModelPanelState }) {
  const { termHeight, termWidth } = useContext(AppContext);
  const maxRows = Math.max(1, termHeight - 1);
  const rowBudget = Math.max(1, maxRows - CHROME_ROWS);
  const n = panel.models.length;
  const { start, count } = computePanelWindow(panel.models, panel.selected, rowBudget);
  // 渲染行：组首项前插组标题行（不编号、不可选），模型行保持原编号索引
  const rows: Array<
    { type: 'sep' } | { type: 'header'; label: string } | { type: 'model'; opt: ModelOption; idx: number }
  > = [];
  for (let i = start; i < start + count; i++) {
    if (isGroupStart(panel.models, i)) {
      // 窗口顶部的组标题前不加空白（顶部已有 chrome 空白）
      if (i !== start) rows.push({ type: 'sep' });
      rows.push({ type: 'header', label: panel.models[i]!.group });
    }
    rows.push({ type: 'model', opt: panel.models[i]!, idx: i });
  }
  const maxWidth = Math.max(8, termWidth - 2);
  const modelEntries = panel.models.filter(m => m.kind === 'model');
  const noAvailable = modelEntries.length > 0 && !modelEntries.some(m => m.available);

  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
      <Text bold color="cyan">  Select model</Text>
      <Text dimColor>  选择后成为默认模型（写入全局配置）；其他模型名可用 /model &lt;名称&gt; 指定。</Text>
      <Box height={1} />
      {rows.map((row, i) => {
        if (row.type === 'sep') {
          return <Text key={`sep-${i}`} dimColor>{' '}</Text>;
        }
        if (row.type === 'header') {
          return <Text key={`header-${row.label}`} dimColor>  {row.label}</Text>;
        }
        const { opt, idx } = row;
        const selected = idx === panel.selected;
        const number = String(idx + 1);
        const name = opt.kind === 'auto' ? 'Default (自动路由)' : opt.model;
        const info = opt.kind === 'auto'
          ? opt.tag
          : [
              opt.contextWindow > 0 ? `${formatCtx(opt.contextWindow)} 上下文` : '',
              opt.tag,
              opt.priceText,
              opt.available ? '' : '无 key',
            ].filter(Boolean).join(' · ');
        const prefix = `${selected ? '❯ ' : '  '}${number}. ${name}${opt.current ? ' ✔' : ''}`;
        const line = capLine(`${prefix.padEnd(NAME_COL)}  ${info}`, maxWidth);
        return (
          <Box key={`${opt.kind}-${opt.model}`}>
            <Text inverse={selected} dimColor={!opt.available}>{line}</Text>
          </Box>
        );
      })}
      {noAvailable && (
        <Text dimColor>  当前没有可用的模型 key：配置 providerKeys 或环境变量后可用</Text>
      )}
      <Box height={1} />
      <Text dimColor>  Enter 设为默认 · s 仅本次会话 · Esc 取消</Text>
      {n > count && (
        <Text dimColor>  … {n - (start + count)} 个未显示</Text>
      )}
    </Box>
  );
}
