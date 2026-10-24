/**
 * headless 单任务运行 — shenlan run "任务描述" [--readonly]
 *
 * 复用 core agent loop，非交互运行，结构化输出 + exit code
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = join(__dirname, '..', 'builtin-skills');
import type { ShenlanConfig, Message, TokenUsage } from '@shenlan/core';
import {
  chatStream,
  buildSystemPrompt,
  DEFAULT_MEMORY_TOKEN_BUDGET,
  getAvailableTools,
  getTool,
  executeToolWithTimeout,
  estimateTotalTokens,
  compressMessagesV2,
  buildSkillScanDirs,
  resolveApiKey,
  resolveModelProvider,
  resolveBaseUrl,
  estimateCost,
  formatApiError,
  unregisterGoalComplete,
  IMAGE_MIMES,
  toolResultToMessages,
  messageTextOf,
  resolveMaxOutputTokens,
} from '@shenlan/core';
import { routeModel, getModelContextWindow, detectModality, isVisionModel, pickVisionModel } from './router.js';
import { attachInputImages } from './image-input.js';
import { computeToolSig, RepeatTracker, LOOP_REPEAT_THRESHOLD } from './loop-detect.js';

/** headless 运行结果 */
export interface RunResult {
  status: 'completed' | 'failed' | 'limit_stopped';
  summary: string;
  steps: number;
  cost: { promptTokens: number; completionTokens: number };
  /** 折算成本（CNY） */
  costCny: number;
  output?: string;
  error?: string;
}

/** 执行一次 LLM 调用并返回完整 assistant 消息 */
function callLLM(
  config: ShenlanConfig,
  messages: Message[],
  tools: ReturnType<typeof getAvailableTools>,
  model: string,
): Promise<{
  assistantMsg: Message | null;
  usage?: TokenUsage;
  error?: Error;
}> {
  return new Promise((resolve) => {
    const provider = resolveModelProvider(config, model);
    const modelConfig = {
      ...config.model,
      baseUrl: resolveBaseUrl(config, model),
      model,
      apiKey: resolveApiKey(config, provider),
      // 思考模型的推理与正文共享输出预算：抬到思考下限，避免正文被饿成空（长任务必踩）
      maxTokens: resolveMaxOutputTokens(model, {
        configured: config.model.maxTokens || 8192,
        capOverride: config.model.maxOutputTokens,
        thinkingFloor: config.context?.thinkingOutputFloor,
      }),
    };
    chatStream(
      modelConfig,
      messages,
      tools.length > 0 ? tools : undefined,
      {
        onToken() { /* headless: 不渲染 */ },
        onComplete(assistantMsg, usage) {
          resolve({ assistantMsg, usage });
        },
        onError(error) {
          resolve({ assistantMsg: null, error });
        },
      },
    ).catch((err) => resolve({ assistantMsg: null, error: err as Error }));
  });
}

/** 执行工具调用（超时保护、只读过滤；model 用于视觉模型下展开工具携带的图片） */
async function executeTools(
  toolCalls: NonNullable<Message['tool_calls']>,
  readonly: boolean,
  model: string,
): Promise<Message[]> {
  const results: Message[] = [];

  for (const tc of toolCalls) {
    const toolName = tc.function.name;

    // readonly 模式：只放行读操作
    if (readonly && !['read', 'search'].includes(toolName)) {
      results.push({
        role: 'tool',
        content: `[readonly] Tool "${toolName}" blocked — only read/search allowed in readonly mode`,
        tool_call_id: tc.id,
        name: toolName,
      });
      continue;
    }

    const tool = getTool(toolName);
    if (!tool) {
      results.push({
        role: 'tool',
        content: `Unknown tool: ${toolName}`,
        tool_call_id: tc.id,
        name: toolName,
      });
      continue;
    }

    try {
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await executeToolWithTimeout(tool, args, {});

      // 视觉模型 + 工具携带图片 → 追加 image_url 内容块（toolResultToMessages 展开）
      results.push(...toolResultToMessages({
        toolName,
        toolCallId: tc.id,
        content: result.content,
        images: result.images,
        modelVision: isVisionModel(model),
      }));
    } catch (err) {
      results.push({
        role: 'tool',
        content: `${(err as Error).message}`,
        tool_call_id: tc.id,
        name: toolName,
      });
    }
  }

  return results;
}

/**
 * 执行 headless 单任务
 */
