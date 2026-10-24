/**
 * refactored — 纯逻辑 agent 循环
 *
 * 不碰 stdout，通过 callbacks 与 Ink UI 通信
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = join(__dirname, '..', 'builtin-skills');

import type { ShenlanConfig, Message, TokenUsage, FunctionDef, Lang } from '@shenlan/core';
import {
  chat,
  chatStream,
  buildSystemPrompt,
  refreshMemorySection,
  globalMemoryDir,
  projectMemoryDir,
  discoverRuleFiles,
  matchPathsRule,
  touchedPathsOfToolCall,
  DEFAULT_MEMORY_TOKEN_BUDGET,
  getAvailableTools,
  getTool,
  executeToolWithTimeout,
  debugLog,
  estimateTotalTokens,
  compressMessagesV2,
  sanitizeMessagePairing,
  loadSkillIndex,
  loadSkillContent,
  buildSkillScanDirs,
  needsConfirmation,
  storeRef,
  resolveApiKey,
  resolveModelProvider,
  resolveBaseUrl,
  expandHome,
  ERR_CODES,
  checkCostGuardrail,
  formatApiError,
  waiveSession,
  waiveDay,
  registerGoalComplete,
  unregisterGoalComplete,
  updateConfig,
  formatCost,
  getSessionCost,
  getDailyCost,
  consumePendingInjections,
  abortAllBackgroundTasks,
  isHighRiskCommand,
  recordAuditEvent,
  loadPitfalls,
  incrementPitfallHits,
  globalPitfallPath,
  classifyApiError,
  IMAGE_MIMES,
  toolResultToMessages,
  messageTextOf,
  defaultCompactModelFor,
  getModelMaxOutputTokens,
  resolveMaxOutputTokens,
} from '@shenlan/core';
import { routeModelSticky, getModelContextWindow, getEffectiveModel, consumeRouteDegradedNotice, findFailoverTarget, isVisionModel } from './router.js';
import { attachInputImages } from './image-input.js';
import { isPlanBlocked, isPlanShellBlocked, getMode } from './mode.js';
import type { PermissionConfig, PermissionMode } from '@shenlan/core';
import { buildFileChange } from './file-change.js';
import type { FileChange } from './file-change.js';
import { approvalLanguage, commandGrant, commandMatchesGrant, type CommandGrant } from './approval-policy.js';
import {
  computeToolSig,
  RepeatTracker,
  OutcomeTracker,
  LOOP_REPEAT_THRESHOLD,
} from './loop-detect.js';

/** 循环纠正消息：检测到重复工具调用后注入（user 角色） */
const LOOP_CORRECTION_MESSAGE =
  '检测到重复调用，请基于已有信息直接回答或换一种方式。不要再调用相同工具、相同参数。';

/** 纠正后连续无进展轮数上限 */
const LOOP_NO_PROGRESS_LIMIT = 6;
/** 10 轮内压缩次数达到该值 → 防抖动停止 */
const COMPACT_THRASH_WINDOW_ROUNDS = 10;
const COMPACT_THRASH_COUNT = 3;

/** 压缩记录（供 /context 展示与防抖动判断） */
export interface CompressionRecord {
  time: Date;
  round: number;
  method: 'llm' | 'rule';
  savedTokens: number;
}

const compressionHistory: CompressionRecord[] = [];
/** 跨 run 的全局轮计数（压缩防抖动按它算窗口，避免每次 run 从 0 重算） */
let globalRound = 0;

/** 压缩记录（只读，供 /context） */
export function getCompressionHistory(): readonly CompressionRecord[] {
  return compressionHistory;
}

/** 清空压缩记录（/clear 时调用） */
export function resetCompressionState(): void {
  compressionHistory.length = 0;
  globalRound = 0;
}

export interface AgentCallbacks {
  onToken: (token: string) => void;
  onThinkingStart?: () => void;
  onThinkingEnd?: () => void;
  onToolStart: (id: string, name: string, detail: string) => void;
  onToolDone: (id: string, name: string, detail: string, resultContent?: string, fileChange?: FileChange) => void;
  onToolError: (id: string, name: string, error: string) => void;
  onConfirm: (info: ConfirmRequestInfo) => Promise<string>;
  onComplete: (usage?: TokenUsage) => void;
  onError: (error: Error) => void;
  onCost?: (model: string, promptTokens: number, completionTokens: number) => void;
  /** 每轮路由后的实际生效模型（sticky 优先），供 UI 状态行/头部同步显示 */
  onModel?: (model: string) => void;
  /** 滚动区系统通知（压缩、步数上限、循环停止等，走 Static 不进 DynamicRegion） */
  onNotice?: (content: string) => void;
}

/** 权限确认请求的完整信息（供 UI 按 Codex CLI 样式渲染） */
export interface ConfirmRequestInfo {
  toolName: string;
  description: string;
  kind: 'edit' | 'create' | 'external' | 'destructive' | 'command' | 'cost-guardrail' | 'high-risk';
  language: Lang;
  /** 文件操作涉及的文件绝对路径（write/edit） */
  paths: string[];
  /** shell 命令原文（command） */
  command: string;
  /** 会话级授权范围的可见描述 */
  prefix: string;
  commandGrant?: CommandGrant;
  /** cost-guardrail 专用：触发维度 */
  guardKind?: 'session' | 'day';
  /** cost-guardrail 专用：触发原因 */
  reason?: string;
  /** high-risk 专用：命中的高危模式 */
  pattern?: string;
  /** high-risk 专用：反馈输入框提示（输入确认短语） */
  feedbackLabel?: string;
}

/** goal 运行参数（/goal 模式；status 非 active 时不进入 goal 逻辑） */
export interface GoalRunParam {
  text: string;
  status: 'active' | 'paused' | 'completed';
}

const GOAL_BLOCK_RE = /<!-- shenlan-goal -->[\s\S]*?<!-- \/shenlan-goal -->/;

/** 注入/移除 system 消息中的 goal 段落（<!-- shenlan-goal --> 标记，随会话 JSONL 持久化） */
function applyGoalBlock(messages: Message[], goalText: string | null): void {
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  if (sysIdx < 0) return;
  const base = messageTextOf(messages[sysIdx]!).replace(GOAL_BLOCK_RE, '').trim();
  const block = goalText
    ? `\n\n<!-- shenlan-goal -->\n## 当前目标（goal mode）\n${goalText}\n持续执行直到目标达成；完成时调用 goal_complete(reason) 工具结束。\n<!-- /shenlan-goal -->`
    : '';
  messages[sysIdx] = { ...messages[sysIdx]!, content: base + block };
}

/** 构建成本护栏确认请求（选项由 UI 层按 guardKind 生成） */
function buildCostGuardrailConfirm(guard: ReturnType<typeof checkCostGuardrail>, language: Lang, config: ShenlanConfig): ConfirmRequestInfo {
  const isDay = guard.kind === 'day';
  const englishReason = `${isDay ? 'Today' : 'This session'}: ${formatCost(isDay ? getDailyCost().costCny : getSessionCost().costCny)} reached the ${isDay ? 'daily' : 'session'} limit of ${formatCost(isDay ? config.costGuardrails?.maxCostPerDay ?? 0 : config.costGuardrails?.maxCostPerSession ?? 0)}`;
  return {
    language,
    toolName: 'cost-guardrail',
    description: language === 'zh-CN' ? '成本护栏已触发' : 'Cost limit reached',
    kind: 'cost-guardrail',
    paths: [],
    command: '',
    prefix: '',
    guardKind: guard.kind,
    reason: language === 'zh-CN' ? guard.reason || '成本已达上限' : englishReason,
  };
}

