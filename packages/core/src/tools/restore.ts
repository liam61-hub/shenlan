/**
 * 回收站恢复工具
 */
import { registerTool } from './index.js';
import { listTrash, restoreFromTrash } from '../trash.js';

registerTool({
  name: 'restore',
  description: 'Restore a file from trash by its ID. Use after /trash to list deleted files.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Trash entry ID to restore' },
    },
    required: ['id'],
  },
  async execute(params, _signal?) {
    const id = params.id as string;
    if (!id) {
      const items = listTrash();
      if (items.length === 0) return { content: 'Trash is empty' };
      return { content: `${items.length} item(s) in trash:\n${items.map(i => `  [${i.id}] ${i.originalPath} (${new Date(i.deletedAt).toLocaleString()})`).join('\n')}` };
    }
    const ok = restoreFromTrash(id);
    return ok
      ? { content: `Restored from trash: ${id}` }
      : { content: `Trash entry "${id}" not found`, isError: true };
  },
});
