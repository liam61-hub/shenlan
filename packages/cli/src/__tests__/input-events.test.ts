import { describe, expect, it, beforeEach } from 'vitest';
import {
  expandInputEvents,
  normalizePastedText,
  insertAt,
  cursorToLineCol,
  inputWindow,
  displayCol,
  inputWindowH,
  sliceToDisplayWidth,
  PASTE_COLLAPSE_THRESHOLD,
  formatPastePlaceholder,
  shouldCollapsePaste,
  storePasteContent,
  expandPasteTokens,
  expandPasteTokensAt,
  hasPastePlaceholder,
  clearPasteStore,
} from '../input-events.js';
import { displayWidth } from '../markdown-utils.js';

describe('normalizePastedText（粘贴文本归一化）', () => {
  it('CRLF / LF / 孤立 CR 统一为 LF', () => {
    expect(normalizePastedText('a\r\nb\nc\rd')).toBe('a\nb\nc\nd');
  });

  it('去掉末尾换行残留，内部换行保留', () => {
    expect(normalizePastedText('line1\nline2\n')).toBe('line1\nline2');
    expect(normalizePastedText('line1\nline2\r\n\r\n')).toBe('line1\nline2');
  });

  it('无换行文本原样返回，纯换行清空', () => {
    expect(normalizePastedText('plain text')).toBe('plain text');
    expect(normalizePastedText('\n\n')).toBe('');
  });
});

describe('insertAt（光标处插入）', () => {
  it('光标处插入含换行文本', () => {
    expect(insertAt('ab', 1, 'X\nY')).toEqual({ value: 'aX\nYb', cursor: 4 });
  });

  it('光标越界收敛到两端', () => {
    expect(insertAt('ab', 99, 'c')).toEqual({ value: 'abc', cursor: 3 });
    expect(insertAt('ab', -1, 'c')).toEqual({ value: 'cab', cursor: 1 });
  });
});

describe('cursorToLineCol（光标行列换算）', () => {
  it('按光标索引换算行列', () => {
    expect(cursorToLineCol('a\nbc', 0)).toEqual({ line: 0, col: 0 });
    expect(cursorToLineCol('a\nbc', 2)).toEqual({ line: 1, col: 0 });
    expect(cursorToLineCol('a\nbc', 3)).toEqual({ line: 1, col: 1 });
  });

  it('光标越界收敛到末尾', () => {
    expect(cursorToLineCol('a\nbc', 99)).toEqual({ line: 1, col: 2 });
  });
});