// Session-level caches
const sessionAllow = new Set<string>();
const sessionDeny = new Set<string>();
/** “以后不再询问这些文件”：已批准的绝对路径 */
const sessionAllowedPaths = new Set<string>();
const sessionAllowedCommands: CommandGrant[] = [];

export function clearSessionApprovals(): void {
  sessionAllow.clear();
  sessionDeny.clear();
  sessionAllowedPaths.clear();
  sessionAllowedCommands.length = 0;
}

// Emergency stop signal
let globalAbort = false;
export function triggerStop() {
  globalAbort = true;
  // /stop 同时终止全部运行中后台任务（§26.5）
  abortAllBackgroundTasks();
}
export function resetStop() { globalAbort = false; }

export function injectFileRefs(message: string, cwd: string): string {
  const refs = message.match(/@([^\s]+\.[a-zA-Z0-9]{1,6})(\s|$)/g);
  if (!refs || refs.length === 0) return message;

  let enriched = message;
  for (const ref of refs) {
    const filePath = ref.slice(1).trim();
    // 图片引用不注入文本：视觉模型走首轮直传/view_image 工具，
    // 防止二进制被当 utf-8 文本读成乱码塞进上下文
    if (IMAGE_MIMES[extname(filePath).toLowerCase()]) continue;
    try {
      const resolved = join(cwd, filePath);
      if (existsSync(resolved) && statSync(resolved).isFile()) {
        const content = readFileSync(resolved, 'utf-8');
        const preview = content.slice(0, 4000);
        const truncated = preview.length < content.length ? '\n...(truncated)' : '';
        enriched += `\n\n--- @${filePath} ---\n${preview}${truncated}\n--- end @${filePath} ---`;
      }
    } catch { /* skip */ }
  }
  return enriched;
}

/**
 * 坑记忆动作前检查（写入动作前扫描 hard 坑，§14）。
 * 结构化判定（pitfall-store 解析 severity 字段）；兼容旧格式：
 * 无 trigger 字段的条目以「正文包含命令/路径」匹配（原行为）。
 * 拦截命中时 hits+1（反馈闭环）。
 */
function checkPitfalls(toolName: string, args: Record<string, unknown>): string | null {
  if (!['write', 'edit', 'shell'].includes(toolName)) return null;
  const entries = loadPitfalls(process.cwd());
  if (entries.length === 0) return null;
  const cmd = (args.command as string) || '';
  const fp = (args.file_path as string) || '';
  const triggers = [cmd, fp, toolName].filter(Boolean);

  for (const entry of entries) {
    if (entry.severity !== 'hard') continue;
    const entryTriggers = entry.trigger.split(/[,，]/).map(t => t.trim()).filter(t => t.length > 2);
    const structuredHit = entryTriggers.find(t =>
      triggers.some(trigger => trigger.toLowerCase().includes(t.toLowerCase())));
    // 旧格式兼容：正文包含命令/路径（原 checkPitfalls 行为）
    const legacyHit = triggers.find(t =>
      t.length > 2 && entry.body.toLowerCase().includes(t.toLowerCase()));
    const hitKeyword = structuredHit || legacyHit;
    if (hitKeyword) {
      const file = entry.source === 'project'
        ? join(process.cwd(), '.shenlan', 'pitfalls.md')
        : globalPitfallPath();
      incrementPitfallHits(file, entry.title);
      return `${ERR_CODES.HIGH_RISK_BLOCKED}: ${hitKeyword} — blocked by pitfall hard constraint`;
    }
  }
  return null;
}

/**
 * C2 刷新回路：记忆目录（全局 + 项目）的最近 mtime 缓存，跨 run 生效。
 * 记忆目录每次变化（memory_save 原子写、/memory rm、外部编辑）都会翻新目录
 * mtime —— 用它做变化检测比在工具结果里逐个挂钩更省事，还能覆盖用户侧操作。
 */
let memoryDirsMtimeNs = 0;

function memoryDirsMaxMtimeNs(): number {
  let max = 0;
  for (const dir of [globalMemoryDir(), projectMemoryDir(process.cwd())]) {
    try {
      const s = statSync(dir);
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch { /* 目录不存在 → 保持 0 */ }
  }
  return max;
}

/**
 * 记忆目录有变动时，只重建 messages[0] 的记忆段（refreshMemorySection 定位
 * START/END 标记替换，其余部分逐字节不变 → provider prompt 缓存仍命中）。
 * 无 system 消息（首次运行）或旧 --resume 消息缺标记时静默跳过。
 */
function refreshSystemMemoryIfChanged(messages: Message[], config: ShenlanConfig): void {
  const mtime = memoryDirsMaxMtimeNs();
  if (mtime === memoryDirsMtimeNs) return;
  memoryDirsMtimeNs = mtime;
  const sys = messages.find((m) => m.role === 'system');
  if (!sys || typeof sys.content !== 'string') return;
  const refreshed = refreshMemorySection(sys.content, process.cwd(), {
    maxMemoryTokens: config.context?.maxMemoryTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET,
    memoryAutoSave: config.memory?.autoSave ?? true,
  });
  if (refreshed !== sys.content) {
    sys.content = refreshed;
    debugLog('Memory section refreshed', { mtime });
  }
}

/**
 * 坑命中反馈（§14）：工具失败且错误匹配已知 trigger → hits+1 + notice；
 * soft 坑 hits ≥ 3 提示升级（不自动升级）。只记第一个命中的坑，避免噪音。
 */
function recordPitfallHitOnError(
  result: { content: string; isError?: boolean },
  config: ShenlanConfig,
  callbacks: AgentCallbacks,
): void {
  if (!result.isError) return;
  if (!(config.pitfallMemory?.autoRecordOnError ?? true)) return;
  const entries = loadPitfalls(process.cwd());
  if (entries.length === 0) return;
  const text = result.content.toLowerCase();
  for (const entry of entries) {
    const entryTriggers = entry.trigger.split(/[,，]/).map(t => t.trim()).filter(t => t.length > 2);
    const matched = entryTriggers.find(t => text.includes(t.toLowerCase()));
    if (!matched) continue;
    const file = entry.source === 'project'
      ? join(process.cwd(), '.shenlan', 'pitfalls.md')
      : globalPitfallPath();
    const newHits = incrementPitfallHits(file, entry.title);
    if (newHits >= 0) {
      callbacks.onNotice?.(`坑命中：${entry.title}（hits=${newHits}）`);
      if (entry.severity === 'soft' && newHits >= 3) {
        callbacks.onNotice?.(`坑「${entry.title}」已命中 ${newHits} 次，可考虑升级为 hard（/pitfall）`);
      }
    }
    break;
  }
}

function describeAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'shell') return 'Shell: ' + ((args.command as string) || '').slice(0, 150);
  if (toolName === 'write') return 'Write: ' + (args.file_path as string || '');
  if (toolName === 'edit') return 'Edit: ' + (args.file_path as string || '');
  if (toolName === 'read') return 'Read: ' + (args.file_path as string || '');
  return toolName;
}

/** 构建权限确认请求信息 */
function buildConfirmInfo(toolName: string, args: Record<string, unknown>, language: Lang): ConfirmRequestInfo {
  const command = toolName === 'shell' ? String(args.command || '') : '';
  const filePath = (args.file_path as string) || '';
  const paths = filePath ? [resolve(process.cwd(), expandHome(filePath))] : [];
  const grant = toolName === 'shell' ? commandGrant(command) : undefined;
  const annotations = getTool(toolName)?.annotations;
  const kind = toolName === 'shell' ? 'command'
    : toolName === 'write' && filePath && !existsSync(paths[0]!) ? 'create'
    : toolName === 'write' || toolName === 'edit' ? 'edit'
    : annotations?.destructiveHint ? 'destructive' : 'external';
  return {
    language,
    toolName,
    description: describeAction(toolName, args),
    kind,
    paths,
    command,
    prefix: grant?.label || '',
    commandGrant: grant,
  };
}

