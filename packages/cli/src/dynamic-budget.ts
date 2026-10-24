/**
 * 动态区帧高预算 — 保证 Ink 动态帧总高 ≤ rows-1，
 * 永不触发 Ink 的整屏清空模式（\x1b[2J\x1b[3J\x1b[H）。
 *
 * 布局：<Static>（历史/流式整行，进终端回滚区，不计入帧高）
 *      + 动态区（≤ maxDynamicRows(termHeight, inputLines, slashLines)）
 *      + InputBox（顶部留白 1 + 2 条分隔线 + 输入文本行 L + 常驻状态行 1 行）
 *
 * 输入框支持多行内容（粘贴保留换行），文本行数上限 maxInputLines(termHeight)，
 * 动态区预算随输入行数收缩，保证总输出恒 ≤ rows-1。
 */

/** InputBox 固定骨架行数：顶部留白 + 分隔线 + 输入行 + 分隔线（输入行按实际行数计） */
export const INPUT_BOX_HEIGHT = 4;

/** InputBox 顶部留白 + 两条分隔线（输入文本行数之外的部分） */
export const INPUT_CHROME_LINES = 3;

/** 输入框下方常驻状态行（模型 · 模式 · 工作目录，始终 1 行） */
export const STATUS_LINE_HEIGHT = 1;

/** 底部留白 1 行 */
export const BOTTOM_RESERVE = 1;

/** 输入框占满时动态区最低保留行数 */
export const MIN_DYNAMIC_ROWS = 4;

/** 运行中工具状态最多显示行数 */
export const TOOL_STATUS_MAX = 4;

/** 斜杠命令联想最多显示行数（渲染在输入框下方，占用输入区高度） */
export const SLASH_MAX = 8;

/** 确认弹窗预算行数（标题/详情/3 选项/说明原因 + 反馈输入模式） */
export const CONFIRM_MAX = 16;

/** 错误信息最多显示行数 */
export const ERROR_MAX = 3;

/**
 * 斜杠联想窗口起点：以选中项为中心、窗口高度 ≤ max（默认 SLASH_MAX），
 * 首尾钳制（n ≤ max 时恒返回 0；选中项靠近首/尾时窗口贴住边界）。
 */
export function slashWindowStart(matchCount: number, selected: number, max = SLASH_MAX): number {
  const n = Math.max(0, Math.floor(matchCount));
  if (n <= max) return 0;
  const sel = Math.max(0, Math.min(selected, n - 1));
  const half = Math.floor((max - 1) / 2);
  return Math.max(0, Math.min(sel - half, n - max));
}

/**
 * 输入框文本行数上限：给动态区预留 MIN_DYNAMIC_ROWS 行。
 * 总输出 = 动态区 + 输入区(2+L) + 状态行 + 底部留白 ≤ rows-1 恒成立。
 */
export function maxInputLines(termHeight: number): number {
  return Math.max(
    1,
    termHeight - INPUT_CHROME_LINES - STATUS_LINE_HEIGHT - BOTTOM_RESERVE - MIN_DYNAMIC_ROWS,
  );
}

/**
 * 动态区最大行数 = rows - 输入区固定骨架(3) - 输入文本行数(inputLines)
 *               - 联想行数(extraLines) - 状态行(1) - 底部留白(1)。
 * inputLines=1 时与旧公式一致（rows-5），向后兼容现有调用。
 */
export function maxDynamicRows(termHeight: number, inputLines = 1, extraLines = 0): number {
  const lines = Math.max(1, Math.floor(inputLines));
  const extra = Math.max(0, Math.floor(extraLines));
  return Math.max(
    1,
    termHeight - INPUT_CHROME_LINES - lines - extra - STATUS_LINE_HEIGHT - BOTTOM_RESERVE,
  );
}

export interface BudgetSection {
  key: string;
  /** 越小越重要：confirm(1) > error(2) > tail(3) > tools(4) > thinking(5) */
  priority: number;
  /** 需要的行数 */
  height: number;
}

/**
 * 按优先级分配行数，返回每个 section 实际可用的行数（0 = 不渲染）。
 * 保证总和 ≤ maxRows；空间不足时优先完整保留高优先级项，
 * 只有最高优先级项允许被截断到剩余空间（如极小终端下的 confirm）。
 */
export function fitDynamicBudget(
  sections: BudgetSection[],
  maxRows: number,
): Map<string, number> {
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const allocated = new Map<string, number>();
  let used = 0;
  for (const section of sorted) {
    if (used >= maxRows) break;
    const lines = Math.min(section.height, maxRows - used);
    allocated.set(section.key, lines);
    used += lines;
  }
  return allocated;
}
