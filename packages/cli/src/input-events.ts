/**
 * Ink 输入事件展开。
 *
 * Ink 7 对同一块到达的多个字符（含 \r\n、\t 等控制字符）只按一次 paste 事件送达
 * （key.return 恒为 false），导致快速键入/粘贴时「文本+回车」「y+回车」「双击回车」
 * 里的回车被当成字面文本追加，界面看起来像挂起（回车永不生效）。
 * 本模块把多字符块拆成独立按键事件，恢复 \r\n=Enter、\t=Tab、退格=Backspace 语义。
 */

import { displayWidth } from './markdown-utils.js';

/** 简化的按键标志（Ink key 对象的子集） */
export interface ExpandedKey {
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
}

export interface InputEvent {
  input: string;
  key: ExpandedKey;
}

/** 粘贴文本归一化：CRLF/LF 统一为 LF，去掉末尾换行（剪贴板常见残留） */
export function normalizePastedText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

// ===== 大段粘贴折叠（对齐 Claude Code CLI）=====

/** 折叠阈值：粘贴行数 ≥ 20 折叠为占位符（与 CC 默认一致；v1 不加 config 项） */
export const PASTE_COLLAPSE_THRESHOLD = 20;

/** 占位符匹配：`[Pasted text #N]` 或 `[Pasted text #N +M lines]`（未知/破损 token 不匹配则原样保留） */
const PASTE_PLACEHOLDER_RE = /\[Pasted text #(\d+)(?: \+(\d+) lines)?\]/g;

/** 进程内 paste 存储：占位符 token → 完整内容（session 级，不落盘，提交后 / /clear 清空） */
const pasteStore = new Map<string, string>();
let pasteIdCounter = 0;

/** 生成占位符文本：`[Pasted text #N +M lines]`（与 Claude Code 一致） */
export function formatPastePlaceholder(index: number, lineCount: number): string {
  return `[Pasted text #${index} +${lineCount} lines]`;
}

/** 是否折叠：归一化后行数 ≥ PASTE_COLLAPSE_THRESHOLD */
export function shouldCollapsePaste(text: string): boolean {
  return normalizePastedText(text).split('\n').length >= PASTE_COLLAPSE_THRESHOLD;
}

/** 完整内容入存储，返回可插入输入框的占位符 token */
export function storePasteContent(content: string): string {
  const id = ++pasteIdCounter;
  const token = formatPastePlaceholder(id, content.split('\n').length);
  pasteStore.set(token, content);
  return token;
}

/** 输入中是否已含 paste 占位符（用于「再粘贴一次展开」判定） */
export function hasPastePlaceholder(text: string): boolean {
  return text.match(PASTE_PLACEHOLDER_RE) !== null;
}

/**
 * 还原输入中的全部占位符为完整内容；未知/破损 token 原样保留。
 * 逆序替换保证前序 match 偏移在替换后依然有效（占位符内容里的占位符字样不会被二次展开）。
 */
export function expandPasteTokens(text: string): string {
  const refs = [...text.matchAll(PASTE_PLACEHOLDER_RE)];
  if (refs.length === 0) return text;
  let expanded = text;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!;
    const content = pasteStore.get(ref[0]);
    if (content === undefined) continue;
    expanded =
      expanded.slice(0, ref.index) +
      content +
      expanded.slice(ref.index + ref[0].length);
  }
  return expanded;
}

/**
 * 展开占位符并同步映射光标位置（占位符长度 ≠ 内容长度，直接沿用旧光标会落到内容中间）。
 * 逆序处理：右侧先展开，左侧 ref 的 index 与光标坐标保持一致；光标落在 token 内时对齐到展开后内容末尾。
 */
export function expandPasteTokensAt(
  text: string,
  cursor: number,
): { text: string; cursor: number } {
  const refs = [...text.matchAll(PASTE_PLACEHOLDER_RE)];
  if (refs.length === 0) return { text, cursor };
  let expanded = text;
  let newCursor = Math.max(0, Math.min(cursor, text.length));
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!;
    const content = pasteStore.get(ref[0]);
    if (content === undefined) continue;
    const refEnd = ref.index + ref[0].length;
    const delta = content.length - ref[0].length;
    if (newCursor > ref.index) {
      newCursor =
        newCursor >= refEnd
          ? newCursor + delta
          : ref.index + content.length;
    }
    expanded =
      expanded.slice(0, ref.index) +
      content +
      expanded.slice(refEnd);
  }
  return { text: expanded, cursor: newCursor };
}