/** 高危动作双确认请求（§11：输入确认短语放行一次） */
function buildHighRiskConfirmInfo(command: string, pattern: RegExp, phrase: string, language: Lang): ConfirmRequestInfo {
  return {
    language,
    toolName: 'shell',
    description: `High-risk: ${command.slice(0, 150)}`,
    kind: 'high-risk',
    paths: [],
    command,
    prefix: '',
    pattern: pattern.source.slice(0, 40),
    feedbackLabel: language === 'zh-CN' ? `输入确认短语「${phrase}」后回车（Esc 拒绝）` : `Type "${phrase}" and press Enter (Esc denies)`,
  };
}

/** 单次 LLM 流式调用（供故障转移重试复用；thinking 判定随每次尝试重置） */
function llmCallOnce(
  model: string,
  config: ShenlanConfig,
  messages: Message[],
  tools: FunctionDef[] | undefined,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  maxTokensOverride?: number,
): Promise<{ assistantMsg: Message | null; error?: Error; usage?: TokenUsage }> {
  return new Promise((resolve) => {
    let thinkingDone = false;
    const provider = resolveModelProvider(config, model);
    const apiKey = resolveApiKey(config, provider);
    chatStream(
      {
        ...config.model,
        baseUrl: resolveBaseUrl(config, model),
        model,
        apiKey,
        ...(maxTokensOverride && maxTokensOverride > 0 ? { maxTokens: maxTokensOverride } : {}),
      },
      messages,
      tools,
      {
        onToken(token) {
          if (!thinkingDone) {
            thinkingDone = true;
            callbacks.onThinkingEnd?.();
          }
          callbacks.onToken(token);
        },
        onToolCall() {
          if (!thinkingDone) {
            thinkingDone = true;
            callbacks.onThinkingEnd?.();
          }
        },
        onComplete(msg, use) {
          resolve({ assistantMsg: msg, usage: use, error: undefined });
        },
        onError(err) {
          resolve({ assistantMsg: null, error: err });
        },
      },
      signal,
    ).catch(err => resolve({ assistantMsg: null, error: err }));
  });
}

/** 故障转移可重试错误：5xx / 402 余额不足 / 429 限流 / 网络 / 超时（4xx 请求侧错误不切换） */
function isFailoverRetryable(err: Error): boolean {
  if (/^API error\s+5\d\d\b/.test(err.message)) return true;
  const kind = classifyApiError(err).kind;
  return ['quota', 'rate_limited', 'network', 'timeout'].includes(kind);
}

/** 瞬时网络错误（同 provider 自动重试一次）：undici 通用 fetch failed / 网络 / 超时 */
function isNetworkRetryable(err: Error): boolean {
  if (/fetch failed/i.test(err.message)) return true;
  return ['network', 'timeout'].includes(classifyApiError(err).kind);
}

/**
 * 端点拒绝输出预算参数（400）：多为 max_tokens / max_completion_tokens 超上限。
 * 用于「放大输出预算被打回时」自动降级回用户配置值重试一次，避免把请求打挂。
 */
function isMaxTokensParamError(err: Error): boolean {
  if (!/^API error\s+4\d\d\b/.test(err.message)) return false;
  return /max_tokens|max_completion_tokens|max output|maximum output|output token|too large|exceed/i.test(err.message);
}

/** 动作审计记录（§11）：auditEnabled=false 时普通事件跳过，高危恒记录（audit.ts 内部语义） */
function recordAudit(
  toolName: string,
  args: Record<string, unknown>,
  rule: string,
  result: 'allowed' | 'denied' | 'blocked',
  config: ShenlanConfig,
): void {
  recordAuditEvent(
    { tool: toolName, args, rule, result },
    process.cwd(),
    config.actionSafety?.auditEnabled ?? true,
  );
}

/**
 * 权限判断的生效模式：运行时模式优先（Shift+Tab 切换立即生效），
 * plan 态的写拦截由 isPlanBlocked 单独负责，权限语义沿用配置。
 */
function effectivePermissionMode(config: ShenlanConfig): PermissionMode {
  const runtime = getMode();
  if (runtime === 'plan') return config.permissions.mode;
  return runtime;
}

function effectivePermissions(config: ShenlanConfig): PermissionConfig {
  const mode = effectivePermissionMode(config);
  if (mode === config.permissions.mode) return config.permissions;
  return { ...config.permissions, mode };
}

/**
 * 判断本次工具调用是否仍需要用户确认。
 * 除工具级 sessionAllow 外，还支持 Codex CLI 风格的细粒度免询问：
 *   - write/edit：文件路径已在 sessionAllowedPaths
 *   - shell：只复用安全命令族或完整命令的授权
 */
function needsManualConfirm(
  toolName: string,
  args: Record<string, unknown>,
  config: ShenlanConfig,
): boolean {
  const annotations = getTool(toolName)?.annotations;
  if (toolName.startsWith('mcp__') && annotations?.destructiveHint) return true;
  if (!needsConfirmation(toolName, effectivePermissions(config), annotations)) return false;
  if (sessionAllow.has(toolName)) return false;
  if (sessionDeny.has(toolName)) return true;

  if (toolName === 'write' || toolName === 'edit') {
    const filePath = (args.file_path as string) || '';
    if (filePath && sessionAllowedPaths.has(resolve(process.cwd(), expandHome(filePath)))) return false;
  }
  if (toolName === 'shell') {
    const command = String(args.command || '');
    if (sessionAllowedCommands.some(grant => commandMatchesGrant(command, grant))) return false;
  }
  return true;
}

function getToolDetail(toolName: string, argsStr: string): string {
  try {
    const args = JSON.parse(argsStr || '{}');
    if (toolName === 'shell' && args.command) return args.command.slice(0, 100);
    if (args.file_path) return args.file_path.slice(0, 80);
    if (args.pattern) return args.pattern.slice(0, 60);
    if (args.query) return args.query.slice(0, 80);
  } catch { /* skip */ }
  return '';
}

/**
 * 修复历史/中断会话留下的配对损坏：
 *  - 尾部未收到响应的 assistant(tool_calls) 整段移除（中断的 agent loop）
 *  - 孤立 tool 响应（旧版压缩可能留下）丢弃
 * 否则 API 会以 400 拒绝（tool 消息必须跟在带 tool_calls 的 assistant 之后）。
 */
function cleanIncompleteToolCalls(messages: Message[]): void {
  const cleaned = sanitizeMessagePairing(messages);
  if (cleaned.length !== messages.length) {
    // 保持原地修改（state.messages 是共享引用）
    messages.length = 0;
    messages.push(...cleaned);
  }
}

/** 压缩触发阈值：min(配置, 90% × 模型窗口)（Codex 同款硬上限） */
function getCompactLimit(config: ShenlanConfig, model: string): number {
  const windowLimit = Math.floor(getModelContextWindow(model) * 0.9);
  return Math.min(config.context?.autoCompactTokenLimit ?? 200_000, windowLimit);
}

const SUMMARY_PROMPT = `你正在压缩一段长对话，生成一份供后续继续执行的交接摘要。
只输出摘要正文，不要客套，不要复述消息原文，中文输出。

必须按以下结构输出（Markdown）：
## 原始请求
## 已完成事项（包含涉及的文件路径与执行的命令）
## 关键发现与引用索引（如 [Ref:xxxx] 引用，保留 refId）
## 当前计划
## 下一步待办
## 失败与阻塞

保留重要文件名、路径、命令、refId；不确定的写"需确认"，不要编造。`;

