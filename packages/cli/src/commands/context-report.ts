/**
 * /context 上下文占用报告（纯函数，可单测）
 *
 * 从 InputBox 内联块抽出（文件名不叫 context.ts：那个名字已被 AppContext 占用）。
 * 只做计算与格式化，不碰 Ink/dispatch。
 */
import type { Message, ShenlanConfig } from '@shenlan/core';
import {
  estimateTotalTokens,
  isSummaryMessage,
  buildMemorySection,
  buildRulesSection,
  DEFAULT_MEMORY_TOKEN_BUDGET,
} from '@shenlan/core';
import { formatTokens } from '../render.js';
import type { CompressionRecord } from '../repl.js';

export interface ContextReportInput {
  messages: Message[];
  config: ShenlanConfig;
  /** 当前生效模型（决定窗口上限） */
  model: string;
  /** 模型上下文窗口（token）；由调用方传入以免本模块依赖 router */
  contextWindow: number;
  /** 压缩记录（getCompressionHistory()） */
  history: readonly CompressionRecord[];
  /** 项目目录（记忆行现算用）；缺省 process.cwd() */
  cwd?: string;
}

/**
 * 构建 /context 报告行。
 *
 * 记忆行**现算于磁盘状态**：`--resume` 时 system 消息来自 JSONL，`buildSystemPrompt`
 * 本次进程根本没跑过，任何缓存都不可靠。注意这反映的是「现在重建 prompt 会注入什么」，
 * 与本会话实际已注入的内容可能不同（system prompt 每会话只构建一次）。
 */
export function buildContextReport(input: ContextReportInput): string[] {
  const { messages, config, history, contextWindow } = input;

  const total = estimateTotalTokens(messages);
  const sysTokens = estimateTotalTokens(messages.filter((m) => m.role === 'system'));
  const summaryMsgs = messages.filter((m) => isSummaryMessage(m));
  const summaryTokens = estimateTotalTokens(summaryMsgs);
  const toolTokens = estimateTotalTokens(messages.filter((m) => m.role === 'tool'));

  // 最近 N 个 assistant 轮（与压缩保留区同口径）
  const keepTurns = config.context?.keepRecentTurns ?? 20;
  let recentStart = 0;
  let assistantSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') assistantSeen++;
    if (assistantSeen >= keepTurns) { recentStart = i; break; }
  }
  const recentTokens = estimateTotalTokens(messages.slice(recentStart));
  const middleTokens = Math.max(0, total - sysTokens - summaryTokens - toolTokens - recentTokens);

  const windowLimit = Math.floor(contextWindow * 0.9);
  const limit = Math.min(config.context?.autoCompactTokenLimit ?? 200_000, windowLimit);

  const lines = [
    `  ~${formatTokens(total)} tokens / ${messages.length} msgs（自动压缩阈值 ${formatTokens(limit)}）`,
    `  system ${formatTokens(sysTokens)} · 摘要 ${formatTokens(summaryTokens)} · 最近${keepTurns}轮 ${formatTokens(recentTokens)} · 工具结果 ${formatTokens(toolTokens)} · 中间历史 ${formatTokens(middleTokens)}`,
    `  toolOutputLimit=${formatTokens(config.context?.toolOutputLimitChars ?? 8000)} chars`,
  ];

  const mem = buildMemorySection(input.cwd ?? process.cwd(), {
    maxTokens: config.context?.maxMemoryTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET,
    autoSave: config.memory?.autoSave ?? true,
  });
  if (mem.text) {
    const folded = mem.foldedCount > 0 ? `，已折叠 ${mem.foldedCount} 条` : '';
    // 预算是配置值，原样显示（不走 formatTokens：4096 会被缩成 "4.1k"，
    // 而用户要照它改 context.maxMemoryTokens）
    lines.push(
      `  记忆 ~${formatTokens(mem.tokens)} tokens / 预算 ${mem.budget}（${mem.entryCount} 条${folded}）`,
    );
  }

  // 规则行现算于磁盘（与记忆行同理）：跑飞了要可见，而不是神秘变慢
  const rules = buildRulesSection(input.cwd ?? process.cwd(), {
    maxTokens: config.context?.maxMemoryTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET,
  });
  if (rules.files > 0 || rules.pathsCount > 0) {
    const folded = rules.folded > 0 ? `，已折叠 ${rules.folded} 条` : '';
    const pathsNote = rules.pathsCount > 0
      ? `；paths 条件规则 ${rules.pathsCount} 条按轮注入`
      : '';
    lines.push(
      `  规则 ~${formatTokens(rules.tokens)} tokens（${rules.files} 个文件${folded}${pathsNote}）`,
    );
  }

  if (history.length > 0) {
    const recent = history.slice(-3).map((h) =>
      ` ${h.time.toLocaleTimeString('zh-CN', { hour12: false })} ${h.method === 'llm' ? 'LLM' : '规则'} -${formatTokens(h.savedTokens)}`
    ).join('');
    lines.push(`  压缩记录: ${history.length} 次${recent}`);
  }
  if (total > limit) {
    lines.push('  建议: /compact 手动压缩，或 /clear 新开会话');
  } else if (summaryMsgs.length > 0) {
    lines.push('  提示: 上下文已含压缩摘要，继续输入可接着跑');
  }

  return lines;
}
