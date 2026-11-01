/**
 * background_agent 工具 — 立即返回/并发超限/缺注入报错/结果入待注入队列
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerAllTools, getTool, DEFAULT_CONFIG } from '../index.js';
import { setAgentConfig } from '../tools/agent.js';
import {
  clearBackgroundTasks,
  setBackgroundRunner,
  consumePendingInjections,
  listRunningBackgroundTasks,
} from '../background-tasks.js';

describe('background_agent 工具', () => {
  beforeEach(async () => {
    clearBackgroundTasks();
    setAgentConfig({ ...DEFAULT_CONFIG }, 'deepseek-v4-flash');
    await registerAllTools({ ...DEFAULT_CONFIG });
  });

  it('execute 立即返回 taskId 与 message，不等待子任务', async () => {
    setBackgroundRunner(() => new Promise(() => {})); // 永不完成
    const tool = getTool('background_agent')!;
    const result = await tool.execute({ goal: '研究定价', task: '查文档' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('bg-');
    expect(result.content).toContain('started');
    expect(listRunningBackgroundTasks()).toHaveLength(1);
  });

  it('并发超限：返回错误含当前运行数，不排队', async () => {
    setBackgroundRunner(() => new Promise(() => {}));
    setAgentConfig(
      { ...DEFAULT_CONFIG, agent: { maxSteps: 80, maxBackground: 1 } },
      'deepseek-v4-flash',
    );
    const tool = getTool('background_agent')!;
    const first = await tool.execute({ goal: 'a', task: 't' });
    expect(first.isError).toBeFalsy();
    const second = await tool.execute({ goal: 'b', task: 't' });
    expect(second.isError).toBe(true);
    expect(second.content).toContain('1');
  });

  it('完成结果进入待注入队列（真实 runner）', async () => {
    setBackgroundRunner(() => Promise.resolve({ goal: 'g', summary: 'done', success: true }));
    const tool = getTool('background_agent')!;
    await tool.execute({ goal: 'g', task: 't' });
    await vi.waitFor(() => expect(listRunningBackgroundTasks()).toHaveLength(0));
    expect(consumePendingInjections()).toEqual([
      expect.objectContaining({ goal: 'g', summary: 'done', success: true }),
    ]);
  });

  it('缺 task 参数：返回参数错误', async () => {
    const tool = getTool('background_agent')!;
    const result = await tool.execute({ goal: 'g' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task');
  });
});
