import { describe, expect, it } from 'vitest';
import {
  displayWidth,
  convertMathSpans,
  hasUnclosedBacktick,
  isPipeRow,
  isSeparatorRow,
  mathToUnicode,
  padCell,
  parseInline,
  splitPipeRow,
  stripInlineMarkdown,
  tableColumnWidths,
  wrapText,
} from '../markdown-utils.js';

describe('displayWidth', () => {
  it('ASCII 按 1 列计', () => {
    expect(displayWidth('abc')).toBe(3);
  });

  it('CJK / 全角按 2 列计', () => {
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('ＡＢ')).toBe(4);
  });

  it('emoji 按 2 列计', () => {
    expect(displayWidth('😀')).toBe(2);
  });

  it('⏳⭐⬛⌚ 等 emoji 块按 2 列计（回归：曾漏算导致表格列错位）', () => {
    expect(displayWidth('⏳')).toBe(2);
    expect(displayWidth('⭐')).toBe(2);
    expect(displayWidth('⬛')).toBe(2);
    expect(displayWidth('⌚')).toBe(2);
    expect(displayWidth('⏰')).toBe(2);
  });

  it('ZWJ 与变体选择符按 0 宽计', () => {
    expect(displayWidth('❤\uFE0F')).toBe(2);           // ❤️（U+2764 + VS16）
    expect(displayWidth('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe(6); // 👨‍👩‍👧
    expect(displayWidth('☀\uFE0F')).toBe(2);           // ☀️
  });

  it('℃/℉（CJK 环境全角）按 2 列计', () => {
    expect(displayWidth('℃')).toBe(2);
    expect(displayWidth('26℃')).toBe(4);
  });

  it('组合字符不计宽', () => {
    expect(displayWidth('e\u0301')).toBe(1);
  });
});

describe('表格', () => {
  it('识别管道行与分隔行', () => {
    expect(isPipeRow('| 项目 | 详情 |')).toBe(true);
    expect(isPipeRow('|------|------|')).toBe(true);
    expect(isSeparatorRow('|------|------|')).toBe(true);
    expect(isSeparatorRow('| 项目 | 详情 |')).toBe(false);
    expect(isPipeRow('普通 | 文本')).toBe(false);
  });

  it('splitPipeRow 去首尾 | 并 trim', () => {
    expect(splitPipeRow('| **天气** | 中雨转阴 |')).toEqual(['**天气**', '中雨转阴']);
  });

  it('splitPipeRow 不拆分数学公式内的 |', () => {
    const cells = splitPipeRow('| 帕塞瓦尔定理 | $\\int |f(t)|^2 dt$ | 时域能量 = 频域能量 |');
    expect(cells.length).toBe(3);
    expect(cells[1]).toBe('$\\int |f(t)|^2 dt$');
  });

  it('splitPipeRow 不拆分行内代码内的 |', () => {
    expect(splitPipeRow('| a | `code|pipe` | b |')).toEqual(['a', '`code|pipe`', 'b']);
  });

  it('列宽按显示宽度计算并收缩到最大宽度', () => {
    const header = ['项目', '详情'];
    const rows = [['**天气**', '中雨转阴'], ['气温', '26℃ ~ 32℃'], ['风力', '<3级']];
    const widths = tableColumnWidths(header, rows, 40);
    expect(widths[0]).toBe(4); // 项目
    expect(widths[1]).toBeGreaterThanOrEqual(10); // 26℃ ~ 32℃ 等
    // 收缩：窄宽度时仍 ≥1
    const narrow = tableColumnWidths(header, rows, 10);
    expect(narrow.every(w => w >= 1)).toBe(true);
  });

  it('列宽开销公式为 2*(列数-1)（列间 2 空格，无内边距/外框）', () => {
    // 2 列、内容宽度 1+1 → 开销 2，总宽 40 时可用宽度 38
    const widths = tableColumnWidths(['a', 'b'], [['c', 'd']], 40);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(38);
    // 极窄宽度下仍 ≥1 且不溢出
    const narrow = tableColumnWidths(['a', 'b'], [['c', 'd']], 12);
    expect(narrow.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2);
    expect(narrow.every(w => w >= 1)).toBe(true);
  });

  it('长说明表格不会挤扁编号旁的任务列', () => {
    const header = ['#', '任务', '现状 / 依据'];
    const rows = [[
      '1',
      '修反代并发 keep-alive 连接池 bug',
      'wrk 并发请求出现 read/write error；串行探测正常。候选原因包括连接池争用、误复用已关闭连接和归还时机。',
    ]];
    const maxWidth = 75;
    const widths = tableColumnWidths(header, rows, maxWidth);
    const available = maxWidth - 2 * (header.length - 1);

    expect(widths[0]).toBe(1);
    expect(widths[1]).toBeGreaterThanOrEqual(Math.floor(available / header.length));
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(available);
  });

  it('padCell 按纯文本宽度填充（不含 markdown 符号）', () => {
    expect(padCell('**天气**', 4)).toBe('**天气**');
    expect(padCell('a', 3)).toBe('a  ');
    expect(padCell('中文', 4)).toBe('中文');
    expect(padCell('中文', 6)).toBe('中文  ');
  });
});

describe('mathToUnicode', () => {
  it('常见命令转 Unicode', () => {
    expect(mathToUnicode('$$\\sum_{n=0}^{N-1} x[n] \\cdot e^{-j\\frac{2\\pi}{N}kn}$$'))
      .toBe('∑_{n=0}^{N-1} x[n] · e^{-j(2π/N)kn}');
    expect(mathToUnicode('$X(f) = \\int_{-\\infty}^{+\\infty} x(t) \\, dt$'))
      .toBe('X(f) = ∫_{-∞}^{+∞} x(t) dt');
    expect(mathToUnicode('$j = \\sqrt{-1}$')).toBe('j = √(-1)');
    expect(mathToUnicode('$e^{j\\theta} = \\cos\\theta + j\\sin\\theta$'))
      .toBe('e^{jθ} = cosθ + jsinθ');
    expect(mathToUnicode('$\\pi \\approx 3.14$')).toBe('π ≈ 3.14');
  });

  it('未知命令去反斜杠保留单词', () => {
    expect(mathToUnicode('\\frac{a}{b} \\to c')).toBe('(a/b) → c');
  });

  it('大小写变体（\\Leftrightarrow / \\lvert）正确转换', () => {
    expect(mathToUnicode('$ax(t)+by(t) \\Leftrightarrow aX(\\omega)+bY(\\omega)$'))
      .toBe('ax(t)+by(t) ⇔ aX(ω)+bY(ω)');
    expect(mathToUnicode('$\\int\\lvert x(t)\\rvert^2 dt$')).toBe('∫| x(t)|^2 dt');
  });

  it('字体命令（\\mathcal 等）保留花括号内容', () => {
    expect(mathToUnicode('$\\mathcal{F}[f * g] = F(\\omega)\\cdot G(\\omega)$'))
      .toBe('F[f * g] = F(ω)· G(ω)');
  });
});

describe('wrapText', () => {
  it('空格优先断行，行满空格收行', () => {
    expect(wrapText('aa bb cc', 5)).toEqual(['aa bb', 'cc']);
    expect(wrapText('aa bbbb', 5)).toEqual(['aa', 'bbbb']);
  });

  it('CJK 按显示宽度硬断', () => {
    expect(wrapText('中文测试', 4)).toEqual(['中文', '测试']);
  });

  it('有外部断点时不在 $...$ 内拆分', () => {
    expect(wrapText('$x$ and more words', 8)).toEqual(['$x$ and', 'more', 'words']);
  });

  it('超长跨度无外部断点时硬断兜底', () => {
    expect(wrapText('$aa bb$', 6)).toEqual(['$aa bb', '$']);
  });

  it('加粗 **...** 是原子单元：窄列不拆出裸 * 标记', () => {
    expect(wrapText('**0**', 1)).toEqual(['**0**']);
    expect(wrapText('**0**', 4)).toEqual(['**0**']);
  });

  it('加粗标记零宽：列宽按内部文本计，与 stripInlineMarkdown 口径一致', () => {
    // 列宽 5（去标记 "手写 HTTP" 宽 9 > 5 时仍整段保留，不拆碎）
    const cell = '**手写 HTTP**';
    const width = displayWidth(stripInlineMarkdown(cell));
    const lines = wrapText(cell, width);
    expect(lines).toEqual([cell]);
  });

  it('加粗与普通文本混排：外部空格仍可断行', () => {
    expect(wrapText('**aa** bb cc', 7)).toEqual(['**aa** bb', 'cc']);
  });

  it('行内代码 `...` 是原子单元：窄列整段保留，不拆出裸反引号', () => {
    // 回归：表格单元格被窄列从代码 span 中间切开后，每段各自过
    // renderInlineMd 配不成对 → 原样显示反引号（2026-08-22 日志复现）
    expect(wrapText('`src/modules/tls/mod.rs`', 10))
      .toEqual(['`src/modules/tls/mod.rs`']);
    expect(wrapText('`code` and `more`', 8)).toEqual(['`code` and', '`more`']);
  });

  it('行内代码标记零宽：列宽按内部文本计', () => {
    const cell = '`h2 = "0.4"`';
    const width = displayWidth(stripInlineMarkdown(cell));
    expect(wrapText(cell, width)).toEqual([cell]);
  });
});

describe('parseInline', () => {
  it('加粗/斜体/行内代码/链接/删除线/图片', () => {
    const tokens = parseInline('a **b** c `d` e [f](https://x) g ~~h~~ i ![img](p.png) j');
    expect(tokens.map(t => t.type)).toEqual(['text', 'bold', 'text', 'code', 'text', 'link', 'text', 'strike', 'text', 'image', 'text']);
    expect(tokens.find(t => t.type === 'link')?.text).toBe('f');
    expect(tokens.find(t => t.type === 'image')?.text).toBe('img');
    expect(tokens.find(t => t.type === 'strike')?.text).toBe('h');
  });

  it('行内公式转 Unicode', () => {
    const tokens = parseInline('其中 $x(t)$ 为信号');
    const math = tokens.find(t => t.type === 'math');
    expect(math?.text).toBe('x(t)');
  });

  it('价格等普通 $ 不误判为公式', () => {
    const tokens = parseInline('价格 $5 和 $10');
    expect(tokens.every(t => t.type === 'text')).toBe(true);
  });

  it('stripInlineMarkdown 去全部符号', () => {
    expect(stripInlineMarkdown('**加粗** `code` [链接](https://x) $f$')).toBe('加粗 code 链接 f');
  });
});

describe('convertMathSpans', () => {
  it('转换 $...$ 跨度并保留加粗等标记', () => {
    expect(convertMathSpans('**加粗** $\\int |f(t)|^2 dt$ 末尾'))
      .toBe('**加粗** ∫ |f(t)|^2 dt 末尾');
  });

  it('无效 $ 跨度（价格等）保持原样', () => {
    expect(convertMathSpans('价格 $5 和 $10')).toBe('价格 $5 和 $10');
  });
});

describe('hasUnclosedBacktick（跨行行内代码 span 检测）', () => {
  it('偶数个反引号视为闭合，奇数视为未闭合', () => {
    expect(hasUnclosedBacktick('a `code` b')).toBe(false);
    expect(hasUnclosedBacktick('`code')).toBe(true);
    expect(hasUnclosedBacktick('`a\nb` c')).toBe(false);
    expect(hasUnclosedBacktick('`a\nb')).toBe(true);
    expect(hasUnclosedBacktick('``double``')).toBe(false);
  });
});