/** 清空 paste 存储（Enter 提交后 / `/clear` 时调用） */
export function clearPasteStore(): void {
  pasteStore.clear();
}

/** 在 value 的光标处插入文本（含换行），返回新 value 与光标位置 */
export function insertAt(
  value: string,
  cursor: number,
  text: string,
): { value: string; cursor: number } {
  const c = Math.max(0, Math.min(cursor, value.length));
  return {
    value: value.slice(0, c) + text + value.slice(c),
    cursor: c + text.length,
  };
}

/** 光标索引 → (行, 列)，越界收敛到末尾 */
export function cursorToLineCol(
  value: string,
  cursor: number,
): { line: number; col: number } {
  const c = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, c);
  const lines = before.split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1].length };
}

export interface InputWindow {
  /** 可见文本行区间 [start, end) */
  start: number;
  end: number;
  /** 窗口外被隐藏的行数（上/下） */
  hiddenAbove: number;
  hiddenBelow: number;
}

/**
 * 多行输入的可见窗口：最多 maxLines 行，窗口尽量居中且保证光标行可见。
 * 行数不超预算时全量显示；超预算时窗口贴近光标行。
 */
export function inputWindow(
  lineCount: number,
  cursorLine: number,
  maxLines: number,
): InputWindow {
  const total = Math.max(1, maxLines);
  let start = cursorLine - Math.floor((total - 1) / 2);
  start = Math.max(0, Math.min(start, Math.max(0, lineCount - total)));
  const end = Math.min(lineCount, start + total);
  return {
    start,
    end,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, lineCount - end),
  };
}

// ===== 输入行水平开窗（Windows 左移修复：帧内消灭一切宽度 ≥ w 的行） =====

/** 码元列 → 该前缀的显示列（displayWidth 累计）；光标落在代理对中间时收敛到对首 */
export function displayCol(line: string, codeUnitCol: number): number {
  let end = Math.max(0, Math.min(codeUnitCol, line.length));
  // 光标落在代理对中间（end 指向低代理）→ 收敛到对首，不把 emoji 拆成半截
  if (end > 0 && end < line.length) {
    const prev = line.charCodeAt(end - 1);
    const next = line.charCodeAt(end);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end -= 1;
    }
  }
  return displayWidth(line.slice(0, end));
}

export interface InputWindowH {
  /** 可见显示列区间 [start, end) */
  start: number;
  end: number;
  /** 窗口左侧被隐藏的列数 */
  hiddenLeft: number;
  /** 窗口右侧被隐藏的列数 */
  hiddenRight: number;
}

/**
 * 输入行水平可见窗口：最多 winWidth 列，窗口尽量居中且保证光标显示列可见
 * （镜像 inputWindow 的居中+钳制模式）。
 */
export function inputWindowH(
  lineWidth: number,
  cursorCol: number,
  winWidth: number,
): InputWindowH {
  const w = Math.max(1, Math.floor(winWidth));
  const total = Math.max(0, Math.floor(lineWidth));
  const cur = Math.max(0, Math.min(Math.floor(cursorCol), total));
  let start = cur - Math.floor((w - 1) / 2);
  start = Math.max(0, Math.min(start, Math.max(0, total - w)));
  const end = Math.min(total, start + w);
  return {
    start,
    end,
    hiddenLeft: start,
    hiddenRight: Math.max(0, total - end),
  };
}

/**
 * 按显示列区间 [startCol, startCol+width) 切取子串：
 * - 码点边界切割，绝不拆开代理对 / 宽字符；
 * - 0 宽字符（组合符/ZWJ/VS）跟随已包含的基字，不占预算；
 * - width ≤ 0 或 startCol 超出行宽时返回空串。
 * 返回码元起止区间，供调用方核算实际渲染宽度。
 */
