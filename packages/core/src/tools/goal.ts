/**
 * /goal 长任务模式工具 — goal_complete(reason)
 *
 * 仅在 goal 模式下注册进工具列表（repl 动态注册/卸载）；
 * 模型完成目标时调用它，repl 检测到该调用即视为达成。
 */
import type { Tool } from './index.js';
import { registerTool, unregisterTool } from './index.js';

export const GOAL_COMPLETE_TOOL: Tool = {
  name: 'goal_complete',
  description:
    '宣告当前目标（goal mode）已完成。只有在真正达成用户设定的可验证目标时才调用；' +
    '参数 reason 简述达成证据。调用后本轮任务收尾，模型给出最终总结。',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: '达成原因/证据（如：全部用例通过，输出见测试报告）',
      },
    },
    required: ['reason'],
  },
  execute: async (params: Record<string, unknown>) => ({
    content: `Goal completed: ${String(params.reason ?? '')}`,
  }),
};

/** 注册 goal_complete（幂等：已注册时忽略，不抛错） */
export function registerGoalComplete(): void {
  try {
    registerTool(GOAL_COMPLETE_TOOL);
  } catch {
    // 已注册：忽略
  }
}

/** 卸载 goal_complete（幂等） */
export function unregisterGoalComplete(): void {
  unregisterTool('goal_complete');
}
