/**
 * markdown-utils.ts — 纯 markdown 辅助函数（无 React/Ink 依赖，可单测）
 *
 * 提供：显示宽度计算、表格识别/对齐、数学公式 Unicode 可读化、行内解析。
 * MessageItem 保持现有"逐行渲染 React 节点"的结构，仅消费这里的纯逻辑。
 */

// ===== 显示宽度 =====

const WIDE_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u231A-\u231B\u23E9-\u23F3\u2600-\u27BF\u2B00-\u2BFF\u2103\u2109\u{1F000}-\u{1FAFF}]/u;
const COMBINING_RE = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/;
/** 零宽字符：ZWJ（表情序列连接符）、变体选择符 VS15/VS16 */
const ZERO_WIDTH_RE = /[\u200D\uFE0E-\uFE0F]/;

/** 字符串在终端中的显示宽度（宽字符按 2 列计） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0) continue;
    if (ZERO_WIDTH_RE.test(ch)) continue;
    if (COMBINING_RE.test(ch)) continue;
    if (code > 0xffff || WIDE_RE.test(ch)) w += 2;
    else w += 1;
  }
  return w;
}

// ===== 行内解析 =====

export type InlineType = 'text' | 'code' | 'bold' | 'italic' | 'math' | 'link' | 'strike' | 'image';

export interface InlineToken {
  type: InlineType;
  text: string;
  url?: string;
}

/**
 * 反引号配平检测：奇数个反引号视为存在未闭合的行内代码 span（可能跨行）。
 * 供渲染路径在「按行切分」前判断是否需要跨行合并（parseInline 本身支持跨行 span）。
 */
export function hasUnclosedBacktick(text: string): boolean {
  let count = 0;
  for (const ch of text) {
    if (ch === '`') count++;
  }
  return count % 2 === 1;
}

/** 数学公式：去掉 $$/$ 定界符，常用 LaTeX 命令转 Unicode */
export function mathToUnicode(tex: string): string {
  let s = tex.trim();
  // 去掉块级/行内定界符
  s = s.replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();

  // 带花括号的结构
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a: string, b: string) => `(${a}/${b})`);
  s = s.replace(/\\frac\s+([^\s\\{}]+)\s+([^\s\\{}]+)/g, (_m, a: string, b: string) => `(${a}/${b})`);
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, x: string) => `√(${x})`);
  s = s.replace(
    /\\(?:text|mathrm|mathbf|mathit|operatorname|mathbb|mathcal|mathscr|mathfrak|mathsf|boldsymbol|bm)\s*\{([^{}]*)\}/g,
    (_m, x: string) => x,
  );
  s = s.replace(/\\(?:hat|bar|tilde|vec|dot|ddot)\s*\{([^{}]*)\}/g, (_m, x: string) => x);
  s = s.replace(/\\(?:hat|bar|tilde|vec)\s+([a-zA-Z])/g, (_m, x: string) => x);

  // 括号与定界符
  s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '');
  s = s.replace(/\\\{/g, '{').replace(/\\\}/g, '}').replace(/\\\|/g, '|').replace(/\\_/g, '_').replace(/\\%/g, '%');

  // 空白控制
  s = s.replace(/\\(?:,|:|;|!|quad|qquad|enspace)/g, ' ');

  // 常用符号
  const SYMBOLS: Array<[RegExp, string]> = [
    [/\\sum/g, '∑'], [/\\prod/g, '∏'], [/\\int/g, '∫'], [/\\iint/g, '∬'],
    [/\\infty/g, '∞'], [/\\cdot/g, '·'], [/\\times/g, '×'], [/\\pm/g, '±'],
    [/\\leq/g, '≤'], [/\\geq/g, '≥'], [/\\neq/g, '≠'], [/\\approx/g, '≈'],
    [/\\rightarrow/g, '→'], [/\\Rightarrow/g, '⇒'], [/\\leftarrow/g, '←'],
    [/\\Leftarrow/g, '⇐'], [/\\leftrightarrow/g, '↔'], [/\\Leftrightarrow/g, '⇔'],
    [/\\mapsto/g, '↦'], [/\\to\b/g, '→'], [/\\lvert/g, '|'], [/\\rvert/g, '|'],
    [/\\dots/g, '…'], [/\\ldots/g, '…'], [/\\cdots/g, '⋯'],
    [/\\forall/g, '∀'], [/\\exists/g, '∃'], [/\\in\b/g, '∈'], [/\\notin/g, '∉'],
    [/\\subset/g, '⊂'], [/\\subseteq/g, '⊆'], [/\\cup/g, '∪'], [/\\cap/g, '∩'],
    [/\\nabla/g, '∇'], [/\\partial/g, '∂'], [/\\sqrt/g, '√'], [/\\angle/g, '∠'],
    [/\\degree/g, '°'], [/\\circ/g, '∘'],
    [/\\pi/g, 'π'], [/\\theta/g, 'θ'], [/\\omega/g, 'ω'], [/\\alpha/g, 'α'],
    [/\\beta/g, 'β'], [/\\gamma/g, 'γ'], [/\\delta/g, 'δ'], [/\\lambda/g, 'λ'],
    [/\\mu/g, 'μ'], [/\\sigma/g, 'σ'], [/\\phi/g, 'φ'], [/\\epsilon/g, 'ε'],
    [/\\eta/g, 'η'], [/\\tau/g, 'τ'], [/\\xi/g, 'ξ'], [/\\zeta/g, 'ζ'],
    [/\\Gamma/g, 'Γ'], [/\\Delta/g, 'Δ'], [/\\Theta/g, 'Θ'], [/\\Lambda/g, 'Λ'],
    [/\\Sigma/g, 'Σ'], [/\\Phi/g, 'Φ'], [/\\Omega/g, 'Ω'],
  ];
  for (const [re, sym] of SYMBOLS) s = s.replace(re, sym);

  // 剩余未知命令：去掉反斜杠保留单词（\sin → sin）
  s = s.replace(/\\([a-zA-Z]+)/g, (_m, name: string) => name);
  // 规整连续空格（控制符号转换后可能产生多余空格）
  s = s.replace(/ {2,}/g, ' ');
  return s;
}

