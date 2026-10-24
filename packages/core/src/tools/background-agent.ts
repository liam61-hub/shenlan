/**
 * background_agent 工具 — 模型驱动的异步子 agent（§26）
 *
 * 工具立即返回 { taskId, message }，主循环不阻塞；任务完成结果进入
 * background-tasks 的待注入队列，由 CLI 主循环在后续 LLM 调用前注入一次。
 * 执行复用 runSubTask（240s 时间预算、20 轮上限、AbortSignal 透传）。
 */
import { registerTool } from './index.js';
import { getAgentConfig, runSubTask } from './agent.js';
import { setBackgroundRunner, startBackgroundTask } from '../background-tasks.js';

// 模块加载即注册真实执行器（CLI 启动时 setAgentConfig 注入配置/模型）
setBackgroundRunner((goal, task, signal) => {
  const injected = getAgentConfig();
  if (!injected) {
    return Promise.resolve({ goal, summary: 'background agent not configured', success: false });
  }
  return runSubTask(task, goal, injected.config, injected.model, 20, signal);
});

registerTool({
  name: 'background_agent',
  description:
    'Start a subtask in the background and return immediately. The main loop continues while it runs; ' +
    'the result is injected into the conversation before the next model turn. Use for independent exploration ' +
    'or research that does not block the main task. Tool calls within the main loop remain serial; ' +
    'background tasks do not consume main-loop tool slots.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'Short label describing this background task (e.g. "Research Tavily pricing")',
      },
      task: {
        type: 'string',
        description: 'Detailed task description. Include specific questions and tools to use.',
      },
    },
    required: ['goal', 'task'],
  },
  async execute(params) {
    const injected = getAgentConfig();
    if (!injected) {
      return {
        content: 'Background agent not configured — config/model not injected. This is a system error.',
        isError: true,
      };
    }
    const goal = String(params.goal || '');
    const task = String(params.task || '');
    if (!task) {
      return { content: 'Missing required parameter: task', isError: true };
    }
    const maxBackground = injected.config.agent?.maxBackground ?? 3;
    try {
      const { taskId } = startBackgroundTask(goal, task, undefined, { maxBackground });
      return { content: JSON.stringify({ taskId, message: 'background task started' }) };
    } catch (err) {
      return { content: String((err as Error).message), isError: true };
    }
  },
});
