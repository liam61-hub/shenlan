import { describe, expect, it, beforeEach } from 'vitest';
import '../tools/todo.js';
import { getTool } from '../tools/index.js';
import { getTodos, clearTodos } from '../tools/todo.js';
import type { Tool } from '../tools/index.js';

let tool: Tool;

beforeEach(() => {
  clearTodos();
  tool = getTool('todo_write')!;
});

describe('todo_write 工具', () => {
  it('整体替换：后续调用以新清单为准', async () => {
    await tool.execute({
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'pending' },
      ],
    });
    await tool.execute({
      todos: [{ content: 'c', status: 'completed' }],
    });

    expect(getTodos()).toEqual([{ content: 'c', status: 'completed' }]);
  });

  it('非法 status 收敛为 pending', async () => {
    const res = await tool.execute({
      todos: [
        { content: 'a', status: 'done' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'weird' },
      ],
    });

    expect(getTodos()).toEqual([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
    expect(res.content).toContain('1 in progress, 2 pending, 0 completed');
  });

  it('空数组清空清单', async () => {
    await tool.execute({ todos: [{ content: 'a', status: 'pending' }] });
    const res = await tool.execute({ todos: [] });

    expect(getTodos()).toEqual([]);
    expect(res.content).toBe('Todo list updated (0 items: 0 in progress, 0 pending, 0 completed)');
  });

  it('摘要格式：计数与模板', async () => {
    const res = await tool.execute({
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'pending' },
        { content: 'c', status: 'completed' },
        { content: 'd', status: 'completed' },
      ],
    });

    expect(res.content).toBe('Todo list updated (4 items: 1 in progress, 1 pending, 2 completed)');
  });

  it('非数组参数返回错误', async () => {
    const res = await tool.execute({ todos: 'nope' });

    expect(res.isError).toBe(true);
    expect(res.content).toContain('Invalid todos');
  });

  it('getTodos 返回副本，外部修改不影响模块状态', async () => {
    await tool.execute({ todos: [{ content: 'a', status: 'pending' }] });
    const copy = getTodos();
    copy[0].status = 'completed';

    expect(getTodos()).toEqual([{ content: 'a', status: 'pending' }]);
  });

  it('clearTodos 清空模块状态', async () => {
    await tool.execute({ todos: [{ content: 'a', status: 'pending' }] });
    clearTodos();

    expect(getTodos()).toEqual([]);
  });
});

it('preserves parent subtask labels for grouped development items', async () => {
  await tool.execute({ todos: [
    { content: 'Develop cache integration', status: 'in_progress', group: ' S3 Performance ' },
    { content: 'Verify A/B results', status: 'pending', group: 'S3 Performance' },
  ] });
  expect(getTodos().map(item => item.group)).toEqual(['S3 Performance', 'S3 Performance']);
  const copy = getTodos();
  copy[0].group = 'changed';
  expect(getTodos()[0].group).toBe('S3 Performance');
});
