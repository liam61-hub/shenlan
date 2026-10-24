/**
 * 文件写入工具
 */
import { registerTool } from './index.js';
import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { takeSnapshot } from '../snapshot.js';
import { isPathSafe, isProtectedPath } from '../security.js';
import { expandHome } from './paths.js';

registerTool({
  name: 'write',
  description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },
  async execute(params, _signal?) {
    const filePath = expandHome(params.file_path as string);
    const content = params.content as string;

    try {
      const check = isPathSafe(filePath);
      if (!check.safe) return { content: `Access denied: ${check.reason}`, isError: true };
      const protect = isProtectedPath(filePath);
      if (protect.blocked) {
        return { content: `PROTECTED PATH BLOCKED: "${filePath}" matched protectedPaths pattern "${protect.pattern}"`, isError: true };
      }
      takeSnapshot(filePath);
      await mkdir(dirname(filePath), { recursive: true });
      // 原子写入：临时文件 + rename
      const tmpPath = filePath + '.tmp.' + Math.random().toString(36).slice(2, 8);
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, filePath);
      return { content: `Successfully wrote ${content.split('\n').length} lines to ${filePath}` };
    } catch (err) {
      return { content: `Failed to write file: ${(err as Error).message}`, isError: true };
    }
  },
});