/**
 * 用主模型同 provider 的轻量模型生成结构化交接摘要
 * （deepseek → deepseek-v4-flash，qwen → qwen-plus；显式配置 context.compactModel 时尊重）。
 * 失败 / 超时 / 无 API key → 返回 null（调用方降级为规则摘要），不阻断会话。
 */
async function summarizeWithLLM(
  middle: Message[],
  focus: string | undefined,
  config: ShenlanConfig,
): Promise<string | null> {
  // 压缩默认模型按主模型 provider 映射（#13）：未登记的第三方 provider 兜底主模型本身，
  // 绝不跨 provider 送会话历史（避免 openai 用户拿空 deepseek key 调用或降级无摘要）
  const defaultCompact = defaultCompactModelFor(resolveModelProvider(config, getEffectiveModel())) ?? getEffectiveModel();
  const compactModel = config.context?.compactModel || defaultCompact;
  const provider = resolveModelProvider(config, compactModel);
  const apiKey = resolveApiKey(config, provider);
  if (!apiKey) return null;

  const focusLine = focus ? `\n本次压缩聚焦：${focus}` : '';
  // 压缩模型是文本模型：图片消息先降为纯文本（防止 image_url 进摘要请求 400）
  const summaryMessages: Message[] = [
    ...middle.map((m) => ({
      ...m,
      content: typeof m.content === 'string' || m.content === null ? m.content : messageTextOf(m),
    })),
    { role: 'user', content: SUMMARY_PROMPT + focusLine },
  ];

  try {
    // 摘要调用最多等 60s，超时视为失败走降级（不阻塞会话）
    const text = await Promise.race([
      chat(
        { ...config.model, baseUrl: resolveBaseUrl(config, compactModel), model: compactModel, apiKey },
        summaryMessages,
        undefined,
      ).then((resp) => resp.choices?.[0]?.message?.content?.trim() || ''),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(''), 60_000);
        timer.unref?.();
      }),
    ]);
    if (!text) return null;
    debugLog('Context compression — LLM summary generated', {
      compactModel,
      middleLen: middle.length,
      summaryLen: text.length,
    });
    return text.slice(0, 6000);
  } catch (err) {
    debugLog('Context compression — LLM summary failed, fallback to rule', {
      error: (err as Error).message,
    });
    return null;
  }
}

export interface CompactContextResult {
  method: 'llm' | 'rule' | 'none';
  savedTokens: number;
}

/**
 * 手动压缩（/compact [focus]）。
 * 原地修改 messages（与 runAgentLoop 相同的共享引用约定）。
 */
export async function compactContext(
  config: ShenlanConfig,
  messages: Message[],
  focus?: string,
): Promise<CompactContextResult> {
  const limit = getCompactLimit(config, getEffectiveModel());
  const before = estimateTotalTokens(messages);
  const result = await compressMessagesV2(messages, {
    maxTokens: limit,
    keepRecentTurns: config.context?.keepRecentTurns ?? 20,
    force: true, // /compact 是手动命令：有可压缩中间段就压缩，不受阈值阻挡
    focus,
    summarize: (middle, f) => summarizeWithLLM(middle, f, config),
  });
  const after = estimateTotalTokens(result.messages);
  if (result.method !== 'none') {
    messages.length = 0;
    messages.push(...result.messages);
    compressionHistory.push({
      time: new Date(),
      round: globalRound,
      method: result.method,
      savedTokens: Math.max(0, before - after),
    });
  }
  return {
    method: result.method,
    savedTokens: Math.max(0, before - after),
  };
}