export function sliceToDisplayWidth(
  line: string,
  startCol: number,
  width: number,
): { text: string; start: number; end: number } {
  const empty = { text: '', start: line.length, end: line.length };
  if (width <= 0) return empty;
  const startCol0 = Math.max(0, startCol);
  const endCol = startCol0 + width;
  let cur = 0; // 当前显示列
  let cu = 0; // 当前码元的码元偏移
  let sliceStart = -1; // 首个被包含码元的码元偏移
  for (const ch of line) {
    const cw = displayWidth(ch);
    const chStart = cur;
    if (sliceStart < 0) {
      // 尚未进入窗口：起点在窗口左缘之前的字符整体跳过（含跨缘宽字符与
      // 紧邻被跳过基字的 0 宽字符），不渲染半截
      if (chStart < startCol0 || (cw === 0 && chStart === startCol0)) {
        cur += cw;
        cu += ch.length;
        continue;
      }
      sliceStart = cu;
    } else if (cw === 0) {
      // 0 宽字符跟随已包含的基字，不占预算
      cu += ch.length;
      continue;
    }
    // 字符必须整体装进窗口（起点在窗口内且终点不越界），否则停止——不跳过
    // 中间字符、不渲染半截，保证切片显示宽 ≤ width
    if (cur + cw > endCol) break;
    cur += cw;
    cu += ch.length;
  }
  if (sliceStart < 0) return empty;
  return { text: line.slice(sliceStart, cu), start: sliceStart, end: cu };
}

function keyForControlChar(ch: string): ExpandedKey {
  if (ch === '\r' || ch === '\n') return { return: true };
  if (ch === '\t') return { tab: true };
  if (ch === '\x7f' || ch === '\x08') return { backspace: true };
  return {};
}

function isControlChar(ch: string): boolean {
  return ch === '\r' || ch === '\n' || ch === '\t' || ch === '\x7f' || ch === '\x08';
}

/**
 * 多行粘贴判定：去掉末尾换行后中间仍含换行 → 必为粘贴（打字不可能在中间产生换行）。
 * 这类块整体作为文本事件返回（保留换行），不再把换行拆成回车触发提交。
 */
function hasEmbeddedLineBreak(input: string): boolean {
  return /[\r\n]/.test(input.replace(/(?:\r\n|\r|\n)+$/, ''));
}

/**
 * 把一次 useInput 回调的 (input, key) 展开为独立按键事件序列。
 * - 单字符或 Ink 已解析出按键语义的（key.return/escape/ctrl 等）→ 原样返回单个事件；
 * - 多字符块 → 逐字符拆分：\r\n=Enter、\t=Tab、退格=Backspace，
 *   残缺 ESC 与其他未知控制字符忽略，连续可打印文本合并为一段；
 * - 多行粘贴块（中间含换行）→ 整体作为单个文本事件（保留换行，不触发 Enter）。
 */
export function expandInputEvents(input: string, key: ExpandedKey): InputEvent[] {
  const hasKeySemantics =
    key.return || key.escape || key.tab || key.backspace || key.delete ||
    key.ctrl || key.meta || key.upArrow || key.downArrow ||
    key.leftArrow || key.rightArrow || key.home || key.end;

  if (input.length <= 1 || hasKeySemantics) {
    return [{ input, key }];
  }

  // 不支持 bracketed paste 的终端兜底：多行粘贴整块作为文本插入，不拆回车
  if (hasEmbeddedLineBreak(input)) {
    return [{ input: normalizePastedText(input), key: {} }];
  }

  const events: InputEvent[] = [];
  let text = '';
  const flushText = () => {
    if (text) {
      events.push({ input: text, key: {} });
      text = '';
    }
  };

  for (const ch of input) {
    if (isControlChar(ch)) {
      flushText();
      events.push({ input: ch, key: keyForControlChar(ch) });
    } else if (ch === '\x1b' || ch <= '\x1f') {
      // 残缺 ESC 序列起始字节 / 其他未知控制字符：丢弃，文本段保持连续
      continue;
    } else {
      text += ch;
    }
  }
  flushText();

  return events.length > 0 ? events : [{ input, key }];
}
