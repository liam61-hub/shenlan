import { diffLines } from 'diff';

/**
 * file-change.ts — 文件变更卡片数据（纯函数，无 React/Ink 依赖，可单测）
 *
 * 滚动区每个成功执行的 write / edit 工具冻结为一张变更卡片：
 *   首行：✏️ Added <路径> / ✏️ Updated <路径>
 *   预览：write 显示新内容；edit 显示 old→new 的 - / + 块
 *
 * 卡片是纯 UI 产物：
 *   - 不写入会话 JSONL（--resume 后不重现，回退为单行摘要）
 *   - 构建失败静默降级为无卡片（调用方 try/catch，不影响工具循环）
 */

/** write 预览内容行数上限（超出截断，末行加 "… (N more lines)"） */
export const WRITE_PREVIEW_MAX_LINES = 60;
/** edit 预览 -/+ 块合计行数上限 */
export const EDIT_PREVIEW_MAX_LINES = 40;
/** 卡片每行显示宽度上限（CJK 双宽计列，超长截断加 …） */
export const FILE_CHANGE_PREVIEW_MAX_WIDTH = 140;

export interface FileChange {
  path: string;
  /** write：执行前文件不存在=add，存在=update；edit 恒为 update */
  kind: 'add' | 'update';
  /** 预览行，截断提示使用 kind=truncated 且不带行号。 */
  lines: FileChangeLine[];
  /** 内容是否超过行数上限被截断 */
  truncated: boolean;
}

export interface FileChangeLine {
  text: string;
  kind: 'add' | 'remove' | 'plain' | 'truncated' | 'notice';
  /** null 表示该侧不适用或无法可靠定位。 */
  oldLine: number | null;
  newLine: number | null;
}

/**
 * 构建文件变更卡片数据。
 *
 * @param toolName      工具名（仅 write / edit 产生卡片）
 * @param args          工具调用参数（file_path / content / old_string / new_string）
 * @param existedBefore 执行前文件是否已存在（write 的 add/update 判定依据）
 * @returns FileChange | null（其他工具或缺 file_path 返回 null）
 */
export function buildFileChange(
  toolName: string,
  args: Record<string, unknown>,
  existedBefore: boolean,
  originalContent?: string,
): FileChange | null {
  const filePath = typeof args.file_path === 'string' ? args.file_path : '';
  if (!filePath) return null;

  if (toolName === 'write') {
    const content = typeof args.content === 'string' ? args.content : '';
    const kind = existedBefore ? 'update' : 'add';
    const allLines = existedBefore && originalContent === undefined
      ? [{
        text: 'Change preview unavailable (original file could not be read)',
        kind: 'notice' as const, oldLine: null, newLine: null,
      }]
      : existedBefore
        ? diffWriteLines(originalContent!, content)
        : content.split('\n').map((text, index): FileChangeLine => ({
        text,
        kind: 'add',
        oldLine: null,
        newLine: index + 1,
      }));
    const truncated = allLines.length > WRITE_PREVIEW_MAX_LINES;
    const lines = allLines.slice(0, WRITE_PREVIEW_MAX_LINES);
    if (truncated) {
      lines.push({
        text: `… (${allLines.length - WRITE_PREVIEW_MAX_LINES} more lines)`,
        kind: 'truncated', oldLine: null, newLine: null,
      });
    }
    return {
      path: filePath,
      kind,
      lines,
      truncated,
    };
  }

  if (toolName === 'edit') {
    const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
    const newStr = typeof args.new_string === 'string' ? args.new_string : '';
    const startLine = findUniqueLine(originalContent, oldStr);
    const lines: FileChangeLine[] = [
      ...oldStr.split('\n').map((text, index): FileChangeLine => ({
        text, kind: 'remove', oldLine: startLine === null ? null : startLine + index, newLine: null,
      })),
      ...newStr.split('\n').map((text, index): FileChangeLine => ({
        text, kind: 'add', oldLine: null, newLine: startLine === null ? null : startLine + index,
      })),
    ];
    if (lines.length <= EDIT_PREVIEW_MAX_LINES) {
      return { path: filePath, kind: 'update', lines, truncated: false };
    }
    return {
      path: filePath,
      kind: 'update',
      lines: [
        ...lines.slice(0, EDIT_PREVIEW_MAX_LINES),
        { text: `… (${lines.length - EDIT_PREVIEW_MAX_LINES} more lines)`, kind: 'truncated', oldLine: null, newLine: null },
      ],
      truncated: true,
    };
  }

  return null;
}

/** Return the 1-based source line only when the old text occurs exactly once. */
function findUniqueLine(originalContent: string | undefined, oldText: string): number | null {
  if (originalContent === undefined || oldText === '') return null;
  const first = originalContent.indexOf(oldText);
  if (first < 0 || originalContent.indexOf(oldText, first + 1) >= 0) return null;
  let line = 1;
  for (let i = 0; i < first; i++) if (originalContent[i] === '\n') line++;
  return line;
}

function diffWriteLines(oldContent: string, newContent: string): FileChangeLine[] {
  const lines: FileChangeLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of diffLines(oldContent, newContent)) {
    const values = change.value.split('\n');
    if (values.at(-1) === '') values.pop();
    for (const text of values) {
      if (change.removed) {
        lines.push({ text, kind: 'remove', oldLine: oldLine++, newLine: null });
      } else if (change.added) {
        lines.push({ text, kind: 'add', oldLine: null, newLine: newLine++ });
      } else {
        oldLine++;
        newLine++;
      }
    }
  }
  return lines;
}
