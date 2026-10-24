/**
 * update_plan — 任务步骤计划跟踪（进程内 session 级存储）
 *
 * 对齐 Codex：整体替换计划；非法 status 收敛为 pending；
 * 空数组清空；不落盘，/clear 时清空。
 */
import { registerTool } from './index.js';
import type { ToolResult } from './index.js';

export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  step: string;
  status: PlanStatus;
}

let plan: PlanItem[] = [];

/** 当前计划（返回副本，防外部篡改模块状态） */
export function getPlan(): PlanItem[] {
  return plan.map(p => ({ ...p }));
}

export function clearPlan(): void {
  plan = [];
}

function normalizeStatus(status: unknown): PlanStatus {
  return status === 'in_progress' || status === 'completed' ? status : 'pending';
}

registerTool({
  name: 'update_plan',
  description:
    'Update the execution plan for the current task. Replaces the entire plan — always pass the full set of steps with their current status. Use before and while implementing multi-step work.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'array',
        description: 'Full replacement list of plan steps',
        items: {
          type: 'object',
          properties: {
            step: {
              type: 'string',
              description: 'Description of the plan step',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of the step',
            },
          },
          required: ['step'],
        },
      },
    },
    required: ['plan'],
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const raw = params.plan;
    if (!Array.isArray(raw)) {
      return { content: 'Invalid plan: expected an array', isError: true };
    }
    plan = raw
      .filter(item => item !== null && typeof item === 'object')
      .map(item => {
        const obj = item as Record<string, unknown>;
        return {
          step: String(obj.step ?? ''),
          status: normalizeStatus(obj.status),
        };
      });
    const inProgress = plan.filter(p => p.status === 'in_progress').length;
    const pending = plan.filter(p => p.status === 'pending').length;
    const completed = plan.filter(p => p.status === 'completed').length;
    return {
      content: `Plan updated (${plan.length} steps: ${inProgress} in progress, ${pending} pending, ${completed} completed)`,
    };
  },
});
