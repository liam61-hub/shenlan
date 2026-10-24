import { describe, expect, it, beforeEach } from 'vitest';
import '../tools/plan.js';
import { getTool } from '../tools/index.js';
import { getPlan, clearPlan } from '../tools/plan.js';
import type { Tool } from '../tools/index.js';

let tool: Tool;

beforeEach(() => {
  clearPlan();
  tool = getTool('update_plan')!;
});

describe('update_plan 工具', () => {
  it('整体替换：后续调用以新计划为准', async () => {
    await tool.execute({
      plan: [
        { step: '1', status: 'in_progress' },
        { step: '2', status: 'pending' },
      ],
    });
    await tool.execute({
      plan: [{ step: 'done', status: 'completed' }],
    });

    expect(getPlan()).toEqual([{ step: 'done', status: 'completed' }]);
  });

  it('非法 status 收敛为 pending', async () => {
    const res = await tool.execute({
      plan: [
        { step: 'a', status: 'finished' },
        { step: 'b', status: 'in_progress' },
      ],
    });

    expect(getPlan()).toEqual([
      { step: 'a', status: 'pending' },
      { step: 'b', status: 'in_progress' },
    ]);
    expect(res.content).toContain('1 in progress, 1 pending, 0 completed');
  });

  it('空数组清空计划', async () => {
    await tool.execute({ plan: [{ step: 'a', status: 'pending' }] });
    const res = await tool.execute({ plan: [] });

    expect(getPlan()).toEqual([]);
    expect(res.content).toBe('Plan updated (0 steps: 0 in progress, 0 pending, 0 completed)');
  });

  it('摘要格式：计数与模板', async () => {
    const res = await tool.execute({
      plan: [
        { step: '1', status: 'in_progress' },
        { step: '2', status: 'pending' },
        { step: '3', status: 'completed' },
      ],
    });

    expect(res.content).toBe('Plan updated (3 steps: 1 in progress, 1 pending, 1 completed)');
  });

  it('非数组参数返回错误', async () => {
    const res = await tool.execute({ plan: 42 });

    expect(res.isError).toBe(true);
    expect(res.content).toContain('Invalid plan');
  });

  it('getPlan 返回副本，外部修改不影响模块状态', async () => {
    await tool.execute({ plan: [{ step: 'a', status: 'pending' }] });
    const copy = getPlan();
    copy[0].status = 'completed';

    expect(getPlan()).toEqual([{ step: 'a', status: 'pending' }]);
  });

  it('clearPlan 清空模块状态', async () => {
    await tool.execute({ plan: [{ step: 'a', status: 'pending' }] });
    clearPlan();

    expect(getPlan()).toEqual([]);
  });
});
