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
  /** 预览行（write=新内容各行；edit=`- <old>` + `+ <new>`；末行可能为截断标记） */
  lines: string[];
  /** 内容是否超过行数上限被截断 */
  truncated: boolean;
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
): FileChange | null {
  const filePath = typeof args.file_path === 'string' ? args.file_path : '';
  if (!filePath) return null;

  if (toolName === 'write') {
    const content = typeof args.content === 'string' ? args.content : '';
    const { lines, truncated } = previewLines(content, WRITE_PREVIEW_MAX_LINES);
    return {
      path: filePath,
      kind: existedBefore ? 'update' : 'add',
      lines,
      truncated,
    };
  }

  if (toolName === 'edit') {
    const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
    const newStr = typeof args.new_string === 'string' ? args.new_string : '';
    const lines: string[] = [
      ...oldStr.split('\n').map((l) => `- ${l}`),
      ...newStr.split('\n').map((l) => `+ ${l}`),
    ];
    if (lines.length <= EDIT_PREVIEW_MAX_LINES) {
      return { path: filePath, kind: 'update', lines, truncated: false };
    }
    return {
      path: filePath,
      kind: 'update',
      lines: [
        ...lines.slice(0, EDIT_PREVIEW_MAX_LINES),
        `… (${lines.length - EDIT_PREVIEW_MAX_LINES} more lines)`,
      ],
      truncated: true,
    };
  }

  return null;
}

/** 内容前 maxLines 行 + 截断标记（不超过上限时不加标记） */
function previewLines(content: string, maxLines: number): { lines: string[]; truncated: boolean } {
  const all = content.split('\n');
  if (all.length <= maxLines) return { lines: all, truncated: false };
  return {
    lines: [...all.slice(0, maxLines), `… (${all.length - maxLines} more lines)`],
    truncated: true,
  };
}
