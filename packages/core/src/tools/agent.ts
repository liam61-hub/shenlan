/**
 * Agent 工具 — 派生子 Agent 独立执行子任务
 *
 * LLM 可调用此工具将复杂任务拆解为独立子任务并行执行。
 * 每个子 Agent 有完整的工具访问权限，返回摘要结果。
 */
import { registerTool, getToolSchemas } from './index.js';
import { executeToolCall } from './execute.js';
import type { ToolResult } from './index.js';
import type { Message } from '../provider.js';
import type { ShenlanConfig } from '../config.js';
import { chatStream, messageTextOf } from '../provider.js';
import { toolResultToMessages } from '../message-builders.js';
import { resolveApiKey, resolveModelProvider, resolveBaseUrl } from '../config.js';
import { debugLog } from '../debug-logger.js';
import { recordUsage } from '../cost-tracker.js';

// 模块级配置注入（由 CLI 启动时设置）
let agentConfig: ShenlanConfig | null = null;
let agentModel: string = '';

export type SubTaskStatus = 'completed' | 'failed' | 'cancelled' | 'limit_stopped';

export interface SubTaskResult {
  goal: string;
  summary: string;
  status: SubTaskStatus;
  /** Kept for existing callers; true only when status is completed. */
  success: boolean;
}

export interface SubTaskProgress {
  kind: 'started' | 'round' | 'tool' | 'stage';
  title: string;
}

function subTaskResult(goal: string, summary: string, status: SubTaskStatus): SubTaskResult {
  return { goal, summary, status, success: status === 'completed' };
}

/** 子任务最长执行时间：接近主循环 agent 工具 300s 上限，提前带部分结果收尾 */
const SUBTASK_MAX_DURATION_MS = 240_000;

/** 设置 Agent 工具的配置依赖（CLI 启动时调用一次） */
export function setAgentConfig(config: ShenlanConfig, model: string): void {
  agentConfig = config;
  agentModel = model;
}

/** 读取已注入的配置/模型（background_agent 等复用同一注入）；未注入返回 null */
export function getAgentConfig(): { config: ShenlanConfig; model: string } | null {
  if (!agentConfig || !agentModel) return null;
  return { config: agentConfig, model: agentModel };
}

