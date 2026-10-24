/**
 * todo_write — 任务待办清单（进程内 session 级存储）
 *
 * 对齐 Claude Code：整体替换清单；非法 status 收敛为 pending；
 * 空数组清空；不落盘，/clear 时清空。
 */
import { registerTool } from './index.js';
import type { ToolResult } from './index.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

let todos: TodoItem[] = [];

/** 当前待办清单（返回副本，防外部篡改模块状态） */
export function getTodos(): TodoItem[] {
  return todos.map(t => ({ ...t }));
}

export function clearTodos(): void {
  todos = [];
}

function normalizeStatus(status: unknown): TodoStatus {
  return status === 'in_progress' || status === 'completed' ? status : 'pending';
}

registerTool({
  name: 'todo_write',
  description:
    'Write and update the todo list for the current task. Replaces the entire list — always pass the full set of items with their current status. Use for tracking multi-step work.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full replacement list of todo items',
        items: {
          type: 'object',
          properties: {
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
        };
      });
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const pending = todos.filter(t => t.status === 'pending').length;
    const completed = todos.filter(t => t.status === 'completed').length;
    return {
      content: `Todo list updated (${todos.length} items: ${inProgress} in progress, ${pending} pending, ${completed} completed)`,
    };
  },
});
