import { describe, expect, it } from 'vitest';
import {
  maxDynamicRows,
  maxInputLines,
  fitDynamicBudget,
  INPUT_BOX_HEIGHT,
  STATUS_LINE_HEIGHT,
  CONFIRM_MAX,
  ERROR_MAX,
  MIN_DYNAMIC_ROWS,
  slashWindowStart,
} from '../dynamic-budget.js';

describe('maxDynamicRows（帧高硬规则：动态区 + 输入框 ≤ rows-1）', () => {
  it('典型终端高度', () => {
    expect(maxDynamicRows(24)).toBe(18);
    expect(maxDynamicRows(40)).toBe(34);
  });

  it('总输出恒 ≤ rows-1（含常驻状态行）', () => {
    for (const rows of [24, 30, 40, 50]) {
      const total = maxDynamicRows(rows) + INPUT_BOX_HEIGHT + STATUS_LINE_HEIGHT;
      expect(total).toBeLessThanOrEqual(rows - 1);
    }
  });

  it('最小 1 行', () => {
    expect(maxDynamicRows(5)).toBe(1);
  });

  it('输入框多行时动态区预算同步收缩', () => {
    expect(maxDynamicRows(24, 2)).toBe(17);
    expect(maxDynamicRows(24, 10)).toBe(9);
    expect(maxDynamicRows(24, 100)).toBe(1);
  });

  it('斜杠联想占用输入区高度时动态区预算同步收缩', () => {
    expect(maxDynamicRows(24, 1, 3)).toBe(15);
    expect(maxDynamicRows(24, 1, 9)).toBe(9);
    expect(maxDynamicRows(24, 1, 100)).toBe(1);
  });

  it('输入框文本行数上限：给动态区预留 MIN_DYNAMIC_ROWS', () => {
    expect(maxInputLines(24)).toBe(24 - 3 - 1 - 1 - MIN_DYNAMIC_ROWS);
    expect(maxInputLines(40)).toBe(31);
    expect(maxInputLines(8)).toBe(1);
  });

  it('输入框占满时总输出仍 ≤ rows-1', () => {
    for (const rows of [24, 30, 40, 50]) {
      const inputLines = maxInputLines(rows);
      const total = maxDynamicRows(rows, inputLines) + inputLines + 3 + STATUS_LINE_HEIGHT;
      expect(total).toBeLessThanOrEqual(rows - 1);
    }
  });
});

describe('fitDynamicBudget（按优先级分配行数）', () => {
  it('空间充足时全部保留', () => {
    const allocated = fitDynamicBudget(
      [
        { key: 'confirm', priority: 1, height: CONFIRM_MAX },
        { key: 'error', priority: 2, height: ERROR_MAX },
        { key: 'tail', priority: 3, height: 1 },
      ],
      20,
    );
    expect(allocated.get('confirm')).toBe(CONFIRM_MAX);
    expect(allocated.get('error')).toBe(ERROR_MAX);
    expect(allocated.get('tail')).toBe(1);
  });

  it('空间不足时高优先级优先保留，总和 ≤ maxRows', () => {
    const allocated = fitDynamicBudget(
      [
        { key: 'confirm', priority: 1, height: CONFIRM_MAX },
        { key: 'error', priority: 2, height: ERROR_MAX },
        { key: 'tail', priority: 3, height: 1 },
        { key: 'tools', priority: 4, height: 4 },
      ],
      25,
    );
    expect(allocated.get('confirm')).toBe(CONFIRM_MAX);
    expect(allocated.get('error')).toBe(ERROR_MAX);
    expect(allocated.get('tail')).toBe(1);
    expect(allocated.get('tools')).toBe(4);
    const total = [...allocated.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(25);
  });

  it('极小终端：最高优先级项截断到剩余空间，其余为 0', () => {
    const allocated = fitDynamicBudget(
      [
        { key: 'confirm', priority: 1, height: CONFIRM_MAX },
        { key: 'tail', priority: 3, height: 1 },
      ],
      3,
    );
    expect(allocated.get('confirm')).toBe(3);
    expect(allocated.get('tail')).toBeUndefined();
  });

  it('空输入返回空 Map', () => {
    expect(fitDynamicBudget([], 20).size).toBe(0);
  });

  it('plan/todos 优先级最低：空间不足时先丢 todos 再丢 plan，confirm 恒保留', () => {
    // 空间紧张：confirm + tail + tools + thinking + plan + todos
    const allocated = fitDynamicBudget(
      [
        { key: 'confirm', priority: 1, height: CONFIRM_MAX },
        { key: 'tail', priority: 3, height: 1 },
        { key: 'tools', priority: 4, height: 4 },
        { key: 'thinking', priority: 5, height: 1 },
        { key: 'plan', priority: 5, height: 5 },
        { key: 'todos', priority: 6, height: 1 },
      ],
      23,
    );
    // confirm(16) + tail(1) + tools(4) + thinking(1) = 22，剩 1 行给 plan，todos 丢弃
    expect(allocated.get('confirm')).toBe(CONFIRM_MAX);
    expect(allocated.get('plan')).toBeGreaterThanOrEqual(1);
    expect(allocated.get('todos')).toBeUndefined();

    // 更极端：plan 也完全丢弃时，todos 同样丢弃
    const tiny = fitDynamicBudget(
      [
        { key: 'confirm', priority: 1, height: CONFIRM_MAX },
        { key: 'plan', priority: 5, height: 5 },
        { key: 'todos', priority: 6, height: 1 },
      ],
      12,
    );
    expect(tiny.get('confirm')).toBe(12);
    expect(tiny.get('plan')).toBeUndefined();
    expect(tiny.get('todos')).toBeUndefined();
  });
});

describe('slashWindowStart（联想窗口起点：选中项居中、首尾钳制）', () => {
  it('n ≤ max 恒返回 0', () => {
    expect(slashWindowStart(0, 0)).toBe(0);
    expect(slashWindowStart(8, 0)).toBe(0);
    expect(slashWindowStart(8, 7)).toBe(0);
  });

  it('顶部钳制：选中前几项时窗口从 0 开始', () => {
    expect(slashWindowStart(23, 0)).toBe(0);
    expect(slashWindowStart(23, 3)).toBe(0);
  });

  it('底部钳制：选中最后几项时窗口尾部对齐', () => {
    expect(slashWindowStart(23, 22)).toBe(15);
    expect(slashWindowStart(23, 20)).toBe(15);
  });

  it('中间选中项居中（以选中项为中心）', () => {
    expect(slashWindowStart(23, 11)).toBe(8); // 窗口 [8..15]，选中在窗口内
    expect(slashWindowStart(23, 10)).toBe(7);
  });

  it('任意数量/选中项下窗口合法且选中项始终可见', () => {
    for (let n = 0; n <= 30; n++) {
      for (let sel = 0; sel < n; sel++) {
        const start = slashWindowStart(n, sel);
        const win = Math.min(8, n);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThanOrEqual(Math.max(0, n - win));
        expect(sel).toBeGreaterThanOrEqual(start);
        expect(sel).toBeLessThan(start + win);
      }
    }
  });

  it('越界选中值被钳制到合法范围', () => {
    expect(slashWindowStart(23, 99)).toBe(15);
    expect(slashWindowStart(23, -1)).toBe(0);
  });
});
