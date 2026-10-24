/**
 * 语义压缩 — 85% 压缩 + 50% 软限制
 *
 * 策略（v1）：
 *   1. 保留 system prompt 不变
 *   2. 保留最近 N 条消息不变
 *   3. 中间消息：保留 user/assistant 角色，内容替换为摘要
 *   4. 目标：token 量降到原来的 ~15%（85% 压缩率）
 *   5. 达到 50% 上限时触发压缩
 */
import type { Message } from './provider.js';
import { messageTextOf } from './provider.js';

/**
 * 粗略估算消息的 token 数（约 4 字符 ≈ 1 token）
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 估算消息列表总 token
 */
export function estimateTotalTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (msg.content) {
      total += estimateTokens(JSON.stringify(msg.content));
    }
    if (msg.tool_calls) {
      total += estimateTokens(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

/**
 * 生成消息摘要（简易版：提取关键信息）
 * 后续可换成 LLM 摘要
 */
function summarizeMessage(msg: Message): string {
  const prefix = `[${msg.role}]`;
  if (msg.tool_calls) {
    const toolNames = msg.tool_calls.map((tc) => tc.function.name).join(', ');
    return `${prefix} Called tools: ${toolNames}`;
  }
  if (msg.tool_call_id) {
    const text = messageTextOf(msg);
    const preview = text.slice(0, 100);
    return `${prefix} Tool result: ${preview}${text.length >= 100 ? '...' : ''}`;
  }
  if (typeof msg.content === 'string') {
    const preview = msg.content.slice(0, 80);
    return `${prefix} ${preview}${msg.content.length > 80 ? '...' : ''}`;
  }
  if (Array.isArray(msg.content)) {
    // 多模态消息：提取纯文本 + 图片占位（避免摘要把视觉消息压成空壳）
    const preview = messageTextOf(msg).slice(0, 80);
    return `${prefix} ${preview}`;
  }
  return `${prefix} (non-text content)`;
}

/**
 * 把「保留末尾 N 条」的边界调整到不切断 tool_calls ↔ tool 响应配对。
 *  - 边界落在 tool 响应上 → 左扩到它的 assistant(tool_calls)
 *  - 保留区末尾是未收到响应的 assistant(tool_calls) → 整段移出保留区（交给摘要）
 *
 * 返回调整后的保留区起始下标（0 = 无可压缩的中间段）。
 */
function adjustPairingBoundary(nonSystem: Message[], keepLast: number): number {
  let start = Math.max(0, nonSystem.length - keepLast);

  // 保留区不能从 tool 响应开始：往前找到它的 assistant(tool_calls)
  while (start > 0 && nonSystem[start]?.role === 'tool') {
    start--;
  }

  // 保留区不能以「未回复的 assistant(tool_calls)」结束（其响应若存在必然紧跟其后，
  // 会在保留区内；能出现在末尾说明响应缺失，整段移出避免 API 400）
  while (start > 0) {
    const last = nonSystem[start - 1];
    if (last.role === 'assistant' && last.tool_calls?.length) start--;
    else break;
  }

  return start;
}

/**
 * 剔除破坏 tool_calls ↔ tool 响应配对的残留消息，返回新数组：
 *  - 孤立 tool 响应（本序列中找不到对应 assistant(tool_calls)）→ 丢弃
 *  - 未收到全部响应的 assistant(tool_calls)（连同已收到的部分响应）→ 整段移除
 *
 * 用于修复历史损坏的会话（旧版压缩可能留下孤立 tool，DeepSeek 会以 400 拒绝）。
 */
export function sanitizeMessagePairing(msgs: Message[]): Message[] {
  const out: Message[] = [];
  let expected = new Set<string>();
  let segmentStart = -1;

  const closeSegment = () => {
    if (segmentStart >= 0 && expected.size > 0) {
      out.splice(segmentStart);
    }
    expected = new Set();
    segmentStart = -1;
  };

  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      closeSegment();
      expected = new Set(m.tool_calls.map(tc => tc.id));
      segmentStart = out.length;
      out.push(m);
    } else if (m.role === 'tool' && m.tool_call_id) {
      if (expected.has(m.tool_call_id)) {
        expected.delete(m.tool_call_id);
        out.push(m);
      }
      // 孤立 tool 响应：静默丢弃
    } else if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) {
      // 空 assistant 消息（无 content 且无 tool_calls）：丢弃。
      // 这类消息推入会话后，下一次请求会被 API 以
      // "Invalid assistant message: content or tool_calls must be set" 400 拒绝。
      closeSegment();
    } else {
      closeSegment();
      out.push(m);
    }
  }
  closeSegment();
  return out;
}

