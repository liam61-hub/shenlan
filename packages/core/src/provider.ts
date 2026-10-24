/**
 * LLM Provider — OpenAI 兼容 API 调用
 *
 * 支持流式（SSE）和非流式两种模式
 * 流式调用会积累完整的 assistant 消息（文本+tool_calls）并在 onComplete 中返回
 */
import type { ModelConfig, ShenlanConfig } from './config.js';
import { chatCompletionsUrl, resolveApiKey } from './config.js';
import { debugLog } from './debug-logger.js';

/** 消息角色 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 多模态内容块（OpenAI 格式：文本块 / 图片块，url 允许 data URI） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** 工具调用 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 对话消息 */
export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * 提取消息的纯文本形态（展示/摘要/降级用）：
 * string 原样；null → ''；ContentPart[] → 各 text 块拼接，图片以 [图片: url前80字符] 占位。
 */
export function messageTextOf(msg: Pick<Message, 'content'>): string {
  if (msg.content === null) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.map((part) => {
    if (part.type === 'text') return part.text;
    const url = part.image_url.url;
    return `[图片: ${url.length > 80 ? url.slice(0, 80) + '…' : url}]`;
  }).join('');
}

/** 工具定义（传给 LLM 的格式） */
export interface FunctionDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 非流式 API 响应 */
export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Token 用量 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 结束原因（stop / tool_calls / length）——诊断空回复/截断用 */
  finishReason?: string;
  /** 思考流字符数（reasoning_content / reasoning）——诊断“思考吃光 max_tokens”用 */
  reasoningChars?: number;
}

/** 流式回调 */
export interface StreamCallbacks {
  /** 每个文本 token */
  onToken: (token: string) => void;
  /** 收到工具调用片段时 */
  onToolCall?: (toolCall: ToolCall) => void;
  /** 流结束，返回完整的 assistant 消息 + 用量 */
  onComplete: (message: Message, usage?: TokenUsage) => void;
  /** 错误 */
  onError: (error: Error) => void;
}

/**
 * 最大长度参数字段名按模型家族映射：
 * OpenAI o 系列（o1/o3/o4）要求 max_completion_tokens（传 max_tokens 会 400）；
 * 其余（含 gpt-5.x，max_tokens deprecated 但可用）保持 max_tokens。
 */
export function maxTokensFieldFor(model: string): 'max_completion_tokens' | 'max_tokens' {
  return /^o[1-9](\b|-)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * 发送非流式请求
 */
export async function chat(
  config: ModelConfig,
  messages: Message[],
  tools?: FunctionDef[],
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    [maxTokensFieldFor(config.model)]: config.maxTokens,
    stream: false,
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({ type: 'function', function: t }));
  }

  const resp = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json() as Promise<ChatResponse>;
}

/**
 * 发送流式请求（SSE）
 *
 * 积累完整的 assistant 消息（文本内容 + tool_calls），
 * 在 onComplete 中返回完整的 Message 对象。
 */