export async function runTask(
  task: string,
  config: ShenlanConfig,
  options: { readonly?: boolean } = {},
): Promise<RunResult> {
  const messages: Message[] = [];

  // @file 引用注入（图片跳过：走视觉直传，防止二进制乱码进上下文）
  let enriched = task;
  const refs = task.match(/@([^\s]+\.[a-zA-Z0-9]{1,6})(\s|$)/g);
  if (refs) {
    for (const ref of refs) {
      const filePath = ref.slice(1).trim();
      if (IMAGE_MIMES[extname(filePath).toLowerCase()]) continue;
      try {
        const resolved = join(process.cwd(), filePath);
        if (existsSync(resolved) && statSync(resolved).isFile()) {
          const content = readFileSync(resolved, 'utf-8');
          const preview = content.slice(0, 4000);
          const truncated = preview.length < content.length ? '\n...(truncated)' : '';
          enriched += `\n\n--- @${filePath} ---\n${preview}${truncated}\n--- end @${filePath} ---`;
        }
      } catch { /* skip */ }
    }
  }

  const systemPrompt = buildSystemPrompt(process.cwd(), {
    builtinSkillDirs: [BUILTIN_SKILLS_DIR],
    skillDirs: buildSkillScanDirs(process.cwd(), config, [BUILTIN_SKILLS_DIR]),
    memoryAutoSave: config.memory?.autoSave ?? true,
    maxMemoryTokens: config.context?.maxMemoryTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET,
  });
  messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: enriched });

  const tools = getAvailableTools(config);
  // goal_complete 仅属于交互式 /goal 模式，headless run 不注册
  unregisterGoalComplete();
  let totalPrompt = 0;
  let totalCompletion = 0;
  let lastContent = '';
  const repeatTracker = new RepeatTracker();
  let noProgressRounds = 0;

  let routedModel = routeModel(task, config);
  // 图片输入：同步路由无模态分支，显式切视觉模型（与交互路径语义一致）
  if (detectModality(task) === 'image' && !isVisionModel(routedModel)) {
    const vision = pickVisionModel(config);
    if (vision) routedModel = vision;
  }
  // 首轮直传：@图片 + 视觉模型 → user 消息展开为 content parts
  attachInputImages(messages, enriched, routedModel, process.cwd());
  // 压缩阈值：min(配置, 90% × 模型窗口)，默认 200k
  const compactLimit = Math.min(
    config.context?.autoCompactTokenLimit ?? 200_000,
    Math.floor(getModelContextWindow(routedModel) * 0.9),
  );
  const maxSteps = config.agent?.maxSteps ?? 80;

  for (let round = 0; round < maxSteps; round++) {
    // 上下文压缩
    const curTokens = estimateTotalTokens(messages);
    if (curTokens > compactLimit) {
      const result = await compressMessagesV2(messages, {
        maxTokens: compactLimit,
        keepRecentTurns: config.context?.keepRecentTurns ?? 20,
      });
      if (result.method !== 'none') {
        messages.length = 0;
        messages.push(...result.messages);
      }
    }

    const { assistantMsg, usage, error } = await callLLM(config, messages, tools, routedModel);

    if (error) {
      return {
        status: 'failed',
        summary: lastContent.slice(0, 200) || '(no output)',
        steps: round + 1,
        cost: { promptTokens: totalPrompt, completionTokens: totalCompletion },
        costCny: estimateCost(routedModel, totalPrompt, totalCompletion),
        error: formatApiError(error),
      };
    }

    if (!assistantMsg) {
      return {
        status: 'failed',
        summary: '(empty response)',
        steps: round + 1,
        cost: { promptTokens: totalPrompt, completionTokens: totalCompletion },
        costCny: estimateCost(routedModel, totalPrompt, totalCompletion),
        error: 'No assistant message returned',
      };
    }

    if (usage) {
      totalPrompt += usage.promptTokens;
      totalCompletion += usage.completionTokens;
    }

    messages.push(assistantMsg);

    if (assistantMsg.content) {
      lastContent = messageTextOf(assistantMsg);
    }

    // 无工具调用 → 任务完成
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return {
        status: 'completed',
        summary: lastContent.slice(0, 200),
        steps: round + 1,
        output: lastContent,
        cost: { promptTokens: totalPrompt, completionTokens: totalCompletion },
        costCny: estimateCost(routedModel, totalPrompt, totalCompletion),
      };
    }

    // 循环检测：同一签名连续出现 ≥5 次 → 判失败
    for (const tc of assistantMsg.tool_calls) {
      const sig = computeToolSig(tc.function.name, tc.function.arguments);
      const count = repeatTracker.track(sig, round);
      if (count >= LOOP_REPEAT_THRESHOLD) {
        return {
          status: 'failed',
          summary: `Loop detected: "${tc.function.name}" called ${count}x with same args`,
          steps: round + 1,
          cost: { promptTokens: totalPrompt, completionTokens: totalCompletion },
          costCny: estimateCost(routedModel, totalPrompt, totalCompletion),
          error: `Tool loop: ${tc.function.name} x${count}`,
        };
      }
    }

    // 执行工具
    const toolResults = await executeTools(assistantMsg.tool_calls, !!options.readonly, routedModel);
    messages.push(...toolResults);
  }

  // 达到最大轮次
  return {
    status: 'limit_stopped',
    summary: `${lastContent.slice(0, 200) || '(no output)'} — reached max steps (${maxSteps})`,
    steps: maxSteps,
    cost: { promptTokens: totalPrompt, completionTokens: totalCompletion },
    costCny: estimateCost(routedModel, totalPrompt, totalCompletion),
  };
}
