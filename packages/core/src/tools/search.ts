/**
 * 内容搜索工具（grep）
 */
import { registerTool } from './index.js';
import { exec } from 'node:child_process';

registerTool({
  name: 'search',
  description: 'Search file contents using regex patterns (ripgrep). Returns matching file paths or content lines.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for',
      },
      path: {
        type: 'string',
        description: 'Directory or file path to search in (default: cwd)',
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.ts")',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode: content shows matching lines, files_with_matches shows file paths, count shows match counts',
      },
    },
    required: ['pattern'],
  },
  async execute(params, signal?) {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) || '.';
    const glob = params.glob as string | undefined;
    const outputMode = (params.output_mode as string) || 'files_with_matches';

    return new Promise((resolve) => {
      // Try ripgrep first, fall back to grep
      const args = ['-n', '--color=never', '--no-heading'];
      if (glob) args.push('--glob', glob);
      if (outputMode === 'files_with_matches') args.push('-l');
      if (outputMode === 'count') args.push('-c');
      args.push('--', pattern, searchPath);

      exec(`rg ${args.map(a => `"${a}"`).join(' ')} 2>/dev/null || grep -rn --include="${glob || '*'}" "${pattern}" "${searchPath}" 2>/dev/null || echo "(no matches)"`, { timeout: 30000, maxBuffer: 5 * 1024 * 1024, signal }, (error, stdout) => {
        const output = stdout.trim();
        resolve({
          content: output || '(no matches)',
          isError: !!error && output === '',
        });
      });
    });
  },
});