describe('inputWindow（多行输入可见窗口）', () => {
  it('行数不超预算时全量显示', () => {
    expect(inputWindow(3, 1, 10)).toEqual({ start: 0, end: 3, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it('超预算时窗口保持光标行可见', () => {
    const mid = inputWindow(20, 10, 5);
    expect(mid.end - mid.start).toBe(5);
    expect(mid.start <= 10 && 10 < mid.end).toBe(true);

    const top = inputWindow(20, 0, 5);
    expect(top).toEqual({ start: 0, end: 5, hiddenAbove: 0, hiddenBelow: 15 });

    const bottom = inputWindow(20, 19, 5);
    expect(bottom).toEqual({ start: 15, end: 20, hiddenAbove: 15, hiddenBelow: 0 });
  });

  it('光标行在窗口内恒成立（不变量）', () => {
    for (let cursorLine = 0; cursorLine < 50; cursorLine++) {
      const w = inputWindow(50, cursorLine, 7);
      expect(w.start <= cursorLine && cursorLine < w.end).toBe(true);
      expect(w.end - w.start).toBeLessThanOrEqual(7);
    }
  });
});

describe('paste 占位符折叠（大段粘贴）', () => {
  beforeEach(() => {
    clearPasteStore();
  });

  it('占位符格式：`[Pasted text #N +M lines]`（与 CC 一致）', () => {
    expect(formatPastePlaceholder(1, 25)).toBe('[Pasted text #1 +25 lines]');
    expect(formatPastePlaceholder(3, 20)).toBe('[Pasted text #3 +20 lines]');
  });

  it('行数阈值：19 行内联 / 20 行折叠', () => {
    expect(PASTE_COLLAPSE_THRESHOLD).toBe(20);
    const nineteen = Array.from({ length: 19 }, (_, i) => `l${i}`).join('\n');
    const twenty = nineteen + '\nl19';
    expect(shouldCollapsePaste(nineteen)).toBe(false);
    expect(shouldCollapsePaste(twenty)).toBe(true);
  });

  it('CRLF 与末尾换行归一化后不影响行数判定', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\r\n');
    expect(shouldCollapsePaste(twenty)).toBe(true);
    expect(shouldCollapsePaste(twenty + '\r\n\r\n')).toBe(true);
  });

  it('存储往返：storePasteContent 返回占位符，expandPasteTokens 还原完整内容', () => {
    const content = 'line1\nline2\nline3';
    const token = storePasteContent(content);
    expect(token).toBe('[Pasted text #1 +3 lines]');
    expect(expandPasteTokens(token)).toBe(content);
  });

  it('多 token 还原：多个占位符按位置还原，周围文本保留', () => {
    const tokenA = storePasteContent('AAA');
    const tokenB = storePasteContent('B\nB');
    const input = `before ${tokenA} middle ${tokenB} after`;
    expect(expandPasteTokens(input)).toBe('before AAA middle B\nB after');
  });

  it('未知 / 破损 token 原样保留', () => {
    expect(expandPasteTokens('[Pasted text #999 +25 lines]')).toBe('[Pasted text #999 +25 lines]');
    expect(expandPasteTokens('[Pasted text #1 +x lines]')).toBe('[Pasted text #1 +x lines]');
    expect(expandPasteTokens('plain text')).toBe('plain text');
  });

  it('clearPasteStore 清空后 token 不再还原', () => {
    const token = storePasteContent('secret');
    clearPasteStore();
    expect(expandPasteTokens(token)).toBe(token);
  });

  it('hasPastePlaceholder 判定输入中是否含占位符', () => {
    expect(hasPastePlaceholder('hello')).toBe(false);
    expect(hasPastePlaceholder('x [Pasted text #1 +25 lines] y')).toBe(true);
  });

  it('占位符内容含占位符字样时不递归展开', () => {
    const inner = '[Pasted text #2 +1 lines]';
    const token = storePasteContent(inner);
    expect(expandPasteTokens(token)).toBe(inner);
  });

  it('expandPasteTokensAt：展开并同步映射光标到内容末尾', () => {
    const content = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join('\n');
    const token = storePasteContent(content);
    // 光标在占位符末尾（粘贴后的典型位置）→ 展开后落在完整内容末尾
    const atEnd = expandPasteTokensAt(token, token.length);
    expect(atEnd.text).toBe(content);
    expect(atEnd.cursor).toBe(content.length);
  });

  it('expandPasteTokensAt：多 token + 光标在末尾 → 光标等于展开后总长', () => {
    const tokenA = storePasteContent('AAA');
    const tokenB = storePasteContent('B\nB');
    const input = `before ${tokenA} middle ${tokenB} after`;
    const r = expandPasteTokensAt(input, input.length);
    expect(r.text).toBe('before AAA middle B\nB after');
    expect(r.cursor).toBe(r.text.length);
  });

  it('expandPasteTokensAt：光标在 token 前/内分别映射', () => {
    const content = 'hello\nworld';
    const token = storePasteContent(content);
    const before = expandPasteTokensAt(`x${token}y`, 1);
    expect(before).toEqual({ text: `x${content}y`, cursor: 1 });
    // 光标落在 token 内部 → 对齐到展开后内容的末尾
    const inside = expandPasteTokensAt(token, 5);
    expect(inside.text).toBe(content);
    expect(inside.cursor).toBe(content.length);
  });

  it('expandPasteTokensAt：未知 token 原样保留、光标不变', () => {
    expect(expandPasteTokensAt('x [Pasted text #999 +25 lines] y', 5)).toEqual({
      text: 'x [Pasted text #999 +25 lines] y',
      cursor: 5,
    });
  });
});

describe('expandInputEvents（多字符输入块拆分）', () => {
  it('单字符普通按键原样透传', () => {
    expect(expandInputEvents('y', {})).toEqual([{ input: 'y', key: {} }]);
  });

  it('单字符控制键（Ink 已解析出 key）原样透传', () => {
    expect(expandInputEvents('\r', { return: true })).toEqual([{ input: '\r', key: { return: true } }]);
    expect(expandInputEvents('c', { ctrl: true })).toEqual([{ input: 'c', key: { ctrl: true } }]);
    expect(expandInputEvents('\x1b', { escape: true })).toEqual([{ input: '\x1b', key: { escape: true } }]);
  });

  it('多字符块中的 \\r 拆成 Enter，文本合并为一段', () => {
    expect(expandInputEvents('写一个文件 b\r', {})).toEqual([
      { input: '写一个文件 b', key: {} },
      { input: '\r', key: { return: true } },
    ]);
  });

  it('连续两个回车拆成两个 Enter（双击回车不丢失）', () => {
    expect(expandInputEvents('\r\r', {})).toEqual([
      { input: '\r', key: { return: true } },
      { input: '\r', key: { return: true } },
    ]);
  });

  it('弹窗快捷键连发 y+回车 拆成两个事件', () => {
    expect(expandInputEvents('y\r', {})).toEqual([
      { input: 'y', key: {} },
      { input: '\r', key: { return: true } },
    ]);
  });

  it('\\n 视作 Enter（Windows CRLF 与换行粘贴不丢回车）', () => {
    expect(expandInputEvents('abc\r\n', {})).toEqual([
      { input: 'abc', key: {} },
      { input: '\r', key: { return: true } },
      { input: '\n', key: { return: true } },
    ]);
  });

  it('\\t 拆成 Tab，退格字节拆成 Backspace', () => {
    expect(expandInputEvents('a\tb', {})).toEqual([
      { input: 'a', key: {} },
      { input: '\t', key: { tab: true } },
      { input: 'b', key: {} },
    ]);
    expect(expandInputEvents('a\x7fb', {})).toEqual([
      { input: 'a', key: {} },
      { input: '\x7f', key: { backspace: true } },
      { input: 'b', key: {} },
    ]);
  });

  it('块内残缺 ESC 与未知控制字符忽略，其余文本保留', () => {
    expect(expandInputEvents('a\x1bb', {})).toEqual([{ input: 'ab', key: {} }]);
    expect(expandInputEvents('a\x01b', {})).toEqual([{ input: 'ab', key: {} }]);
  });

  it('无控制字符的多字符块合并为单个文本事件（粘贴不回归）', () => {
    expect(expandInputEvents('hello world', {})).toEqual([{ input: 'hello world', key: {} }]);
  });

  it('多行粘贴块（中间含换行）→ 单个文本事件保留换行，不拆 Enter', () => {
    expect(expandInputEvents('const a = 1;\nconst b = 2;\n', {})).toEqual([
      { input: 'const a = 1;\nconst b = 2;', key: {} },
    ]);
    expect(expandInputEvents('a\r\nb', {})).toEqual([{ input: 'a\nb', key: {} }]);
  });

  it('单末尾换行仍是回车（打字+回车连发 / 单行粘贴带换行的旧语义不回归）', () => {
    expect(expandInputEvents('abc\r\n', {})).toEqual([
      { input: 'abc', key: {} },
      { input: '\r', key: { return: true } },
      { input: '\n', key: { return: true } },
    ]);
  });
});

// ===== 输入行水平开窗（Windows 左移修复：帧内消灭超宽行） =====

describe('displayCol（码元列 → 显示列）', () => {
  it('ASCII：码元列即显示列，越界收敛', () => {
    expect(displayCol('abc', 0)).toBe(0);
    expect(displayCol('abc', 2)).toBe(2);
    expect(displayCol('abc', 3)).toBe(3);
    expect(displayCol('abc', 99)).toBe(3);
    expect(displayCol('abc', -1)).toBe(0);
  });

  it('CJK 按 2 列计', () => {
    expect(displayCol('中a中', 1)).toBe(2); // 光标在「中」之后
    expect(displayCol('中a中', 2)).toBe(3); // 光标在 a 之后
    expect(displayCol('中a中', 3)).toBe(5);
  });

  it('emoji 代理对不拆开：光标落在对中间时收敛到对首', () => {
    // 'a😀b' 码元：a=0，😀=1..2，b=3
    expect(displayCol('a😀b', 3)).toBe(3); // displayWidth('a😀') = 1+2
    expect(displayCol('a😀b', 2)).toBe(1); // 落对中间 → 收敛
  });

  it('ZWJ 表情序列与组合字符不占列', () => {
    // 👨(2)+ZWJ(0)+👩(2)+ZWJ(0)+👧(2) = 6
    expect(displayCol('👨‍👩‍👧x', 8)).toBe(6);
    expect(displayCol('éa', 2)).toBe(1); // e+组合符 = 1 列
  });
});

describe('sliceToDisplayWidth（按显示列切子串）', () => {
  it('ASCII 区间切片返回子串与码元区间', () => {
    expect(sliceToDisplayWidth('abcdef', 1, 3)).toEqual({ text: 'bcd', start: 1, end: 4 });
  });

  it('width ≤ 0 / startCol 超行宽返回空', () => {
    expect(sliceToDisplayWidth('abc', 0, 0).text).toBe('');
    expect(sliceToDisplayWidth('abc', 99, 3).text).toBe('');
  });

  it('CJK 半宽切割：不产出半个字符', () => {
    const r = sliceToDisplayWidth('中abc', 0, 3);
    expect(r.text).toBe('中a'); // 中=2 列 + a=1 列
    expect(r).toEqual({ text: '中a', start: 0, end: 2 });
    expect(displayWidth(r.text)).toBeLessThanOrEqual(3);
  });

  it('startCol 落在宽字符中间 → 跳过整个字符', () => {
    // 中 占列 0-1，startCol=1 落在其中 → 整体跳过；a/b/c 在列 2/3/4，全在窗口 [1,5) 内
    expect(sliceToDisplayWidth('中abc', 1, 4)).toEqual({ text: 'abc', start: 1, end: 4 });
    // 窗口 [1,3) 只含列 2 → 仅 a
    expect(sliceToDisplayWidth('中abc', 1, 2)).toEqual({ text: 'a', start: 1, end: 2 });
  });

  it('窗口末尾宽字符必须整体装下，否则停止（不越预算）', () => {
    // 😀 占 2 列，窗口 [0,2) 装不下 → 停在 a
    expect(sliceToDisplayWidth('a😀b', 0, 2)).toEqual({ text: 'a', start: 0, end: 1 });
    // 2 列预算恰好装下 CJK 一个字
    expect(sliceToDisplayWidth('中a', 0, 2)).toEqual({ text: '中', start: 0, end: 1 });
  });

  it('emoji 代理对边界：不产出孤立代理字符', () => {
    const r = sliceToDisplayWidth('a😀b', 0, 2);
    expect(r.text).toBe('a');
    expect(r.end).toBe(1);
    for (const cp of [...r.text]) {
      expect(cp >= '\uD800' && cp <= '\uDFFF').toBe(false);
    }
  });

  it('组合符跟随已包含的基字（0 宽不占预算）', () => {
    expect(sliceToDisplayWidth('éa', 0, 2).text).toBe('éa');
  });

  it('从中间起步（startCol > 0）', () => {
    expect(sliceToDisplayWidth('abcdef', 2, 2)).toEqual({ text: 'cd', start: 2, end: 4 });
  });
});

describe('inputWindowH（输入行水平可见窗口）', () => {
  it('行宽不超窗口时全量显示', () => {
    expect(inputWindowH(5, 2, 10)).toEqual({ start: 0, end: 5, hiddenLeft: 0, hiddenRight: 0 });
  });

  it('超宽时窗口居中且光标列可见，两端钳制', () => {
    const mid = inputWindowH(50, 25, 10);
    expect(mid.end - mid.start).toBe(10);
    expect(mid.start <= 25 && 25 < mid.end).toBe(true);

    const top = inputWindowH(50, 0, 10);
    expect(top).toEqual({ start: 0, end: 10, hiddenLeft: 0, hiddenRight: 40 });

    const bottom = inputWindowH(50, 50, 10);
    expect(bottom).toEqual({ start: 40, end: 50, hiddenLeft: 40, hiddenRight: 0 });
  });

  it('光标列在窗口内恒成立（不变量，穷举）', () => {
    for (let lineWidth = 0; lineWidth <= 40; lineWidth++) {
      for (let cur = 0; cur <= lineWidth; cur++) {
        for (let winWidth = 1; winWidth <= 12; winWidth++) {
          const hw = inputWindowH(lineWidth, cur, winWidth);
          const ok =
            hw.end - hw.start <= winWidth &&
            (lineWidth === 0 || (hw.start <= cur && cur <= hw.end)) &&
            hw.hiddenLeft === hw.start &&
            hw.hiddenRight === lineWidth - hw.end;
          expect(ok).toBe(true);
        }
      }
    }
  });

  it('winWidth ≤ 0 退化为 1 列窗口', () => {
    const hw = inputWindowH(10, 5, 0);
    expect(hw.end - hw.start).toBe(1);
    expect(hw.start <= 5 && 5 <= hw.end).toBe(true);
  });
});

describe('I2：光标行渲染总宽 ≤ w−1（组合不变量，语料穷举）', () => {
  // 与 InputBox 渲染接线一致的预算公式（PROMPT 3 列 + █ 1 列 + 指示符 1 列）
  const PROMPT_W = 3;
  const CURSOR_W = 1;
  const corpus = [
    '中'.repeat(80),
    '😀'.repeat(40),
    'é'.repeat(100),
    '中a😀é'.repeat(20),
    'a'.repeat(300),
    '',
    'a',
  ];

  it('任意光标位置 × 终端宽度组合：总宽 ≤ w−1 且光标可见', () => {
    for (const line of corpus) {
      const lineW = displayWidth(line);
      for (const w of [10, 20, 60, 193]) {
        for (const cur of [0, 1, Math.floor(line.length / 2), line.length]) {
          const curD = displayCol(line, cur);
          let budget = Math.max(1, w - 1 - PROMPT_W - CURSOR_W);
          if (lineW > budget) budget = Math.max(1, budget - 2); // 预留左指示符（GBK 下 … 占 2 列）
          const hw = inputWindowH(lineW, curD, budget);
          const left = sliceToDisplayWidth(line, hw.start, curD - hw.start);
          const right = sliceToDisplayWidth(line, curD, hw.end - curD);
          const total =
            PROMPT_W + (hw.hiddenLeft > 0 ? 1 : 0) +
            displayWidth(left.text) + CURSOR_W + displayWidth(right.text);
          expect(total).toBeLessThanOrEqual(w - 1);
          const cursorCol = hw.start + displayWidth(left.text);
          expect(cursorCol).toBeGreaterThanOrEqual(hw.start);
          expect(cursorCol).toBeLessThanOrEqual(hw.end);
        }
      }
    }
  });
});
