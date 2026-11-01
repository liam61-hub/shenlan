/**
 * AppContext — 全局状态类型 + Context
 */
import { createContext } from 'react';
import type { ShenlanConfig, Message, TokenUsage, TodoItem, PlanItem, McpServerStatus, SkillEntry } from '@shenlan/core';
import type { RunMode } from './mode.js';
import type { BlockKind, PendingBlock } from './stream-blocks.js';
import type { FileChange } from './file-change.js';
import type { KeyProviderEntry } from './keys.js';
import type { HookStatus } from './security.js';
import type { ConfigRow } from './commands/config.js';

// ===== History item (frozen into <Static>, 写入终端原生回滚区) =====
export type HistoryRole = 'user' | 'assistant' | 'assistant-line' | 'assistant-block' | 'tool' | 'tool-step' | 'system';

export interface ToolStepHistory {
  id: string;
  name: string;
  detail: string;
  outcome: 'done' | 'error';
  durationMs: number;
}

export interface HistoryItem {
  key: string;
  role: HistoryRole;
  content: string;
  /** 消息创建时间戳（毫秒），用于轮次分隔线 */
  ts?: number;
  /** 工具结果行：是否为错误（红色渲染，行首 ✖） */
  toolError?: boolean;
  /** 文件变更卡片（write/edit 成功路径；纯 UI 产物，不写入会话 JSONL） */
  fileChange?: FileChange;
  /** 已完成工具步骤（仅 role='tool-step'，写入终端回滚区，不进入会话 JSONL） */
  toolStep?: ToolStepHistory;
  toolStatuses?: ToolStatusSnapshot[];
  /** 流式行：是否处于代码围栏内（仅 role='assistant-line'） */
  code?: boolean;
  /** 流式块：块类型（仅 role='assistant-block'） */
  blockKind?: BlockKind;
  /** 流式代码块：围栏语言（仅 role='assistant-block' 且 blockKind='code'） */
  lang?: string;
}

export interface ToolStatusSnapshot {
  name: string;
  detail: string;
  state: 'done' | 'error';
}

// ===== Tool status (dynamic region, 有界帧内) =====
export interface ToolStatus {
  id: string;
  name: string;
  detail: string;
  state: 'running' | 'done' | 'error';
  startTime: number;
  endTime?: number;
}

// ===== 后台任务（background_agent，动态区行，与工具状态共用 ≤4 行预算） =====
export interface BgTaskStatus {
  id: string;
  goal: string;
  startTime: number;
}

// ===== Confirm prompt =====
/** 确认弹窗类型：文件编辑 / 命令执行 / 计划实施 */
export type ConfirmKind = 'edit' | 'create' | 'external' | 'destructive' | 'command' | 'plan' | 'delete' | 'high-risk';

export interface ConfirmPrompt {
  kind: ConfirmKind;
  language?: 'en' | 'zh-CN';
  /** 弹窗标题（Codex CLI 样式，如 “Would you like to make the following edits?”） */
  title: string;
  /** 操作详情行（edit=文件路径列表，command=命令原文，plan=计划描述） */
  detail: string[];
  /** 选项 2 的补充说明（如命令前缀） */
  allowNote?: string;
  toolName: string;
  description: string;
  options: ConfirmOption[];
  selected: number;          // 当前选中项下标
  /** “No, and tell me what to do differently” 选中后的反馈输入模式 */
  feedbackMode: boolean;
  /** 反馈输入框当前文本 */
  feedbackText: string;
  /** 反馈输入模式的自定义提示；缺省用默认文案 */
  feedbackLabel?: string;
  /** 弹窗底部快捷键说明；缺省按 kind 默认 */
  footerHint?: string;
}

// ===== 管理面板（/mcp、/skills，动态区模态面板，输入框隐藏） =====
/** /mcp 详情视图菜单操作类型 */
export type McpMenuOp = 'tools' | 'connect' | 'disable' | 'enable';

/** 详情视图菜单（按 server 状态生成，对齐 Claude Code /mcp 样式） */
export function mcpMenuFor(server: McpServerStatus): Array<{ label: string; op: McpMenuOp }> {
  const menu: Array<{ label: string; op: McpMenuOp }> = [{ label: 'View tools', op: 'tools' }];
  if (!server.enabled) {
    menu.push({ label: 'Enable', op: 'enable' });
  } else {
    menu.push({ label: server.connected ? 'Reconnect' : 'Connect', op: 'connect' });
    menu.push({ label: 'Disable', op: 'disable' });
  }
  return menu;
}