export async function chatStream(
  config: ModelConfig,
  messages: Message[],
  tools: FunctionDef[] | undefined,
  callbacks: StreamCallbacks,
  externalSignal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    [maxTokensFieldFor(config.model)]: config.maxTokens,
    stream: true,
    // 让 OpenAI 兼容端点（DeepSeek / 百炼 compatible-mode 等）在流末尾回传 usage。
    // 否则 chunk.usage 缺失，无法诊断“思考吃光预算 / 被 max_tokens 截断”类空回复。
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({ type: 'function', function: t }));
    body.tool_choice = 'auto';
  }

  debugLog('API Request', {
    model: config.model,
    baseUrl: config.baseUrl,
    msgCount: messages.length,
    msgRoles: messages.map(m => m.role).join(', '),
    toolsCount: tools?.length || 0,
    toolNames: tools?.map(t => t.name).join(', ') || '(none)',
    toolChoice: (body.tool_choice as string) || '(not set)',
    systemPromptPreview: messageTextOf(messages.find(m => m.role === 'system') ?? { content: null }).slice(0, 300),
  });

  const timeoutSignal = AbortSignal.timeout(300_000);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const resp = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text.slice(0, 500)}`);
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 积累完整的 assistant 消息
    let accumulatedContent = '';
    // 思考模型的推理过程走 delta.reasoning_content（部分端点用 delta.reasoning）。
    // 它不属于最终回答、也不能回传给 API，仅累积用于诊断“思考吃光 max_tokens → content 为空”。
    let accumulatedReasoning = '';
    let finishReason: string | undefined;
    const toolCallsByIndex = new Map<number, {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>();
    let promptTokens = 0;
    let completionTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          // 构建完整的 assistant 消息
          const message = buildAssistantMessage(accumulatedContent, toolCallsByIndex);
          debugLog('API Response [DONE]', {
            contentLen: accumulatedContent.length,
            contentPreview: accumulatedContent.slice(0, 200),
            toolCallsCount: toolCallsByIndex.size,
            toolNames: Array.from(toolCallsByIndex.values()).map(tc => tc.function.name).join(', '),
            reasoningLen: accumulatedReasoning.length,
            reasoningPreview: accumulatedReasoning.slice(0, 200),
            finishReason: finishReason ?? '(none)',
            usage: promptTokens > 0
              ? { promptTokens, completionTokens, reasoningIsOutput: accumulatedReasoning.length > 0 && accumulatedContent.length === 0 }
              : undefined,
          });
          callbacks.onComplete(
            message,
            promptTokens > 0
              ? { promptTokens, completionTokens, finishReason, reasoningChars: accumulatedReasoning.length }
              : undefined,
          );
          return;
        }

        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;

          // 记录结束原因：'stop' 正常收尾 / 'tool_calls' 调用工具 / 'length' 被 max_tokens 截断
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          // 积累文本
          if (delta?.content) {
            accumulatedContent += delta.content;
            callbacks.onToken(delta.content);
          }

          // 积累思考流（reasoning_content / reasoning）——仅诊断用，不计入最终回答
          const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
          if (typeof reasoningDelta === 'string' && reasoningDelta) {
            accumulatedReasoning += reasoningDelta;
          }

          // 积累 tool_calls（按 index 合并）
          if (delta?.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index ?? 0;
              if (!toolCallsByIndex.has(idx)) {
                toolCallsByIndex.set(idx, {
                  id: tcDelta.id || '',
                  type: 'function',
                  function: { name: tcDelta.function?.name || '', arguments: '' },
                });
              }
              const existing = toolCallsByIndex.get(idx)!;
              if (tcDelta.id) existing.id = tcDelta.id;
              if (tcDelta.function?.name) existing.function.name = tcDelta.function.name;
              if (tcDelta.function?.arguments) {
                existing.function.arguments += tcDelta.function.arguments;
              }
            }
          }

          // 抛出累积完成的 tool_calls 通知（用于实时状态显示）
          if (delta?.tool_calls && callbacks.onToolCall) {
            for (const tcDelta of delta.tool_calls) {
              if (tcDelta.id) {
                callbacks.onToolCall({
                  id: tcDelta.id,
                  type: 'function',
                  function: {
                    name: tcDelta.function?.name || '',
                    arguments: tcDelta.function?.arguments || '',
                  },
                });
              }
            }
          }

          // 从最后一个 chunk 获取 usage
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }

    // 流结束（没有 [DONE] 的情况）
    const message = buildAssistantMessage(accumulatedContent, toolCallsByIndex);
    debugLog('API Response (stream ended)', {
      contentLen: accumulatedContent.length,
      contentPreview: accumulatedContent.slice(0, 200),
      toolCallsCount: toolCallsByIndex.size,
      toolNames: Array.from(toolCallsByIndex.values()).map(tc => tc.function.name).join(', '),
      reasoningLen: accumulatedReasoning.length,
      reasoningPreview: accumulatedReasoning.slice(0, 200),
      finishReason: finishReason ?? '(none)',
      usage: promptTokens > 0
        ? { promptTokens, completionTokens, reasoningIsOutput: accumulatedReasoning.length > 0 && accumulatedContent.length === 0 }
        : undefined,
    });
    callbacks.onComplete(
      message,
      promptTokens > 0
        ? { promptTokens, completionTokens, finishReason, reasoningChars: accumulatedReasoning.length }
        : undefined,
    );
  } catch (err) {
    callbacks.onError(err as Error);
  }
}

/**
 * 从积累的文本和 tool_calls 构建完整的 assistant Message
 */
function buildAssistantMessage(
  content: string,
  toolCallsByIndex: Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>,
): Message {
  const sorted = Array.from(toolCallsByIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => {
      // 如果流中没提供 id，生成一个
      const id = tc.id || `call_${tc.function.name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // 确保 arguments 是合法 JSON，否则设为 {}
      let args = tc.function.arguments || '{}';
      try { JSON.parse(args); } catch { args = '{}'; }
      return {
        ...tc,
        id,
        function: { ...tc.function, arguments: args },
      };
    });

  return {
    role: 'assistant',
    // 有 tool_calls 时 content 必须为 null（DeepSeek 兼容性要求）
    content: sorted.length > 0 ? null : (content || null),
    tool_calls: sorted.length > 0 ? sorted : undefined,
  };
}