/**
 * 压缩消息列表（保留头尾，中间摘要化）
 *
 * @param messages 完整消息列表
 * @param maxTokens 目标 token 上限
 * @param keepLast 保留末尾 N 条完整消息
 * @returns 压缩后的消息列表
 */
export function compressMessages(
  messages: Message[],
  maxTokens: number,
  keepLast: number = 5,
): Message[] {
  const totalTokens = estimateTotalTokens(messages);
  if (totalTokens <= maxTokens) return messages;

  // system 消息不动
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // 太短的不需要压缩
  if (nonSystem.length <= keepLast) return messages;

  // 调整边界，避免切断 tool_calls ↔ tool 响应配对（否则 DeepSeek 400）
  const start = adjustPairingBoundary(nonSystem, keepLast);
  const middle = nonSystem.slice(0, start);
  // 边界调整后无可压缩的中间段：保持原样，不生成空摘要
  if (middle.length === 0) return messages;

  // 中间消息摘要化为一条 assistant 消息
  const summary = middle.map(summarizeMessage).join('\n');
  const summaryMsg: Message = {
    role: 'assistant',
    content: `[Previous conversation summary — ${middle.length} messages compressed]\n${summary}`,
  };

  // 保留区再剔除历史损坏留下的孤立 tool / 未回复的 assistant(tool_calls)
  const tail = sanitizeMessagePairing(nonSystem.slice(start));

  return [...systemMsgs, summaryMsg, ...tail];
}

/**
 * 压缩 v2 — 结构化交接摘要
 *
 * 与 v1 的区别：
 *   - 保留系统消息 + 最近 keepRecentTurns 轮完整消息（按 user 轮计数）
 *   - 中间历史用 LLM（flash）生成单条 user 角色 `_summary` 结构化交接摘要
 *   - 多次压缩只保留最新一条 `_summary`（旧摘要并入中间段被替换）
 *   - LLM 摘要失败/超时 → 降级为改进后的规则摘要（结构化字段，不再逐条预览）
 *   - 压缩后照常 sanitizeMessagePairing 保证 tool_calls ↔ tool 响应配对完整
 */

/** `_summary` 消息内容标记（用于识别既有摘要、去重） */
export const SUMMARY_MARKER = '=== shenlan 上下文交接摘要 (_summary) ===';

/** 判断是否为压缩生成的 `_summary` 消息 */
export function isSummaryMessage(msg: Message): boolean {
  return (
    msg.role === 'user' &&
    typeof msg.content === 'string' &&
    msg.content.includes(SUMMARY_MARKER)
  );
}

export interface CompressV2Options {
  /** 目标 token 上限 */
  maxTokens: number;
  /** 保留最近 N 轮（默认 20，每轮 = 一次 assistant 响应，_summary 是 user 角色不计） */
  keepRecentTurns?: number;
  /** 手动压缩：忽略阈值检查，有可压缩中间段就压缩（/compact 用） */
  force?: boolean;
  /** 压缩聚焦说明（传入 LLM 摘要 prompt） */
  focus?: string;
  /**
   * LLM 摘要回调：输入中间段，返回结构化摘要文本。
   * 返回 null / 抛错 / 超时 → 降级为规则摘要。
   */
  summarize?: (middle: Message[], focus?: string) => Promise<string | null>;
}

export interface CompressV2Result {
  /** 压缩后的消息列表 */
  messages: Message[];
  /** 实际使用的摘要方式 */
  method: 'llm' | 'rule' | 'none';
}

/**
 * 压缩 v2 主入口
 *
 * 返回 { messages, method }：
 *   - method='none'：无可压缩中间段 / 未超限，messages 与原列表相同引用
 */