export interface McpPanelState {
  /** 状态快照（每次操作后刷新） */
  servers: McpServerStatus[];
  /** 当前选中 server 下标 */
  selected: number;
  /** 异步操作进行中 */
  busy: boolean;
  /** 最近一次操作结果提示 */
  notice?: string;
  /** 详情视图：当前查看的 server（null = 列表视图） */
  detail: McpServerStatus | null;
  /** 详情菜单选中项下标 */
  detailMenu: number;
  /** 工具列表视图（View tools 后） */
  toolsView: boolean;
}

export interface SkillsPanelState {
  skills: SkillEntry[];
  selected: number;
}

/** /config 交互面板状态（←/→ 切换布尔/枚举，Enter 行内编辑，对齐 Claude Code CLI 配置交互） */
export interface ConfigPanelState {
  rows: ConfigRow[];
  selected: number;
  /** 行内编辑模式（Enter 进入，预填当前值；Enter 保存 / Esc 取消） */
  editing: boolean;
  editText: string;
  /** 写入作用域（g/p 切换；默认 project，与 /config set 一致） */
  scope: 'project' | 'global';
  /** 最近一次操作结果提示（保存成功/校验错误/未设置） */
  notice?: string;
}

/** 模型选择面板条目（/model 交互选择，对齐 Codex CLI 样式） */
export interface ModelOption {
  /** auto = 置顶的 Default（自动路由）项；model = 具体模型 */
  kind: 'auto' | 'model';
  /** 面板分组标题（如 自动路由 / DeepSeek（官方 API）/ 百炼 DashScope / Qwen） */
  group: string;
  /** 模型 ID（kind='model'）或 'Default'（kind='auto'） */
  model: string;
  /** provider 名（'auto' / 'deepseek' / 'qwen' ...） */
  provider: string;
  /** 上下文窗口（展示用；auto 项为 0） */
  contextWindow: number;
  /** 有可用 key（auto 项恒 true） */
  available: boolean;
  /** 当前生效：手动锁定态下为锁定模型行，自动路由态下为 Default 行 */
  current: boolean;
  /** 简短定位标签（自动路由 / 快速 / 均衡 / 推理 / 最强） */
  tag: string;
  /** '¥x/¥y per Mtok' 或 ''（无价格数据时省略） */
  priceText: string;
}

export interface ModelPanelState {
  models: ModelOption[];
  selected: number;
}

/** /keys 密钥面板状态 */
export interface KeysPanelState {
  providers: KeyProviderEntry[];
  /** 当前选中 provider 下标 */
  selected: number;
  /** 输入模式（Enter 进入，粘贴支持，Enter 保存，Esc 取消） */
  inputMode: boolean;
  /** 输入框当前文本 */
  inputText: string;
  /** 保存作用域：默认全局 */
  scope: 'global' | 'project';
  /** 异步操作（保存/连通性测试）进行中 */
  busy: boolean;
  /** 最近一次操作提示（黄色） */
  notice?: string;
  /** 自定义 provider 三步录入步骤（0=baseUrl 1=API Key 2=模型名/序号；null=非自定义录入） */
  customStep: 0 | 1 | 2 | null;
  /** 三步录入第一步暂存的 baseUrl（允许空 = 自动推导） */
  customBaseUrl: string;
  /** 三步录入第二步暂存的 API Key */
  customApiKey: string;
  /** 三步录入第 2 步后探测厂商 /v1/models 得到的模型清单（第 3 步可按序号选择） */
  customModels: string[];
}

/** /security 面板状态 */
export interface SecurityPanelState {
  hook: HookStatus;
  /** 已跟踪的敏感文件列表 */
  trackedSensitive: string[];
  /** 面板操作菜单选中下标（0=安装/重装 1=卸载 2=重扫 …） */
  selected: number;
  busy: boolean;
  notice?: string;
}

/** /security 面板菜单项数：钩子状态决定可用操作（reducer 钳制用，与组件菜单一致） */
export function securityMenuLength(panel: SecurityPanelState): number {
  if (!panel.hook.gitRepo) return 1; // 非仓库：仅重扫
  if (panel.hook.hookExists && !panel.hook.ours) return 2; // 已有他人钩子：查看 + 重扫
  return 3; // 安装/重装 + 卸载 + 重扫
}

/** /goal 长任务模式状态 */
export interface GoalState {
  text: string;
  status: 'active' | 'paused' | 'completed';
}

/** 首次引导流程状态（对齐 Codex/Claude Code 首次运行：欢迎 → 配 key → 快速上手） */
export interface OnboardingState {
  step: 'welcome' | 'keys' | 'tips';
  /** 密钥配置步骤的 provider 列表（ONBOARDING_START 时装入 keysPanel） */
  providers: KeyProviderEntry[];
  /** 配置完成后展示的成功信息（tips 页顶部） */
  saved?: { provider: string; masked: string };
}