/** 执行单个子任务（也导出供 agents.ts 使用） */
export async function runSubTask(
  task: string,
  goal: string,
  config: ShenlanConfig,
  model: string,
  maxRounds: number = 20,
  signal?: AbortSignal,
  onProgress?: (progress: SubTaskProgress) => void,
): Promise<SubTaskResult> {
  const startTime = Date.now();
  debugLog('Sub-agent — started', { goalLen: goal.length, taskLen: task.length, maxRounds });
  onProgress?.({ kind: 'started', title: goal });
  const messages: Message[] = [];
  // Dynamic import to avoid circular dependency with context.ts
  const { buildSystemPrompt } = await import('../context.js');
  const systemPrompt = buildSystemPrompt(process.cwd(), {});
  messages.push({ role: 'system', content: systemPrompt });
  messages.push({
    role: 'user',
    content: `Complete this subtask independently and return a clear summary.\n\nGoal: ${goal}\n\nTask:\n${task}\n\nWork through this step by step. Use tools as needed. Use task_progress to report meaningful stages as started, in_progress, and completed, and report verification outcomes. When done, provide a concise summary of findings.`,
  });

  const toolDefs = getToolSchemas()
    .filter(t => t.function.name !== 'agent')
    .map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as unknown as Record<string, unknown>,
    }));
  let lastContent = '';

  for (let round = 0; round < maxRounds; round++) {
    onProgress?.({ kind: 'round', title: `Round ${round + 1}` });
    // Check abort signal before each round
    if (signal?.aborted) {
      debugLog('Sub-agent — aborted', { goal, round, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
      return subTaskResult(goal, lastContent.slice(0, 500) || 'Aborted', 'cancelled');
    }

    // 时间预算：接近主循环超时前主动收尾，返回部分结论而不是被硬超时丢弃
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > SUBTASK_MAX_DURATION_MS) {
      debugLog('Sub-agent — time budget reached', { goal, round, elapsed: `${(elapsedMs / 1000).toFixed(1)}s`, contentLen: lastContent.length });
      return subTaskResult(goal, lastContent.slice(0, 500) || '(no partial results)', 'limit_stopped');
    }

    const resp = await new Promise<{
      msg: Message | null;
      usage?: { promptTokens: number; completionTokens: number };
      err?: Error;
    }>((resolve) => {
      chatStream(
        {
          ...config.model,
          baseUrl: resolveBaseUrl(config, model),
          model,
          apiKey: resolveApiKey(config, resolveModelProvider(config, model)),
        },
        messages,
        toolDefs.length > 0 ? toolDefs : undefined,
        {
          onToken() { /* silent — sub-agent output stays internal */ },
          onComplete(msg, usage) {
            resolve({ msg, usage });
          },
          onError(err) { resolve({ msg: null, err }); },
        },
        signal,
      ).catch((err) => resolve({ msg: null, err }));
    });

    if (resp.usage && !resp.err) recordUsage(model, resp.usage.promptTokens, resp.usage.completionTokens);

    if (signal?.aborted) {
      return subTaskResult(goal, lastContent.slice(0, 500) || 'Aborted', 'cancelled');
    }

    if (resp.err || !resp.msg) {
      debugLog('Sub-agent — LLM error', { goal, round, error: resp.err?.message || 'no response', elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
      if (signal?.aborted) {
        return subTaskResult(goal, lastContent.slice(0, 500) || 'Aborted', 'cancelled');
      }
      return subTaskResult(goal, `Sub-agent failed: ${resp.err?.message || 'no response'}`, 'failed');
    }

    messages.push(resp.msg);
    if (resp.msg.content) lastContent = messageTextOf(resp.msg);

    // No tool calls → sub-agent is done
    if (!resp.msg.tool_calls || resp.msg.tool_calls.length === 0) {
      debugLog('Sub-agent — completed', { goal, round, contentLen: lastContent.length, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
      return subTaskResult(goal, lastContent.slice(0, 500), 'completed');
    }

    // Execute tool calls
    for (const tc of resp.msg.tool_calls) {
      // Check abort signal before each tool execution
      if (signal?.aborted) {
        return subTaskResult(goal, lastContent.slice(0, 500) || 'Aborted', 'cancelled');
      }

      try {
        const args: unknown = JSON.parse(tc.function.arguments || '{}');
        if (tc.function.name === 'task_progress' && args && typeof args === 'object') {
          const progress = args as Record<string, unknown>;
          if (progress.kind === 'stage' && typeof progress.title === 'string' && typeof progress.status === 'string') {
            onProgress?.({ kind: 'stage', title: `${progress.title} (${progress.status})` });
          }
        } else {
          onProgress?.({ kind: 'tool', title: tc.function.name });
        }
        const result = await executeToolCall(tc.function.name, args, {
          permissions: config.permissions,
          cwd: process.cwd(),
          auditEnabled: config.actionSafety?.auditEnabled,
          signal,
        });
        // 视觉子模型 + 工具携带图片 → 展开 image_url 内容块（非视觉静默丢弃）
        // 视觉判定先按模型名（qwen-vl 家族）；目录单一事实源落地后换 catalog 判定
        messages.push(...toolResultToMessages({
          toolName: tc.function.name,
          toolCallId: tc.id,
          content: result.content,
          images: result.images,
          modelVision: /(^|-)vl\b|vision/i.test(model),
        }));
      } catch (err) {
        messages.push({
          role: 'tool',
          content: String(err),
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }

      if (signal?.aborted) {
        return subTaskResult(goal, lastContent.slice(0, 500) || 'Aborted', 'cancelled');
      }
    }
  }

  if (signal?.aborted) {
    return subTaskResult(goal, lastContent.slice(0, 500) || 'Aborted', 'cancelled');
  }

  debugLog('Sub-agent — max rounds reached', { goal, round: maxRounds, contentLen: lastContent.length, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
  return subTaskResult(goal, lastContent.slice(0, 500) || '(no final response)', 'limit_stopped');
}

// 注册 agent 工具
registerTool({
  name: 'agent',
  description:
    'Spawn a sub-agent to independently handle a specific subtask. The sub-agent has full access to all tools (read, write, edit, shell, search, glob, web_search) and returns a summary of its findings. Use this for multi-faceted analysis where different dimensions can be explored. 主循环内工具调用串行执行，/agents 为用户侧并行编排。',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'Short label describing what this sub-agent should accomplish (e.g. "Analyze frontend structure", "Check database schema")',
      },
      task: {
        type: 'string',
        description: 'Detailed task description for the sub-agent. Include specific questions to answer and tools to use.',
      },
    },
    required: ['goal', 'task'],
  },
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (!agentConfig || !agentModel) {
      return {
        content: 'Agent tool not configured — config/model not injected. This is a system error.',
        isError: true,
      };
    }

    const goal = String(params.goal || '');
    const task = String(params.task || '');
    if (!task) {
      return { content: 'Missing required parameter: task', isError: true };
    }

    const result = await runSubTask(task, goal, agentConfig, agentModel, 15, signal);
    const prefix = result.success ? '✓' : '✗';
    return {
      content: `${prefix} [${result.goal}]\n${result.summary}`,
      isError: !result.success,
    };
  },
});