export async function compressMessagesV2(
  messages: Message[],
  options: CompressV2Options,
): Promise<CompressV2Result> {
  const totalTokens = estimateTotalTokens(messages);
  if (!options.force && totalTokens <= options.maxTokens) {
    return { messages, method: 'none' };
  }

  // system 消息不动
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // 保留区起始：从末尾往回数 keepRecentTurns 个 assistant 轮（每轮 = 一次 LLM 响应，
  // 覆盖工具调用密集的长任务；_summary 是 user 角色不计入），
  // 再调整配对边界，避免切断 tool_calls ↔ tool 响应。
  const keepTurns = options.keepRecentTurns ?? 20;
  let start = nonSystem.length;
  let assistantSeen = 0;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i].role === 'assistant') {
      assistantSeen++;
    }
    if (assistantSeen >= keepTurns) {
      start = i;
      break;
    }
  }

  // 轮数不足（保留区覆盖全部消息）：无可压缩中间段
  if (start >= nonSystem.length) {
    return { messages, method: 'none' };
  }
  start = adjustPairingBoundary(nonSystem, nonSystem.length - start);
  const middle = nonSystem.slice(0, start);
  // 边界调整后无可压缩的中间段：保持原样
  if (middle.length === 0) {
    return { messages, method: 'none' };
  }

  // 生成摘要：优先 LLM，失败降级规则
  let summaryText: string | null = null;
  if (options.summarize) {
    try {
      summaryText = await options.summarize(middle, options.focus);
    } catch {
      summaryText = null;
    }
  }
  const method: 'llm' | 'rule' = summaryText ? 'llm' : 'rule';
  if (!summaryText) {
    summaryText = buildRuleSummary(middle);
  }

  const summaryMsg: Message = {
    role: 'user',
    content: `${SUMMARY_MARKER}\n${summaryText.trim()}`,
  };

  // 保留区剔除历史损坏留下的孤立 tool / 未回复的 assistant(tool_calls)
  const tail = sanitizeMessagePairing(nonSystem.slice(start));
  return { messages: [...systemMsgs, summaryMsg, ...tail], method };
}

/**
 * 改进后的规则摘要（压缩 v2 降级路径）
 *
 * 结构化字段（与 LLM 摘要同构），不再逐条预览：
 *   原始请求 / 已完成事项 / 关键发现与引用索引 / 当前计划 / 下一步待办 / 失败与阻塞
 */
export function buildRuleSummary(middle: Message[]): string {
  const originalRequests: string[] = [];
  const toolNames: string[] = [];
  const assistantNotes: string[] = [];
  const refIds: string[] = [];
  const errors: string[] = [];

  for (const m of middle) {
    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content.trim() : '';
      if (!content || isSummaryMessage(m)) continue;
      originalRequests.push(content.slice(0, 300));
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        toolNames.push(tc.function.name);
      }
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      assistantNotes.push(m.content.trim().slice(0, 150));
    } else if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : '';
      for (const match of content.matchAll(/\[Ref:([0-9a-fA-F]{6,12})\]/g)) {
        refIds.push(match[1]);
      }
      if (/error|ERR_|失败|denied|blocked|timeout|超时/i.test(content.slice(0, 120))) {
        errors.push(content.slice(0, 180));
      }
    }
  }

  const unique = (arr: string[]): string[] => Array.from(new Set(arr));
  const sections = [
    `## 原始请求\n${
      originalRequests.length > 0
        ? originalRequests.slice(0, 5).map((r) => `- ${r}`).join('\n')
        : '（规则摘要，无法还原原始请求原文，请从后续消息延续）'
    }`,
    `## 已完成事项\n${
      unique(toolNames).length > 0
        ? unique(toolNames).map((t) => `- 调用了工具 ${t}`).join('\n')
        : '（无工具调用记录）'
    }`,
    `## 关键发现与引用索引\n${
      [
        refIds.length > 0 ? `- Ref 引用：${unique(refIds).join(', ')}` : '',
        ...assistantNotes.slice(0, 5).map((n) => `- 助手说明：${n}`),
      ].filter(Boolean).join('\n') || '（无记录）'
    }`,
    '## 当前计划\n（由最近消息延续）',
    '## 下一步待办\n（继续执行最近的用户请求）',
    `## 失败与阻塞\n${
      errors.length > 0
        ? errors.slice(0, 5).map((e) => `- ${e}`).join('\n')
        : '（无记录）'
    }`,
  ];
  return sections.join('\n');
}
