/**
 * 流式文本拆分 — 已完成的整行进入终端回滚区（<Static>），
 * 未完成的一行留在动态区实时刷新。
 */

import { displayWidth } from './markdown-utils.js';

/**
 * 把累积的流式文本拆成「已完成整行」+「未完成 tail」。
 * 统一处理 \r\n / \r 换行（Windows 流）。
 */
export function splitStreaming(text: string): { completed: string[]; tail: string } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  const tail = parts.pop() ?? '';
  return { completed: parts, tail };
}

/**
 * 单行截断：超过 maxWidth 时截断并追加 …。
 * 按**显示宽度**截断（CJK 全角算 2 格），保证动态区单行不折行、
 * 不因超长行把动态帧撑高（帧高硬规则：≤ rows-1）。
 */
export function capLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (maxWidth === 1) return '…';
  if (displayWidth(text) <= maxWidth) return text;
  let width = 0;
  let out = '';
  for (const ch of Array.from(text)) {
    const cw = displayWidth(ch);
    if (width + cw > maxWidth - 1) break; // 预留 1 格给 …
    out += ch;
    width += cw;
  }
  return out + '…';
}