/** 斜杠命令联想（输入 `/` 开头且未输入参数时显示） */
export interface SlashSuggestions {
  matches: string[];
  /** 当前高亮下标（Tab 循环） */
  selected: number;
}

export interface ConfirmOption {
  label: string;
  key: string;
  value: string;
}

// ===== Diff hunk =====
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// ===== App state =====
export type AppPhase = 'idle' | 'thinking' | 'streaming' | 'tools' | 'confirming' | 'diff';

export interface AppState {
  // conversation
  history: HistoryItem[];
  messages: Message[];

  // streaming
  phase: AppPhase;
  /** 当前流式消息未完成的一行（动态区单行实时刷新） */
  streamingTail: string;
  /** 当前流式消息是否处于代码围栏内（逐行冻结时决定 dim 渲染） */
  streamFenceOpen: boolean;
  /** 当前流式消息未完成的表格/公式块缓冲（逐行冻结时整块冻结） */
  pendingBlock: PendingBlock | null;

  // tools
  toolStatuses: ToolStatus[];
  /** 运行中后台任务（background_agent 派发；完成即移除 + notice 瞬态通知） */
  bgTasks: BgTaskStatus[];
  toolOutputs: Map<string, string>;

  // session 级工具状态（todo_write / update_plan，动态区最小 UI）
  todos: TodoItem[];
  plan: PlanItem[];

  // confirm
  confirmPrompt: ConfirmPrompt | null;

  // panels
  mcpPanel: McpPanelState | null;
  skillsPanel: SkillsPanelState | null;
  modelPanel: ModelPanelState | null;
  keysPanel: KeysPanelState | null;
  securityPanel: SecurityPanelState | null;
  /** /config 交互配置面板（模态） */
  configPanel: ConfigPanelState | null;
  /** 首次引导流程（模态，welcome → keys → tips；Esc 可跳过） */
  onboarding: OnboardingState | null;

  // goal 长任务
  goal: GoalState | null;

  // slash 联想
  slashSuggestions: SlashSuggestions | null;

  // input
  inputHistory: string[];
  inputValue: string;

  // misc
  error: string | null;
  /** 输入框上方的瞬时提示（如 /clear 的“Context cleared”），下次提交清除 */
  notice: string | null;
  /** 实际生效模型（sticky 路由优先，/model 切换或每轮路由后同步；底部状态行/顶部头部显示用） */
  model: string;
  sessionId: string;
  submitSeq: number;      // incremented on each SUBMIT_INPUT, used as effect dependency
  /** /clear 手动清屏后 +1：驱动 <Static> 重挂载，从 index 0 重绘（旧 index 不回退导致新消息被跳过） */
  staticEpoch: number;
}