export async function runAgentLoop(
  _input: string,           // deprecated — last user msg is already in messages
  config: ShenlanConfig,
  messages: Message[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  goal?: GoalRunParam | null,
): Promise<void> {
  // Last user message is already pushed to messages by the caller/reducer
  // Extract it for file refs / skill resolution
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastInput = userMsgs.length > 0 ? messageTextOf(userMsgs[userMsgs.length - 1]!) : _input;
  const confirmLanguage = approvalLanguage(lastInput, config.language ?? 'en');

  const enriched = injectFileRefs(lastInput, process.cwd());

  // $skillname trigger
  let finalInput = enriched;
  const skillMatch = enriched.match(/\$(\w[\w-]*)/);
  if (skillMatch) {
    const skillName = skillMatch[1];
    const skills = loadSkillIndex(buildSkillScanDirs(process.cwd(), config, [BUILTIN_SKILLS_DIR]));
    const content = loadSkillContent(skillName, skills);
    if (content) {
      finalInput = enriched + '\n\n--- Skill loaded ---\n' + content;
    }
  }

  // Replace last user message with enriched version
  if (finalInput !== lastInput && userMsgs.length > 0) {
    messages[messages.indexOf(userMsgs[userMsgs.length - 1])] = { role: 'user', content: finalInput };
  }


  // C2 刷新回路：跨 run 的记忆目录变动（/memory rm、外部编辑）→ 先刷新既有
  // system 记忆段（首次运行无 system 消息时为 no-op，随后由下面守卫全新构建）
  refreshSystemMemoryIfChanged(messages, config);

  if (messages.filter(m => m.role === 'system').length === 0) {
    const systemPrompt = buildSystemPrompt(process.cwd(), {
      builtinSkillDirs: [BUILTIN_SKILLS_DIR],
      skillDirs: buildSkillScanDirs(process.cwd(), config, [BUILTIN_SKILLS_DIR]),
      memoryAutoSave: config.memory?.autoSave ?? true,
      maxMemoryTokens: config.context?.maxMemoryTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET,
    });
    messages.unshift({ role: 'system', content: systemPrompt });
  }

  // Clean up incomplete tool_calls from a previously aborted run.
  // If the last assistant message has tool_calls but not all have tool responses,
  // the API will reject the request with error 400.
  cleanIncompleteToolCalls(messages);

  // goal 模式：注入/移除系统提示中的目标段落（标记随会话 JSONL 持久化，--resume 可恢复）
  const goalMode = Boolean(goal && goal.status === 'active');
  applyGoalBlock(messages, goalMode ? goal!.text : null);

  // goal_complete 工具仅在 goal 模式注册进工具列表；非 goal 模式确保卸载
  if (goalMode) registerGoalComplete();
  else unregisterGoalComplete();

  const tools = getAvailableTools(config);
  // 会话级模型粘性：本会话首个路由结果在后续轮次沿用（/model 切换时重置）
  const stickyModel = await routeModelSticky(lastInput, config);
  callbacks.onModel?.(stickyModel);
  // 首轮直传：@图片 + 视觉模型 → 最后一条 user 消息展开为 content parts
  attachInputImages(messages, finalInput, stickyModel, process.cwd());
  // 图片降级路由提示（只提示一次）
  const degradedNotice = consumeRouteDegradedNotice();
  if (degradedNotice) callbacks.onNotice?.(degradedNotice);
  const maxSteps = goalMode ? (config.agent?.goalMaxSteps ?? 300) : (config.agent?.maxSteps ?? 80);
  const compactLimit = getCompactLimit(config, stickyModel);
  const keepRecentTurns = config.context?.keepRecentTurns ?? 20;
  const toolOutputLimitChars = config.context?.toolOutputLimitChars ?? 8000;
  const repeatTracker = new RepeatTracker();
  const outcomeTracker = new OutcomeTracker();
  // C3 paths: 条件规则 —— 不进 system prompt，按本轮触及文件动态注入；
  // 每条规则每次运行只注入一次（同一轮反复读同一文件不重复灌）
  const pathsRules = discoverRuleFiles(process.cwd()).rules.filter(
    (r) => r.paths && r.paths.length > 0,
  );
  const injectedPathRules = new Set<string>();

  // ── 输出预算解析（根治“思考吃光 max_tokens → 正文为空”）────────────────────
  // 思考模型的推理与正文共享输出额度：配置的 model.maxTokens 若是 8192，
  // 推理一动就耗尽，正文再也吐不出来。策略：
  //   desired = max(configured, 思考下限, 截断升级值)
  //   cap     = 模型目录 maxOutputTokens（或显式 model.maxOutputTokens）
  //   effective = min(desired, cap)   —— 且绝不低于 configured 用户值
  const configuredMaxTokens = config.model.maxTokens || 8192;
  const outputCapFor = (m: string): number =>
    Math.max(config.model.maxOutputTokens ?? getModelMaxOutputTokens(m) ?? configuredMaxTokens, configuredMaxTokens);

  /** 空回复兜底：同一轮运行内只自动重试一次 */
  let emptyReplyRetried = false;
  /** 截断升级值（finish_reason=length 时逐级抬高输出预算，上限为模型 cap） */
  let maxTokensOverride: number | undefined;
  /** 截断续写次数（有正文但被 length 截断时，追加“继续”让它接着写） */
  let continuations = 0;
  /** 单次运行内截断升级次数上限，防止与端点死循环 */
  const MAX_TRUNCATION_ESCALATIONS = 2;
  let truncationEscalations = 0;

  /** 端点拒绝了放大后的输出预算 → 强制回落用户配置基线（不再放大，避免 400 死循环） */
  let forceBaselineBudget = false;
  const budgetFor = (m: string): number => {
    if (forceBaselineBudget) return configuredMaxTokens;
    return resolveMaxOutputTokens(m, {
      configured: configuredMaxTokens,
      capOverride: config.model.maxOutputTokens,
      thinkingFloor: config.context?.thinkingOutputFloor,
      escalateTo: maxTokensOverride,
    });
  };
  let noProgressRounds = 0;
  let lastContent = '';
  let loopCorrectionInjected = false;
  let roundsAfterCorrection = 0;
  let thrashStopped = false;
  /** 本轮运行已预警过的成本占比（避免每轮重复弹 onNotice） */
  let warnedRatio = 0;
  /** goal 模式：模型已调用 goal_complete，下一轮无工具调用即收尾 */
  let goalAchieved = false;

  for (let round = 0; round < maxSteps; round++) {
    globalRound++;

    // Abort signal
    if (signal?.aborted || globalAbort) {
      if (globalAbort) {
        debugLog('Agent Loop — stopped via ESC', { round, msgCount: messages.length });
        resetStop();
        cleanIncompleteToolCalls(messages);
        callbacks.onError(new Error('Stopped'));
      } else {
        debugLog('Agent Loop — aborted via signal', { round });
      }
      return;
    }

    // 上下文压缩：超过阈值才触发（默认 200k，昨天的 ~30k 场景不再压缩）。
    // 10 轮内已压缩 3 次仍超限 → 防抖动停止（防 Codex v0.112 式死亡螺旋）。
    const currentTokens = estimateTotalTokens(messages);
    if (currentTokens > compactLimit && !thrashStopped) {
      const recentCompactions = compressionHistory.filter(
        (h) => globalRound - h.round <= COMPACT_THRASH_WINDOW_ROUNDS,
      );
      if (recentCompactions.length >= COMPACT_THRASH_COUNT) {
        thrashStopped = true;
        callbacks.onNotice?.('检测到反复压缩循环，建议新开会话或 /clear');
        callbacks.onComplete();
        return;
      }

      const result = await compressMessagesV2(messages, {
        maxTokens: compactLimit,
        keepRecentTurns,
        summarize: (middle, focus) => summarizeWithLLM(middle, focus, config),
      });
      if (result.method !== 'none') {
        const saved = currentTokens - estimateTotalTokens(result.messages);
        messages.length = 0;
        messages.push(...result.messages);
        compressionHistory.push({
          time: new Date(),
          round: globalRound,
          method: result.method,
          savedTokens: Math.max(0, saved),
        });
        callbacks.onNotice?.('上下文已压缩，/context 查看');
      }
    }

    // 后台任务结果注入：每次 LLM 调用前消费一次（只注入一次，不打断在途请求，§26.4）
    const injections = consumePendingInjections();
    if (injections.length > 0) {
      for (const inj of injections) {
        const mark = inj.success ? 'done' : 'failed';
        messages.push({
          role: 'user',
          content: `[background task ${inj.taskId} ${mark}] Goal: ${inj.goal}\nSummary: ${inj.summary}`,
        });
        callbacks.onNotice?.(`${inj.success ? '✓' : '✗'} bg: ${inj.goal} ${mark}`);
      }
    }

    // 成本护栏：每次 LLM 调用前检查会话/单日上限。
    // goal 模式只预警不硬停（usage 照常记账）；普通模式超限弹窗让用户选择：
    // 停止（默认）/ 本次继续（豁免）/ 调高上限（反馈输入新值后写回配置）。
    // headless run 不经过此循环，护栏仅作用于交互式 CLI。
    const guard = checkCostGuardrail(config.costGuardrails);
    if (guard.blocked && goalMode) {
      if (guard.ratio > warnedRatio) {
        warnedRatio = guard.ratio;
        callbacks.onNotice?.(`成本护栏：${guard.reason}（goal 模式仅预警不拦截，/budget 查看）`);
      }
    } else if (guard.blocked) {
      const decision = await callbacks.onConfirm(buildCostGuardrailConfirm(guard, confirmLanguage, config));
      if (decision === 'stop' || decision === 'deny') {
        callbacks.onNotice?.(`成本护栏已触发：${guard.reason}（/budget 查看，/clear 重置会话成本）`);
        callbacks.onComplete();
        return;
      }
      if (decision === 'abort') {
        callbacks.onError(new Error('已终止'));
        return;
      }
      if (decision === 'continue') {
        if (guard.kind === 'day') waiveDay();
        else waiveSession();
        callbacks.onNotice?.(`已豁免${guard.kind === 'day' ? '今日' : '本会话'}上限，继续执行`);
      } else if (decision.startsWith('deny_feedback:')) {
        const raw = decision.slice('deny_feedback:'.length).trim();
        const val = Number(raw);
        if (Number.isFinite(val) && val > 0) {
          const current = config.costGuardrails ?? {
            enabled: true,
            maxCostPerSession: 5,
            maxCostPerDay: 20,
            currency: 'CNY',
          };
          const next: NonNullable<ShenlanConfig['costGuardrails']> = {
            enabled: current.enabled ?? true,
            maxCostPerSession: current.maxCostPerSession ?? 5,
            maxCostPerDay: current.maxCostPerDay ?? 20,
            currency: current.currency ?? 'CNY',
          };
          if (guard.kind === 'day') next.maxCostPerDay = val;
          else next.maxCostPerSession = val;
          config.costGuardrails = next;
          try {
            updateConfig({ costGuardrails: next }, { scope: 'global' });
          } catch { /* 写失败不阻断本次运行 */ }
          callbacks.onNotice?.(`已调高${guard.kind === 'day' ? '单日' : '本会话'}上限至 ${formatCost(val)}`);
        } else {
          callbacks.onNotice?.(`无效上限 "${raw}"，本次已停止`);
          callbacks.onComplete();
          return;
        }
      }
    } else if (!goalMode && guard.level === 'warn' && guard.ratio > warnedRatio) {
      warnedRatio = guard.ratio;
      callbacks.onNotice?.(`成本预警：已用 ${Math.round(guard.ratio * 100)}%（/budget 查看，超限可弹窗继续）`);
    }

    // 新一轮 LLM 请求开始：通知 UI 进入 thinking（显示 spinner）
    callbacks.onThinkingStart?.();

    // Call LLM with streaming。
    // 1) 瞬时网络错误（fetch failed/网络/超时）：同 provider 自动重试一次——
    //    网络抖动不打断任务（用户中止不重试）
    // 2) provider 故障转移：默认关；5xx/402/429/超时/网络且备用 provider
    //    有 key 时切换同档模型重试一次（§25）
    let result = await llmCallOnce(stickyModel, config, messages, tools.length > 0 ? tools : undefined, callbacks, signal, budgetFor(stickyModel));
    if (result.error && !signal?.aborted && !globalAbort && isNetworkRetryable(result.error)) {
      debugLog('Agent Loop — LLM network error, retrying same provider', {
        round, model: stickyModel, error: result.error.message,
      });
      await new Promise((r) => setTimeout(r, 500));
      const retry = await llmCallOnce(stickyModel, config, messages, tools.length > 0 ? tools : undefined, callbacks, signal, budgetFor(stickyModel));
      if (!retry.error) {
        debugLog('Agent Loop — LLM network retry succeeded', { round, model: stickyModel });
        result = retry;
      }
    }
    // 输出预算放大被端点拒绝（400 max_tokens 超上限）：回落用户配置基线重试一次
    if (result.error && !signal?.aborted && !globalAbort && !forceBaselineBudget && isMaxTokensParamError(result.error)) {
      debugLog('Agent Loop — output budget rejected by endpoint, falling back to baseline', {
        round, model: stickyModel, budget: budgetFor(stickyModel), error: result.error.message,
      });
      forceBaselineBudget = true;
      maxTokensOverride = undefined;
      const baseline = await llmCallOnce(stickyModel, config, messages, tools.length > 0 ? tools : undefined, callbacks, signal, configuredMaxTokens);
      if (!baseline.error) {
        callbacks.onNotice?.(`端点不接受放大的输出预算，已回落 max_tokens=${configuredMaxTokens}`);
        result = baseline;
      }
    }
    if (result.error && config.providerFailover?.enabled === true) {
      const failoverTarget = findFailoverTarget(stickyModel, config);
      if (failoverTarget && isFailoverRetryable(result.error)) {
        const second = await llmCallOnce(failoverTarget, config, messages, tools.length > 0 ? tools : undefined, callbacks, signal, budgetFor(failoverTarget));
        if (!second.error) {
          recordAuditEvent(
            {
              tool: 'llm',
              args: { from: stickyModel, to: failoverTarget, reason: classifyApiError(result.error).kind },
              rule: 'failover',
              result: 'allowed',
            },
            process.cwd(),
            config.actionSafety?.auditEnabled ?? true,
          );
          callbacks.onNotice?.(`主 provider 失败，已切换 ${failoverTarget} 重试`);
          result = second;
        }
      }
    }
    const { assistantMsg, error, usage } = result;

    if (error) {
      // ESC 中断（globalAbort）：统一报 Stopped，让用户看到明确反馈；
      // 纯信号中止（新消息打断 / 组件卸载）：静默返回，不弹 API abort 错误。
      if (globalAbort) {
        debugLog('Agent Loop — stopped via ESC during LLM stream', { round });
        resetStop();
        cleanIncompleteToolCalls(messages);
        callbacks.onError(new Error('Stopped'));
      } else if (signal?.aborted) {
        debugLog('Agent Loop — aborted during LLM stream', { round });
      } else {
        // 统一 API 错误分类：401/402/403/429/模型不存在/超时/网络 → 可操作提示
        debugLog('Agent Loop — LLM error (task stopped)', {
          round, model: stickyModel, error: formatApiError(error),
        });
        callbacks.onError(new Error(formatApiError(error)));
      }
      return;
    }

    if (!assistantMsg) return;

    // 每轮 LLM 响应都记账（含工具调用轮，它们才是最贵的轮次），
    // 真实 usage 按价格表折算进会话成本，供 /cost /budget 展示。
    if (usage) callbacks.onCost?.(stickyModel, usage.promptTokens, usage.completionTokens);

    debugLog('Agent Loop — assistant message received', {
      round,
      contentLen: (assistantMsg.content || '').length,
      content: assistantMsg.content || '',
      hasToolCalls: !!(assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0),
      toolCallsCount: assistantMsg.tool_calls?.length || 0,
      toolNames: assistantMsg.tool_calls?.map(tc => tc.function.name).join(', ') || '(none)',
      messagesLen: messages.length,
    });

    const content = messageTextOf(assistantMsg);
    const toolCalls = assistantMsg.tool_calls || [];

    // ── 截断（finish_reason=length）与空回复的根治处理 ─────────────────────────
    // 输出额度由「推理 + 正文」共享：推理过长 → 正文被截断/为空。
    // 处理原则：能抬预算就抬（上限为模型 cap）；已是长正文被截断则追加“继续”续写；
    // 实在无路可走才给出可操作提示收尾（绝不静默丢弃已生成的内容）。
    const truncated = usage?.finishReason === 'length';
    const reasonChars = usage?.reasoningChars ?? 0;
    const MAX_CONTINUATIONS = 5;

    /** 抬升输出预算（至模型 cap 封顶）；抬不动返回 false */
    const escalateBudget = (): boolean => {
      if (truncationEscalations >= MAX_TRUNCATION_ESCALATIONS) return false;
      const cur = budgetFor(stickyModel);
      const cap = outputCapFor(stickyModel);
      const next = Math.min(Math.max(cur * 2, cur + 8192), cap);
      if (next <= cur) return false;
      truncationEscalations++;
      maxTokensOverride = next;
      return true;
    };

    if (truncated) {
      // A1) 工具调用被截断：arguments JSON 大概率残缺，直接丢弃本轮、抬预算重试
      if (toolCalls.length > 0) {
        const cur = budgetFor(stickyModel);
        if (escalateBudget()) {
          callbacks.onNotice?.(`工具调用被 max_tokens=${cur} 截断，已提高输出预算至 ${maxTokensOverride} 重试`);
          continue;
        }
        callbacks.onNotice?.(
          `工具调用被 max_tokens 截断且已达模型上限（${outputCapFor(stickyModel)}）。请 /compact 压缩上下文或改用输出上限更大的模型。`,
        );
        callbacks.onComplete();
        return;
      }
      // A2) 纯思考吃光预算、正文为空：抬预算重试
      if (!content) {
        const cur = budgetFor(stickyModel);
        if (escalateBudget()) {
          callbacks.onNotice?.(
            `输出被 max_tokens=${cur} 截断${reasonChars > 0 ? `（思考已占用约 ${reasonChars} 字）` : ''}，已提高输出预算至 ${maxTokensOverride} 重试`,
          );
          messages.push({ role: 'user', content: '你上一条回复为空，请直接输出最终回答，不要再调用工具。' });
          continue;
        }
        callbacks.onNotice?.(
          `模型思考占满了输出预算，且已达模型上限（${outputCapFor(stickyModel)}）。请调大 model.maxOutputTokens（/model）、/compact 压缩上下文，或切换到非思考模型。`,
        );
        callbacks.onComplete();
        return;
      }
      // A3) 有正文但被截断：保留已生成正文，追加“继续”续写（长任务/长回答的关键）
      if (continuations < MAX_CONTINUATIONS) {
        continuations++;
        messages.push(assistantMsg);
        messages.push({
          role: 'user',
          content: '你上一条回复因长度限制被截断。请从中断处继续输出剩余内容，不要重复已输出的部分。',
        });
        continue;
      }
      callbacks.onNotice?.(`回复过长，已连续续写 ${MAX_CONTINUATIONS} 次，先保留已生成内容。`);
      messages.push(assistantMsg);
    } else if (!content && toolCalls.length === 0) {
      // B) 非截断的空回复：模型确实空回 —— 引导它直接给最终回答（只重试一次）
      if (!emptyReplyRetried) {
        emptyReplyRetried = true;
        callbacks.onNotice?.('模型返回了空回复，正在重试一次');
        messages.push({ role: 'user', content: '你上一条回复为空，请直接输出最终回答，不要再调用工具。' });
        continue;
      }
      callbacks.onNotice?.('模型返回了空回复，本次运行未产生输出');
      callbacks.onComplete();
      return;
    } else {
      messages.push(assistantMsg);
    }

    // 循环检测：语义键签名连续出现计数（注入判定在工具执行完成后）
    let loopDetectedThisRound = false;
    let loopRepeatInfo: { sig: string; count: number } | null = null;
    for (const tc of toolCalls) {
      const sig = computeToolSig(tc.function.name, tc.function.arguments);
      const count = repeatTracker.track(sig, round);
      if (count >= LOOP_REPEAT_THRESHOLD) {
        loopDetectedThisRound = true;
        if (!loopRepeatInfo) loopRepeatInfo = { sig, count };
      }
    }

    // 连续相同纯文本（无工具调用）→ 停止（原有行为）；goal 模式先提醒再收尾
    if (toolCalls.length === 0 && content === lastContent) {
      noProgressRounds++;
      if (noProgressRounds >= 3) {
        if (goalMode) {
          callbacks.onNotice?.('goal 模式连续 3 轮无进展，已收尾（目标保持 active，/goal resume 继续）');
        }
        callbacks.onComplete();
        return;
      }
      if (goalMode) {
        messages.push({ role: 'user', content: '你上一轮回复与之前相同，请继续推进目标，或调用 goal_complete(reason) 说明已完成。' });
        continue;
      }
    } else {
      noProgressRounds = 0;
    }

    // 本轮 assistant 文字进展（与上一轮不同），供工具执行后的无进展判定使用
    const contentChanged = Boolean(content) && content !== lastContent;
    if (content) lastContent = content;

    if (toolCalls.length === 0) {
      // goal 模式：无工具调用不结束，自动注入「继续执行」消息续跑
      if (goalMode && !goalAchieved) {
        messages.push({ role: 'user', content: '继续执行当前目标；若已完成请调用 goal_complete(reason)。' });
        continue;
      }
      callbacks.onComplete(usage);
      return;
    }

    // Execute tool calls
    let editWriteSucceeded = false;
    let toolResultChanged = false;
    for (const tc of toolCalls) {
      if (signal?.aborted) {
        debugLog('Agent Loop — aborted during tool exec', { toolName: tc.function.name, msgCount: messages.length });
        cleanIncompleteToolCalls(messages);
        callbacks.onError(new Error('Stopped'));
        return;
      }
      if (globalAbort) {
        debugLog('Agent Loop — stopped during tool exec', { toolName: tc.function.name, msgCount: messages.length });
        resetStop();
        cleanIncompleteToolCalls(messages);
        callbacks.onError(new Error('Stopped'));
        return;
      }

      const toolName = tc.function.name;
      const tool = getTool(toolName);
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch { /* ignore */ }

      const detail = getToolDetail(toolName, tc.function.arguments);
      callbacks.onToolStart(tc.id, toolName, detail);

      if (!tool) {
        messages.push({
          role: 'tool',
          content: `Unknown tool: ${toolName}`,
          tool_call_id: tc.id,
          name: toolName,
        });
        callbacks.onToolError(tc.id, toolName, 'unknown tool');
        continue;
      }

      // Plan mode block：write/edit 一律拦截；shell 按只读命令白名单判定
      // （白名单命中放行执行，仍走后续权限门与高危拦截；敏感命令无条件 deny）
      if (isPlanBlocked(toolName)) {
        let blockReason = `Tool "${toolName}" blocked — read-only in plan mode.`;
        let whitelistAllowed = false;
        if (toolName === 'shell') {
          const reason = isPlanShellBlocked(String(args.command || ''), config);
          if (reason) blockReason = reason;
          else whitelistAllowed = true;
        }
        if (!whitelistAllowed) {
          messages.push({
            role: 'tool',
            content: `[PLAN MODE] ${blockReason}`,
            tool_call_id: tc.id,
            name: toolName,
          });
          callbacks.onToolError(tc.id, toolName, 'blocked (plan mode)');
          recordAudit(toolName, args, 'plan-mode', 'blocked', config);
          continue;
        }
      }

      // 高危命令预检（§11：独立于权限模式与 bypass；默认 deny 硬拦截，
      // actionSafety.highRiskActions=confirm 时输入确认短语放行一次）
      if (toolName === 'shell') {
        const highRiskHit = isHighRiskCommand(String(args.command || ''));
        if (highRiskHit) {
          const safety = config.actionSafety ?? { highRiskActions: 'deny' as const, confirmPhrase: 'yes', protectedPaths: [], auditEnabled: true };
          if (safety.highRiskActions === 'confirm') {
            const confirmInfo = buildHighRiskConfirmInfo(String(args.command || ''), highRiskHit, safety.confirmPhrase, confirmLanguage);
            const result = await callbacks.onConfirm(confirmInfo);
            if (result === 'abort') {
              cleanIncompleteToolCalls(messages);
              callbacks.onError(new Error('已终止'));
              return;
            }
            const phrase = result.startsWith('phrase:') ? result.slice('phrase:'.length).trim() : '';
            if (phrase !== safety.confirmPhrase) {
              messages.push({
                role: 'tool',
                content: `High-risk command denied: confirmation phrase mismatch.`,
                tool_call_id: tc.id,
                name: toolName,
              });
              callbacks.onToolError(tc.id, toolName, 'denied (high-risk phrase mismatch)');
              recordAudit(toolName, args, 'high-risk', 'denied', config);
              continue;
            }
            // 短语正确：放行一次，继续走后续权限门
            recordAudit(toolName, args, 'high-risk', 'allowed', config);
          } else {
            messages.push({
              role: 'tool',
              content: `HIGH RISK COMMAND BLOCKED: "${String(args.command || '').slice(0, 100)}" matched security pattern "${highRiskHit.source.slice(0, 40)}". This action is blocked regardless of permission mode.`,
              tool_call_id: tc.id,
              name: toolName,
            });
            callbacks.onToolError(tc.id, toolName, 'blocked (high-risk)');
            recordAudit(toolName, args, 'high-risk', 'blocked', config);
            continue;
          }
        }
      }

      // Permission check
      if (needsManualConfirm(toolName, args, config)) {
        const confirmInfo = buildConfirmInfo(toolName, args, confirmLanguage);
        const result = await callbacks.onConfirm(confirmInfo);

        // 用户终止任务：清理未完成的 tool_calls，停止整个 agent 循环
        if (result === 'abort') {
          cleanIncompleteToolCalls(messages);
          callbacks.onError(new Error('已终止'));
          return;
        }

        if (result === 'allow_session' && confirmInfo.kind === 'external') sessionAllow.add(toolName);
        if (result === 'deny_session') sessionDeny.add(toolName);
        if (result === 'allow_paths') {
          for (const p of confirmInfo.paths) sessionAllowedPaths.add(p);
        }
        if (result === 'allow_prefix') {
          if (confirmInfo.commandGrant) sessionAllowedCommands.push(confirmInfo.commandGrant);
        }

        // 拒绝 + 用户说明（Codex CLI: “tell me what to do differently”），
        // 把用户的指导反馈给模型，让它调整行为后继续。
        if (result.startsWith('deny_feedback:')) {
          const feedback = result.slice('deny_feedback:'.length).trim();
          messages.push({
            role: 'tool',
            content: feedback
              ? `Permission denied. User feedback: ${feedback}`
              : 'Permission denied',
            tool_call_id: tc.id,
            name: toolName,
          });
          callbacks.onToolError(tc.id, toolName, 'denied (user feedback)');
          recordAudit(toolName, args, 'confirm', 'denied', config);
          continue;
        }

        if (result.startsWith('deny') || result === 'deny_session') {
          messages.push({
            role: 'tool',
            content: `Permission denied: ${result}`,
            tool_call_id: tc.id,
            name: toolName,
          });
          callbacks.onToolError(tc.id, toolName, `denied (${result})`);
          recordAudit(toolName, args, 'confirm', 'denied', config);
          continue;
        }
        // 确认放行（allow / allow_session / allow_paths / allow_prefix）
        recordAudit(toolName, args, 'confirm', 'allowed', config);
      } else if (needsConfirmation(toolName, effectivePermissions(config))) {
        if (sessionDeny.has(toolName)) {
          messages.push({
            role: 'tool',
            content: 'Permission denied (session)',
            tool_call_id: tc.id,
            name: toolName,
          });
          callbacks.onToolError(tc.id, toolName, 'denied (session)');
          recordAudit(toolName, args, 'session-deny', 'denied', config);
          continue;
        }
      }

      // Pitfall check before destructive actions
      const pitfallBlock = checkPitfalls(toolName, args);
      if (pitfallBlock) {
        messages.push({
          role: 'tool', content: pitfallBlock, tool_call_id: tc.id, name: toolName,
        });
        callbacks.onToolError(tc.id, toolName, 'blocked (pitfall hard constraint)');
        recordAudit(toolName, args, 'pitfall', 'blocked', config);
        continue;
      }

      // C3 paths: 条件规则（pre-tool 判定）：本轮触及文件命中 paths 声明时，
      // 规则正文在执行后注入工具结果（模型拿到结果时同时看到规则）
      const matchedPathRules = pathsRules.filter((r) =>
        !injectedPathRules.has(r.path) &&
        matchPathsRule(r.paths!, touchedPathsOfToolCall(toolName, args, process.cwd())),
      );

      // Execute tool
      // 执行前记录文件是否存在（write/edit 变更卡片的 add/update 判定）
      let existedBefore = false;
      if (
        (toolName === 'write' || toolName === 'edit') &&
        typeof args.file_path === 'string' &&
        args.file_path
      ) {
        try {
          existedBefore = existsSync(resolve(process.cwd(), expandHome(args.file_path)));
        } catch { /* 安全保险：判定失败按“不存在”处理，不影响工具执行 */ }
      }

      try {
        const sig = computeToolSig(toolName, tc.function.arguments);
        const result = await executeToolWithTimeout(tool, args, { signal });
        // 坑命中反馈：失败错误匹配已知 trigger → hits+1（§14 反馈闭环）
        recordPitfallHitOnError(result, config, callbacks);

        // 真实进展信号：edit/write 成功；结果相对上一次同签名调用有变化
        if ((toolName === 'write' || toolName === 'edit') && !result.isError) {
          editWriteSucceeded = true;
        }
        if (outcomeTracker.changed(sig, !result.isError, result.content)) {
          toolResultChanged = true;
        }

        let content = result.content;
        // paths: 条件规则命中 → 注入（在截断之前：规则文字必须留在头部可见区）
        if (matchedPathRules.length > 0) {
          for (const r of matchedPathRules) injectedPathRules.add(r.path);
          const ruleText = matchedPathRules
            .map((r) => `[路径规则 ${r.label} (${r.level})]\n${r.content}`)
            .join('\n\n');
          content = `${ruleText}\n\n${content}`;
        }
        if (content.length > toolOutputLimitChars) {
          const refDetail = getToolDetail(toolName, tc.function.arguments);
          const { refId, summary } = storeRef(
            content,
            `Tool ${[toolName, refDetail].filter(Boolean).join(' ')} output (${content.length} chars)`,
          );
          content = `[Ref:${refId}] ${summary}`;
        }

        // 视觉模型 + 工具携带图片 → 追加 image_url 内容块（toolResultToMessages 展开）
        messages.push(...toolResultToMessages({
          toolName,
          toolCallId: tc.id,
          content,
          images: result.images,
          modelVision: isVisionModel(stickyModel),
        }));

        if (result.isError) {
          callbacks.onToolError(tc.id, toolName, content);
        } else {
          const doneDetail = getToolDetail(toolName, tc.function.arguments);
          // 文件变更卡片（纯 UI 数据）：构建抛错时静默降级为无卡片，
          // 等价于旧行为，工具循环与消息序列不受任何影响。
          let fileChange: FileChange | undefined;
          if (toolName === 'write' || toolName === 'edit') {
            try {
              fileChange = buildFileChange(toolName, args, existedBefore) ?? undefined;
            } catch { /* 安全保险：卡片构建失败 → 无卡片 */ }
          }
          callbacks.onToolDone(tc.id, toolName, doneDetail, content, fileChange);
        }
      } catch (err) {
        const sig = computeToolSig(toolName, tc.function.arguments);
        const errorMsg = `${(err as Error).message}`;
        if (outcomeTracker.changed(sig, false, errorMsg)) {
          toolResultChanged = true;
        }
        messages.push({ role: 'tool', content: errorMsg, tool_call_id: tc.id, name: toolName });
        callbacks.onToolError(tc.id, toolName, errorMsg);
      }
    }

    // goal 模式：模型调用 goal_complete 即达成（下一轮无工具调用时收尾给出最终总结）
    if (goalMode && toolCalls.some((tc) => tc.function.name === 'goal_complete')) {
      goalAchieved = true;
      callbacks.onNotice?.('目标已完成，模型正在输出最终总结');
    }

    // 纠正注入后：连续 6 轮仍无进展 → 优雅收尾并说明原因。
    // 检查放在工具执行完成后，每轮任一真实进展信号（文字变化 / edit·write 成功 /
    // 同签名工具结果变化）都会重置计数；新签名本身不算进展。
    if (loopCorrectionInjected) {
      roundsAfterCorrection++;
      if (contentChanged || editWriteSucceeded || toolResultChanged) {
        roundsAfterCorrection = 0;
      }
      if (roundsAfterCorrection >= LOOP_NO_PROGRESS_LIMIT) {
        callbacks.onNotice?.('检测到重复工具调用且纠正后连续 6 轮无进展，已停止；建议换一种方式或 /clear');
        callbacks.onComplete();
        return;
      }
    }

    // 循环检测：任一签名连续出现 ≥5 次 → 注入纠正消息，再给一轮机会
    if (!loopCorrectionInjected && loopDetectedThisRound) {
      if (loopRepeatInfo) {
        messages.push({ role: 'user', content: LOOP_CORRECTION_MESSAGE });
        loopCorrectionInjected = true;
        roundsAfterCorrection = 0;
        debugLog('Agent Loop — loop correction injected', {
          sig: loopRepeatInfo.sig,
          count: loopRepeatInfo.count,
          round,
        });
      }
    }

    // C2 刷新回路：本轮 memory_save（或外部编辑）翻新了记忆目录 → 重建
    // system 记忆段，让下一轮 LLM 调用立即看见新记忆（否则要到 /clear 才生效）
    refreshSystemMemoryIfChanged(messages, config);
  }

  // 步数上限：不是错误，优雅收尾，上下文不丢，继续输入即续跑
  callbacks.onNotice?.(goalMode ? '已达 goal 步数上限（goal 保持 active，/goal resume 继续）' : '已达步数上限，输入继续可接着跑');
  callbacks.onComplete();
}
