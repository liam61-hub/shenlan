/**
 * 精确字符串替换编辑工具
 */
import { registerTool } from './index.js';
import { takeSnapshot } from '../snapshot.js';
import { isPathSafe, isProtectedPath } from '../security.js';
import { expandHome } from './paths.js';
import { FileConflictError, readFileSnapshot, writeFileAtomically } from '../atomic-file.js';

registerTool({
  name: 'edit',
  description: 'Perform exact string replacement in a file. old_string must match exactly.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async execute(params, _signal?) {
    const filePath = expandHome(params.file_path as string);
    const oldStr = params.old_string as string;
    const newStr = params.new_string as string;
    const replaceAll = params.replace_all as boolean;

    try {
      const check = isPathSafe(filePath);
      if (!check.safe) return { content: `Access denied: ${check.reason}`, isError: true };
      const protect = isProtectedPath(filePath);
      if (protect.blocked) {
        return { content: `PROTECTED PATH BLOCKED: "${filePath}" matched protectedPaths pattern "${protect.pattern}"`, isError: true };
      }
      const original = await readFileSnapshot(filePath);
      if (!original.exists) throw new Error(`ENOENT: file not found: ${filePath}`);
      takeSnapshot(filePath);
      let content = original.content;

      if (replaceAll) {
        const count = content.split(oldStr).length - 1;
        if (count === 0) {
          return { content: `"${oldStr.slice(0, 50)}" not found in ${filePath}`, isError: true };
        }
        content = content.replaceAll(oldStr, newStr);
        await writeFileAtomically(filePath, content, original);
        return { content: `Replaced ${count} occurrence(s) in ${filePath}` };
      } else {
        const index = content.indexOf(oldStr);
        if (index === -1) {
          return { content: `"${oldStr.slice(0, 50)}" not found in ${filePath}`, isError: true };
        }
        if (content.indexOf(oldStr, index + 1) !== -1) {
          return { content: `Multiple matches found for "${oldStr.slice(0, 50)}" — use replace_all: true or make old_string more specific`, isError: true };
        }
        content = content.slice(0, index) + newStr + content.slice(index + oldStr.length);
        await writeFileAtomically(filePath, content, original);
        return { content: `Successfully edited ${filePath}` };
      }
    } catch (err) {
      if (err instanceof FileConflictError) {
        return { content: `Conflict: ${filePath} changed while it was being edited. Re-read it before retrying.`, isError: true };
      }
      return { content: `Failed to edit file: ${(err as Error).message}`, isError: true };
    }
  },
});