// ===== Actions =====
export type AppAction =
  | { type: 'SUBMIT_INPUT'; input: string }
  | { type: 'ADD_SYSTEM_MSG'; content: string }
  | { type: 'CYCLE_MODE' }
  | { type: 'SET_MODE'; mode: RunMode }
  | { type: 'EXIT_APP' }
  | { type: 'THINKING_START' }
  | { type: 'TOKEN'; token: string }
  | { type: 'THINKING_END' }
  | { type: 'BG_TASK_START'; id: string; goal: string }
  | { type: 'BG_TASK_DONE'; id: string; goal: string; success: boolean; summary: string }
  | { type: 'TOOL_START'; id: string; name: string; detail: string }
  | { type: 'TOOL_DONE'; id: string; name: string; detail: string }
  | { type: 'TOOL_RESULT'; id: string; name: string; detail: string; content: string; isError: boolean; fileChange?: FileChange }
  | { type: 'TOOL_ERROR'; id: string; name: string; error: string }
  | { type: 'TODOS'; todos: TodoItem[] }
  | { type: 'PLAN'; plan: PlanItem[] }
  | { type: 'CONFIRM_PROMPT'; prompt: ConfirmPrompt }
  | { type: 'CONFIRM_RESULT'; result: string }
  | { type: 'CONFIRM_NAVIGATE'; direction: -1 | 1 }
  | { type: 'CONFIRM_FEEDBACK_MODE' }
  | { type: 'CONFIRM_FEEDBACK_INPUT'; text: string }
  | { type: 'MCP_PANEL_OPEN'; servers: McpServerStatus[] }
  | { type: 'MCP_PANEL_UPDATE'; servers: McpServerStatus[]; busy?: boolean; notice?: string }
  | { type: 'MCP_PANEL_SELECT'; index: number }
  | { type: 'MCP_PANEL_OPEN_DETAIL'; server: McpServerStatus }
  | { type: 'MCP_PANEL_MENU_SELECT'; index: number }
  | { type: 'MCP_PANEL_VIEW_TOOLS' }
  | { type: 'MCP_PANEL_BACK' }
  | { type: 'MCP_PANEL_CLOSE' }
  | { type: 'SKILLS_PANEL_OPEN'; skills: SkillEntry[] }
  | { type: 'SKILLS_PANEL_SELECT'; index: number }
  | { type: 'SKILLS_PANEL_CLOSE' }
  | { type: 'MODEL_PANEL_OPEN'; models: ModelOption[] }
  | { type: 'MODEL_PANEL_SELECT'; index: number }
  | { type: 'MODEL_PANEL_CLOSE' }
  | { type: 'KEYS_PANEL_OPEN'; providers: KeyProviderEntry[] }
  | { type: 'KEYS_PANEL_SELECT'; index: number }
  | { type: 'KEYS_PANEL_INPUT_MODE'; inputMode: boolean; inputText?: string }
  | { type: 'KEYS_PANEL_INPUT'; text: string }
  | { type: 'KEYS_PANEL_SAVED'; provider: string; masked: string; notice: string }
  | { type: 'KEYS_PANEL_DELETED'; provider: string; notice: string }
  | { type: 'KEYS_PANEL_SCOPE'; scope: 'global' | 'project' }
  | { type: 'KEYS_PANEL_BUSY'; busy: boolean; notice?: string }
  | { type: 'KEYS_PANEL_CUSTOM_STEP'; step: number | null; baseUrl?: string; apiKey?: string }
  | { type: 'KEYS_PANEL_CUSTOM_PROBE'; pending?: boolean; models?: string[] }
  | { type: 'KEYS_PANEL_REFRESH'; providers: KeyProviderEntry[] }
  | { type: 'KEYS_PANEL_CLOSE' }
  | { type: 'CONFIG_PANEL_OPEN'; rows: ConfigRow[] }
  | { type: 'CONFIG_PANEL_SELECT'; index: number }
  | { type: 'CONFIG_PANEL_EDIT_START'; text: string }
  | { type: 'CONFIG_PANEL_EDIT_INPUT'; text: string }
  | { type: 'CONFIG_PANEL_EDIT_CANCEL' }
  | { type: 'CONFIG_PANEL_NOTICE'; text: string | undefined }
  | { type: 'CONFIG_PANEL_SCOPE'; scope: 'project' | 'global' }
  | { type: 'CONFIG_PANEL_REFRESH'; rows: ConfigRow[] }
  | { type: 'CONFIG_PANEL_CLOSE' }
  | { type: 'SECURITY_PANEL_OPEN'; hook: HookStatus; trackedSensitive: string[] }
  | { type: 'SECURITY_PANEL_SELECT'; index: number }
  | { type: 'SECURITY_PANEL_UPDATE'; hook?: HookStatus; busy?: boolean; notice?: string }
  | { type: 'SECURITY_PANEL_CLOSE' }
  | { type: 'GOAL_SET'; text: string }
  | { type: 'GOAL_PAUSE' }
  | { type: 'GOAL_RESUME' }
  | { type: 'GOAL_CLEAR' }
  | { type: 'GOAL_COMPLETE' }
  | { type: 'ONBOARDING_OPEN'; providers: KeyProviderEntry[] }
  | { type: 'ONBOARDING_START' }
  | { type: 'ONBOARDING_BACK' }
  | { type: 'ONBOARDING_SKIP' }
  | { type: 'ONBOARDING_CLOSE' }
  | { type: 'SET_SLASH'; slashSuggestions: SlashSuggestions | null }
  | { type: 'SLASH_SELECT'; index: number }
  | { type: 'CLEAR_CONTEXT' }
  | { type: 'CLEAR_SESSION' }
  | { type: 'STATIC_RESET' }
  | { type: 'COMPLETE'; usage?: TokenUsage }
  | { type: 'ERROR'; error: string }
  | { type: 'SET_INPUT'; value: string }
  | { type: 'SET_NOTICE'; text: string | null }
  | { type: 'SET_MODEL'; model: string }
  | { type: 'DIFF_SHOW'; filePath: string; hunks: DiffHunk[] }
  | { type: 'CLEAR_ERROR' };

// ===== Context =====
export interface AppContextType {
  config: ShenlanConfig;
  mode: RunMode;
  model: string;
  termWidth: number;
  termHeight: number;
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

export const AppContext = createContext<AppContextType>(null!);
