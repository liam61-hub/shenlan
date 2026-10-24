/**
 * Agent 工具 — 派生子 Agent 独立执行子任务
 *
 * LLM 可调用此工具将复杂任务拆解为独立子任务并行执行。
 * 每个子 Agent 有完整的工具访问权限，返回摘要结果。
 */
import { registerTool, getTool, getToolSchemas } from './index.js';
import { executeToolWithTimeout } from './timeout.js';
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
): Promise<{ goal: string; summary: string; success: boolean }> {
  const startTime = Date.now();
  debugLog('Sub-agent — started', { goal, task: task.slice(0, 200), maxRounds });
  const messages: Message[] = [];
  // Dynamic import to avoid circular dependency with context.ts
  const { buildSystemPrompt } = await import('../context.js');
  const systemPrompt = buildSystemPrompt(process.cwd(), {});
  messages.push({ role: 'system', content: systemPrompt });
  messages.push({
    role: 'user',
    content: `Complete this subtask independently and return a clear summary.\n\nGoal: ${goal}\n\nTask:\n${task}\n\nWork through this step by step. Use tools as needed. When done, provide a concise summary of findings.`,
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
    // Check abort signal before each round
    if (signal?.aborted) {
      debugLog('Sub-agent — aborted', { goal, round, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
      return { goal, summary: lastContent.slice(0, 500) || 'Aborted', success: false };
    }

    // 时间预算：接近主循环超时前主动收尾，返回部分结论而不是被硬超时丢弃
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > SUBTASK_MAX_DURATION_MS) {
      debugLog('Sub-agent — time budget reached', { goal, round, elapsed: `${(elapsedMs / 1000).toFixed(1)}s`, contentLen: lastContent.length });
      return {
        goal,
        summary: lastContent.slice(0, 500) || '(no partial results)',
        success: false,
      };
    }

    const resp = await new Promise<{
      msg: Message | null;
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
            // 子任务 LLM 调用真实 usage 计入同一会话成本护栏（§26.3；修复 agent 工具既有缺口）
            if (usage) recordUsage(model, usage.promptTokens, usage.completionTokens);
            resolve({ msg });
          },
          onError(err) { resolve({ msg: null, err }); },
        },
      ).catch((err) => resolve({ msg: null, err }));
    });

    if (resp.err || !resp.msg) {
      debugLog('Sub-agent — LLM error', { goal, round, error: resp.err?.message || 'no response', elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
      return {
        goal,
        summary: `Sub-agent failed: ${resp.err?.message || 'no response'}`,
        success: false,
      };
    }

    messages.push(resp.msg);
    if (resp.msg.content) lastContent = messageTextOf(resp.msg);

    // No tool calls → sub-agent is done
    if (!resp.msg.tool_calls || resp.msg.tool_calls.length === 0) {
      debugLog('Sub-agent — completed', { goal, round, contentLen: lastContent.length, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
      return { goal, summary: lastContent.slice(0, 500), success: true };
    }

    // Execute tool calls
    for (const tc of resp.msg.tool_calls) {
      // Check abort signal before each tool execution
      if (signal?.aborted) {
        return { goal, summary: lastContent.slice(0, 500) || 'Aborted', success: false };
      }

      const tool = getTool(tc.function.name);
      if (!tool) {
        messages.push({
          role: 'tool',
          content: `Unknown tool: ${tc.function.name}`,
          tool_call_id: tc.id,
          name: tc.function.name,
        });
        continue;
      }
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        // 超时保护：超时后 abort 合并信号，真正停止底层工具（shell 杀进程等）
        const result = await executeToolWithTimeout(tool, args, { signal });
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
    }
  }

  debugLog('Sub-agent — max rounds reached', { goal, round: maxRounds, contentLen: lastContent.length, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
  return { goal, summary: lastContent.slice(0, 500), success: true };
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