/** 行内 markdown → token 数组 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let remaining = text;
  let lastPlain = '';

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    const mathMatch = remaining.match(/\$([^$\n]+?)\$/);
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    const strikeMatch = remaining.match(/~~([^~]+)~~/);
    const italicMatch = remaining.match(/(?<!\*)\*([^*]+)\*(?!\*)/);
    const imageMatch = remaining.match(/!\[([^\]]+)\]\(([^)\s]+)\)/);
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)\s]+)\)/);

    let earliest: { idx: number; token: InlineToken; full: string } | null = null;
    const better = (idx: number | undefined): boolean =>
      idx !== undefined && (earliest === null || idx < earliest.idx);

    if (codeMatch && better(codeMatch.index)) {
      earliest = { idx: codeMatch.index!, token: { type: 'code', text: codeMatch[1] }, full: codeMatch[0] };
    }
    if (mathMatch) {
      const inner = mathMatch[1];
      const valid = inner.length > 0 && !inner.startsWith(' ') && !inner.endsWith(' ') &&
        (!inner.includes(' ') || inner.includes('\\'));
      if (valid && better(mathMatch.index)) {
        earliest = { idx: mathMatch.index!, token: { type: 'math', text: mathToUnicode(inner) }, full: mathMatch[0] };
      }
    }
    if (boldMatch && better(boldMatch.index)) {
      earliest = { idx: boldMatch.index!, token: { type: 'bold', text: boldMatch[1] }, full: boldMatch[0] };
    }
    if (strikeMatch && better(strikeMatch.index)) {
      earliest = { idx: strikeMatch.index!, token: { type: 'strike', text: strikeMatch[1] }, full: strikeMatch[0] };
    }
    if (italicMatch && better(italicMatch.index)) {
      earliest = { idx: italicMatch.index!, token: { type: 'italic', text: italicMatch[1] }, full: italicMatch[0] };
    }
    if (imageMatch && better(imageMatch.index)) {
      earliest = {
        idx: imageMatch.index!,
        token: { type: 'image', text: imageMatch[1], url: imageMatch[2] },
        full: imageMatch[0],
      };
    }
    if (linkMatch && better(linkMatch.index)) {
      earliest = {
        idx: linkMatch.index!,
        token: { type: 'link', text: linkMatch[1], url: linkMatch[2] },
        full: linkMatch[0],
      };
    }

    if (!earliest) {
      lastPlain += remaining;
      break;
    }

    lastPlain += remaining.slice(0, earliest.idx);
    if (lastPlain) {
      tokens.push({ type: 'text', text: lastPlain });
      lastPlain = '';
    }
    tokens.push(earliest.token);
    remaining = remaining.slice(earliest.idx + earliest.full.length);
  }

  if (lastPlain) tokens.push({ type: 'text', text: lastPlain });
  if (tokens.length === 0) tokens.push({ type: 'text', text });
  return tokens;
}

/** 去除行内 markdown 符号 → 纯文本（用于引用、表格列宽计算） */
export function stripInlineMarkdown(text: string): string {
  return parseInline(text).map(t => t.text).join('');
}

