/**
 * todo_write — 任务待办清单（进程内 session 级存储）
 *
 * 对齐 Claude Code：整体替换清单；非法 status 收敛为 pending；
 * 空数组清空；不落盘，/clear 时清空。
 */
import { registerTool } from './index.js';
import type { ToolResult } from './index.js';
import { debugLog } from '../debug-logger.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  group?: string;
}

let todos: TodoItem[] = [];

/** 当前待办清单（返回副本，防外部篡改模块状态） */
export function getTodos(): TodoItem[] {
  return todos.map(t => ({ ...t }));
}

export function clearTodos(): void {
  const previousCount = todos.length;
  todos = [];
  debugLog('Todo list cleared', { previousCount });
}

function normalizeStatus(status: unknown): TodoStatus {
  return status === 'in_progress' || status === 'completed' ? status : 'pending';
}

registerTool({
  name: 'todo_write',
  description:
    'Write and update the todo list for the current task. Replaces the entire list. Always pass all items and their current status. Set group to the parent subtask title (for example S3 Performance) so development, verification, documentation and commit items appear beneath that subtask in one tree.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full replacement list of todo items',
        items: {
          type: 'object',
          properties: {
            group: { type: 'string', description: 'Parent subtask title shared by its development, verification, documentation and commit items' },
            content: {
              type: 'string',
              description: 'Description of the todo item',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of the item',
            },
          },
          required: ['content'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const raw = params.todos;
    if (!Array.isArray(raw)) {
      return { content: 'Invalid todos: expected an array', isError: true };
    }
    todos = raw
      .filter(item => item !== null && typeof item === 'object')
      .map(item => {
        const obj = item as Record<string, unknown>;
        return {
          content: String(obj.content ?? ''),
          status: normalizeStatus(obj.status),
          ...(typeof obj.group === 'string' && obj.group.trim() ? { group: obj.group.trim() } : {}),
        };
      });
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const pending = todos.filter(t => t.status === 'pending').length;
    const completed = todos.filter(t => t.status === 'completed').length;
    debugLog('Todo list updated', {
      totalCount: todos.length,
      inProgressCount: inProgress,
      pendingCount: pending,
      completedCount: completed,
    });
    return {
      content: `Todo list updated (${todos.length} items: ${inProgress} in progress, ${pending} pending, ${completed} completed)`,
    };
  },
});
