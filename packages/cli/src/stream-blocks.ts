/**
 * stream-blocks.ts — 流式块级内容（表格 / 公式）缓冲纯函数模块（无 React/Ink 依赖，可单测）
 *
 * 逐行冻结架构下，表格/公式需要完整出现才能正确对齐与渲染：
 * 管道行先入缓冲，遇分隔行标记 confirmed；被非管道行打断时，
 * 已确认的冻结为块（assistant-block），未确认的按普通行冻结。
 * $$...$$ 同理缓冲到闭合（未闭合也按公式块输出）。
 */

import { isPipeRow, isSeparatorRow, hasUnclosedBacktick } from './markdown-utils.js';

export type BlockKind = 'table' | 'math' | 'code' | 'inline';

export interface PendingBlock {
  kind: BlockKind;
  lines: string[];
  /** 表格：是否已出现分隔行；公式：是否已闭合 */
  confirmed: boolean;
  /** 代码块：围栏语言（```lang 的 lang 部分） */
  lang?: string;
}

export type FlushItem =
  | { role: 'assistant-line'; content: string }
  | { role: 'assistant-block'; content: string; blockKind: BlockKind; lang?: string };

/** 代码围栏行：``` 或 ```lang（开/闭共用，与完成态渲染口径一致） */
function isCodeFenceLine(line: string): boolean {
  return line.trimStart().startsWith('```');
}

function isMathOpen(line: string): boolean {
  return line.trim().startsWith('$$');
}

/** 行是否闭合公式块（$$ 或 x$$ 结尾；单行 $$...$$ 由调用方先按整行闭合处理） */
function isMathClose(line: string): boolean {
  const s = line.trim();
  return s === '$$' || (s.endsWith('$$') && s.length > 4);
}

/**
 * 处理一行已完成的流式行，返回更新后的 pendingBlock 与需要冻结的条目。
 * 表格缓冲期间遇到非管道行：confirmed → 整表冻结为一个块；未 confirmed → 逐行按普通行冻结。
 */
export function ingestStreamLine(
  line: string,
  pendingBlock: PendingBlock | null,
): { pendingBlock: PendingBlock | null; flush: FlushItem[] } {
  // 代码块缓冲中：内容行入缓冲，闭合围栏 → 整块冻结（空块不输出）
  if (pendingBlock?.kind === 'code') {
    if (isCodeFenceLine(line)) {
      const block = pendingBlock;
      return {
        pendingBlock: null,
        flush: block.lines.length > 0
          ? [{ role: 'assistant-block', content: block.lines.join('\n'), blockKind: 'code', lang: block.lang }]
          : [],
      };
    }
    return { pendingBlock: { ...pendingBlock, lines: [...pendingBlock.lines, line] }, flush: [] };
  }

  // 行内代码 span 缓冲：未闭合反引号跨行，合并到闭合后整段冻结为一条 assistant-line
  if (pendingBlock?.kind === 'inline') {
    const lines = [...pendingBlock.lines, line];
    if (!hasUnclosedBacktick(lines.join('\n'))) {
      return {
        pendingBlock: null,
        flush: [{ role: 'assistant-line', content: lines.join('\n') }],
      };
    }
    return { pendingBlock: { kind: 'inline', lines, confirmed: false }, flush: [] };
  }

  // 无缓冲：开启新块或普通行
  if (!pendingBlock) {
    // 开启代码块：```lang，围栏行本身不入缓冲（lang 提取自该行）
    if (isCodeFenceLine(line)) {
      return {
        pendingBlock: { kind: 'code', lines: [], confirmed: true, lang: line.slice(3).trim() },
        flush: [],
      };
    }
    if (isMathOpen(line)) {
      // 单行 $$...$$ 已闭合 → 立即整块冻结
      if (isMathClose(line) && line.trim().length > 4) {
        return {
          pendingBlock: null,
          flush: [{ role: 'assistant-block', content: line.trim(), blockKind: 'math' }],
        };
      }
      return { pendingBlock: { kind: 'math', lines: [line], confirmed: false }, flush: [] };
    }
    if (isPipeRow(line)) {
      return { pendingBlock: { kind: 'table', lines: [line], confirmed: false }, flush: [] };
    }
    // 未闭合反引号 → 开始行内代码缓冲（跨行 span）
    if (hasUnclosedBacktick(line)) {
      return { pendingBlock: { kind: 'inline', lines: [line], confirmed: false }, flush: [] };
    }
    return { pendingBlock: null, flush: [{ role: 'assistant-line', content: line }] };
  }

  // 公式块：缓冲到闭合
  if (pendingBlock.kind === 'math') {
    pendingBlock.lines.push(line);
    if (isMathClose(line)) {
      return {
        pendingBlock: null,
        flush: [{ role: 'assistant-block', content: pendingBlock.lines.join('\n'), blockKind: 'math' }],
      };
    }
    return { pendingBlock, flush: [] };
  }

  // 表格：管道行继续入缓冲，分隔行置 confirmed
  if (isPipeRow(line)) {
    pendingBlock.lines.push(line);
    if (!pendingBlock.confirmed && isSeparatorRow(line)) {
      pendingBlock.confirmed = true;
    }
    return { pendingBlock, flush: [] };
  }

  // 非管道行打断表格：先冻结缓冲，再按普通行处理当前行
  const flushed: FlushItem[] = pendingBlock.confirmed
    ? [{ role: 'assistant-block', content: pendingBlock.lines.join('\n'), blockKind: 'table' }]
    : pendingBlock.lines.map(content => ({ role: 'assistant-line', content }));
  const rest = ingestStreamLine(line, null);
  return { pendingBlock: rest.pendingBlock, flush: [...flushed, ...rest.flush] };
}

/**
 * 消息结束/被打断时把未完成缓冲落盘：
 * 表格 confirmed → 表格块；表格未 confirmed → 普通行；公式一律按公式块输出。
 */
export function flushPendingBlock(pendingBlock: PendingBlock | null): FlushItem[] {
  if (!pendingBlock) return [];
  // 代码块：未闭合也按代码块输出（有内容才输出，空块丢弃）
  if (pendingBlock.kind === 'code') {
    if (pendingBlock.lines.length === 0) return [];
    return [{
      role: 'assistant-block',
      content: pendingBlock.lines.join('\n'),
      blockKind: 'code',
      lang: pendingBlock.lang,
    }];
  }
  if (pendingBlock.kind === 'inline') {
    // 闭合后已在 ingest 时立即冻结；走到这里说明未闭合 → 按普通行逐行冻结（保留原样）
    if (pendingBlock.confirmed) {
      return [{ role: 'assistant-line', content: pendingBlock.lines.join('\n') }];
    }
    return pendingBlock.lines.map(content => ({ role: 'assistant-line', content }));
  }
  if (pendingBlock.confirmed || pendingBlock.kind === 'math') {
    return [{
      role: 'assistant-block',
      content: pendingBlock.lines.join('\n'),
      blockKind: pendingBlock.kind,
    }];
  }
  return pendingBlock.lines.map(content => ({ role: 'assistant-line', content }));
}