/** 仅转换数学跨度（$...$ → Unicode 可读化），保留加粗/代码等标记（用于表格单元格先转换再折行） */
export function convertMathSpans(text: string): string {
  return text.replace(/\$([^$\n]+?)\$/g, (m, inner: string) => {
    const valid = inner.length > 0 && !inner.startsWith(' ') && !inner.endsWith(' ') &&
      (!inner.includes(' ') || inner.includes('\\'));
    return valid ? mathToUnicode(m) : m;
  });
}

// ===== 表格 =====

/** 管道行：以 | 开头且至少两列 */
export function isPipeRow(line: string | undefined): boolean {
  if (!line) return false;
  const s = line.trim();
  if (!s.startsWith('|') || s.length < 3) return false;
  return splitPipeRow(s).length >= 2;
}

/** 分隔行：| --- | --- | */
export function isSeparatorRow(line: string | undefined): boolean {
  if (!line) return false;
  const s = line.trim();
  if (!s.includes('|')) return false;
  const cells = splitPipeRow(s);
  if (cells.length < 2) return false;
  return cells.every(cell => /^:?-{1,}:?$/.test(cell.trim()));
}

/** 管道行 → 单元格文本数组（去掉首尾 | 并 trim；数学 $...$ / 行内代码 `...` 内的 | 不拆分） */
export function splitPipeRow(line: string): string[] {
  const s = line.trim();
  const inner = s.startsWith('|') ? s.slice(1) : s;
  const withoutEnd = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  const cells: string[] = [];
  let cur = '';
  let inMath = false;
  let inCode = false;
  for (const ch of withoutEnd) {
    if (ch === '`' && !inMath) inCode = !inCode;
    else if (ch === '$' && !inCode) inMath = !inMath;
    if (ch === '|' && !inMath && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * 按显示宽度换行：优先在数学/代码跨度之外的空格断行；无外部断点时硬断。
 * 加粗 **...** 作为不可拆的原子单元：`**` 标记零宽、单元内部不折行，
 * 避免窄列把 "**0**" 拆成 "**" / "0*" / "*" 之类的裸标记碎片。
 * 行内代码 `...` 同样作为原子单元：拆开的片段各自过 renderInlineMd 时
 * 反引号永远配不成对 → 原样显示（日志复现：表格单元格被窄列从代码
 * span 中间切开，`src/modules/tls/mod.rs` 残留裸反引号）。
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);

  // 预切分：加粗/行内代码跨度整体成原子单元（宽度=内部文本显示宽度，标记零宽），
  // 其余按字符流
  const items: Array<{ atomic: boolean; text: string; width?: number }> = [];
  for (let i = 0; i < text.length; i++) {
    // 行内代码 `...`：找配对的收尾反引号，整段作为原子单元
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        items.push({ atomic: true, text: '`' + inner + '`', width: displayWidth(inner) });
        i = end;
        continue;
      }
    }
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        items.push({ atomic: true, text: '**' + inner + '**', width: displayWidth(inner) });
        i = end + 1;
        continue;
      }
    }
    items.push({ atomic: false, text: text[i] });
  }

  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  let breakIdx = -1;
  let inMath = false;
  let inCode = false;

  const scanBreaks = (s: string): number => {
    let m = false;
    let c = false;
    let last = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '`' && !m) c = !c;
      else if (ch === '$' && !c) m = !m;
      if (ch === ' ' && !m && !c) last = i;
    }
    return last;
  };

  for (const item of items) {
    // 加粗/行内代码原子单元：整段追加；放不下则整段换行（宁可略超宽也不拆标记）
    if (item.atomic) {
      if (cur.length > 0 && curW + item.width! > w) {
        lines.push(cur.trimEnd());
        cur = '';
        curW = 0;
        breakIdx = -1;
      }
      cur += item.text;
      curW += item.width!;
      continue;
    }

    const ch = item.text;
    const cw = displayWidth(ch);
    if (ch === '`' && !inMath) inCode = !inCode;
    else if (ch === '$' && !inCode) inMath = !inMath;

    // 断点空格：行已满时直接收行并丢弃该空格
    if (ch === ' ' && !inMath && !inCode && cur.length > 0 && curW + cw > w) {
      lines.push(cur.trimEnd());
      cur = '';
      curW = 0;
      breakIdx = -1;
      continue;
    }

    while (cur.length > 0 && curW + cw > w) {
      if (breakIdx >= 0) {
        lines.push(cur.slice(0, breakIdx).trimEnd());
        cur = cur.slice(breakIdx + 1);
        curW = 0;
        for (const r of cur) curW += displayWidth(r);
        breakIdx = scanBreaks(cur);
      } else {
        lines.push(cur.trimEnd());
        cur = '';
        curW = 0;
        breakIdx = -1;
      }
    }
    cur += ch;
    curW += cw;
    if (ch === ' ' && !inMath && !inCode) breakIdx = cur.length - 1;
  }
  if (cur.length > 0) lines.push(cur.trimEnd());
  return lines;
}

