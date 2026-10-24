/**
 * 文件读取工具
 */
import { registerTool } from './index.js';
import { readFile } from 'node:fs/promises';
import { isPathSafe } from '../security.js';
import { expandHome } from './paths.js';

registerTool({
  name: 'read',
  description: 'Read contents of a file. Returns the file content as text with line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read',
      },
      offset: {
        type: 'integer',
        description: 'Line number to start reading from (1-indexed)',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to read',
      },
    },
    required: ['file_path'],
  },
  async execute(params, _signal?) {
    const filePath = expandHome(params.file_path as string);
    const offset = (params.offset as number) || 1;
    const limit = params.limit as number | undefined;

    try {
      const check = isPathSafe(filePath);
      if (!check.safe) return { content: `Access denied: ${check.reason}`, isError: true };
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, offset - 1);
      const end = limit ? start + limit : lines.length;
      const selected = lines.slice(start, end);

      const result = selected
        .map((line, i) => `${String(start + i + 1).padStart(6, ' ')}\t${line}`)
        .join('\n');

      const totalLines = lines.length;
      const header = `${filePath} (lines ${start + 1}-${Math.min(end, totalLines)} of ${totalLines})\n`;

      return { content: header + result };
    } catch (err) {
      return { content: `Failed to read file: ${(err as Error).message}`, isError: true };
    }
  },
});
