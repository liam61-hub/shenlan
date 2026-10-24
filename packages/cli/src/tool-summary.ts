/**
 * tool-summary.ts — 工具结果单行摘要（纯函数，无 React/Ink 依赖，可单测）
 *
 * 滚动区每个工具调用冻结为一行紧凑摘要，取代原来的 "一墙 ↳ 输出"：
 *   glob "**\/*.ts": 26 file(s) matched
 *   read package.json: 103 lines
 *   shell: <输出首行>
 *   agent: ✓ [目标] 摘要首行
 *   大输出（ref）：glob "**\/*.ts": 12697 chars → Ref:a05666a8
 *   错误：✖ <错误全文（折叠为一行）>
 *
 * 超长内容按显示宽度（CJK 宽字符计 2 列）截断到 MAX_WIDTH 并追加 …。
 */
import { displayWidth } from './markdown-utils.js';

export const TOOL_SUMMARY_MAX_WIDTH = 140;

/**
 * 生成工具结果的一行摘要。
 *
 * @param name    工具名（glob / search / read / write / edit / shell / agent / 其他）
 * @param detail  工具调用的关键参数（pattern / file_path / query 等，来自 getToolDetail）
 * @param content 工具返回内容（成功时为原始内容或 [Ref:xxx] 摘要；错误时为错误全文）
 * @param isError 是否错误结果（红色渲染，行首 ✖）
 */
export function formatToolSummary(
  name: string,
  detail: string,
  content: string,
  isError: boolean,
): string {
  if (isError) {
    // 错误全文保留：多行折叠为一行，再截断到一行宽
    return truncateWidth('✖ ' + collapseLines(content), TOOL_SUMMARY_MAX_WIDTH);
  }
  return truncateWidth(buildSuccessLine(name, detail, content), TOOL_SUMMARY_MAX_WIDTH);
}

/** 按显示宽度截断，末尾追加 …（保留 1 列给省略号） */
export function truncateWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function buildSuccessLine(name: string, detail: string, content: string): string {
  // 大输出已转为 ref：[Ref:xxxx] Tool <name> <detail> output (N chars)
  const refMatch = content.match(/^\[Ref:([0-9a-fA-F]{6,12})\]\s*(.*)$/);
  if (refMatch) {
    const refId = refMatch[1];
    const charsMatch = refMatch[2].match(/\((\d+)\s*chars\)/);
    const detailPart = detail ? quoteDetail(name, detail) : '';
    const count = charsMatch ? `${charsMatch[1]} chars → Ref:${refId}` : `Ref:${refId}`;
    return `${name}${detailPart}: ${count}`;
  }

  if (name === 'glob') {
    const matched = content.match(/(\d+)\s+file\(s\) matched/);
    if (matched) {
      return `${name}${quoteDetail(name, detail)}: ${matched[1]} file(s) matched`;
    }
    if (/No files matched/.test(content)) {
      return `${name}${quoteDetail(name, detail)}: no matches`;
    }
  }

  if (name === 'search') {
    if (content.trim() === '(no matches)') {
      return `${name}${quoteDetail(name, detail)}: no matches`;
    }
    const count = content.split('\n').filter(l => l.trim()).length;
    return `${name}${quoteDetail(name, detail)}: ${count} file(s) matched`;
  }

  if (name === 'read') {
    const range = content.match(/\(lines\s+(\d+)-(\d+)\s+of\s+(\d+)\)/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const total = Number(range[3]);
      const linesDesc = start === 1 && end === total
        ? `${total} lines`
        : `lines ${start}-${end} of ${total}`;
      return `${name}${quoteDetail(name, detail)}: ${linesDesc}`;
    }
  }

  if (name === 'write' || name === 'edit') {
    return `${name}${quoteDetail(name, detail)}: done`;
  }

  if (name === 'shell') {
    return `shell: ${firstNonEmptyLine(content) || '(no output)'}`;
  }

  if (name === 'agent') {
    const lines = content.split('\n');
    const head = lines.find(l => l.trim()) || '';
    const summary = lines.slice(1).find(l => l.trim());
    const line = `agent: ${head}`;
    return summary ? `${line} — ${summary.trim()}` : line;
  }

  const first = firstNonEmptyLine(content);
  return `${name}${detail ? quoteDetail(name, detail) : ''}: ${first || '(no output)'}`;
}

/** 详情引用规则：glob/search 带引号，read/write/edit 取路径 basename，其余原样 */
function quoteDetail(name: string, detail: string): string {
  if (name === 'glob' || name === 'search') {
    return ` "${detail}"`;
  }
  if (name === 'read' || name === 'write' || name === 'edit') {
    const base = detail.split(/[\\/]/).pop();
    return base ? ` ${base}` : '';
  }
  return ` ${detail}`;
}

/** 首行非空内容（去空白） */
function firstNonEmptyLine(content: string): string {
  const line = content.split('\n').find(l => l.trim());
  return line ? line.trim() : '';
}

/** 多行折叠为一行（错误全文保留，行内空白归一） */
function collapseLines(content: string): string {
  return content
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join(' ');
}