/** 计算表格各列宽度（显示宽度，按最大宽度收缩） */
export function tableColumnWidths(header: string[], rows: string[][], maxWidth: number): number[] {
  const colCount = Math.max(1, header.length);
  const widths = new Array<number>(colCount).fill(1);
  const consider = (cells: string[]) => {
    for (let c = 0; c < colCount; c++) {
      const w = displayWidth(stripInlineMarkdown(cells[c] || ''));
      if (w > widths[c]) widths[c] = w;
    }
  };
  consider(header);
  rows.forEach(consider);

  // Codex 风格：无内边距、无外框，列间固定 2 空格分隔 → 开销 = 2*(colCount-1)
  const overhead = 2 * (colCount - 1);
  const available = Math.max(colCount, maxWidth - overhead);
  let sum = widths.reduce((a, b) => a + b, 0);
  if (sum > available) {
    const scale = available / sum;
    // Preserve a readable share for every populated column before giving the
    // remaining space to columns with more content. Purely proportional
    // shrinking can collapse short labels to a few characters when the last
    // column contains a long explanation.
    const minimums = widths.map(width => Math.min(width, Math.max(1, Math.floor(available / colCount))));
    for (let c = 0; c < colCount; c++) widths[c] = Math.max(minimums[c], Math.floor(widths[c] * scale));
    sum = widths.reduce((a, b) => a + b, 0);
    while (sum > available) {
      let maxIdx = -1;
      for (let c = 0; c < colCount; c++) {
        if (widths[c] <= minimums[c]) continue;
        if (maxIdx === -1 || widths[c] - minimums[c] > widths[maxIdx] - minimums[maxIdx]) maxIdx = c;
      }
      if (maxIdx === -1) break;
      widths[maxIdx]--;
      sum--;
    }
  }
  return widths;
}

/** 单元格按列宽填充空格（按渲染后的纯文本宽度计） */
export function padCell(cell: string, width: number): string {
  const w = displayWidth(stripInlineMarkdown(cell));
  return w >= width ? cell : cell + ' '.repeat(width - w);
}
