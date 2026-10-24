/**
 * 配置加载 — 从多层配置文件深合并
 *
 * 优先级（高到低）：
 *   1. 环境变量 SHENLAN_*
 *   2. <cwd>/.shenlan/config.json
 *   3. ~/.shenlan/config.json
 *   4. 内置默认值
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { debugLog } from './debug-logger.js';
import type { Lang } from './config-schema.js';
import {
  CONFIG_SAMPLE_GLOBAL,
  CONFIG_SAMPLE_PROJECT,
  CONFIG_README_MD,
  ENV_EXAMPLE,
} from './config-samples.js';

/** LLM Provider 配置 */
export interface ModelConfig {
  /** OpenAI 兼容 API base URL */
  baseUrl: string;
  /** API Key */
  apiKey: string;
  /** 模型名 */
  model: string;
  /** 最大输出 token（单次回复的“期望值/下限”） */
  maxTokens: number;
  /**
   * 单次响应硬输出上限（token）。思考模型的推理与正文共享输出预算，
   * 上限过小会导致“思考吃光预算、正文为空”。显式配置优先级高于模型目录值。
   * 可选：缺省时按模型目录 maxOutputTokens / 回退 maxTokens。
   */
  maxOutputTokens?: number;
}

/** 权限模式 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/** 权限配置 */
export interface PermissionConfig {
  mode: PermissionMode;
  /** 允许列表（工具名） */
  allow: string[];
  /** 拒绝列表（工具名） */
  deny: string[];
}

/** Agent 循环护栏配置 */
export interface AgentConfig {
  /** 单次任务最大步数（命中后优雅收尾，可继续输入续跑） */
  maxSteps: number;
  /** /goal 长任务模式最大步数（默认 300；无工具调用轮自动续跑） */
  goalMaxSteps?: number;
  /** 后台 Explore agent（background_agent）并发上限（默认 3；超限报错不排队） */
  maxBackground?: number;
}

/** 成本护栏配置 */
export interface CostGuardrailsConfig {
  /** 是否启用成本护栏 */
  enabled: boolean;
  /** 单会话成本上限（CNY） */
  maxCostPerSession: number;
  /** 单日成本上限（CNY） */
  maxCostPerDay: number;
  /** 货币单位 */
  currency: string;
  /** 启动时预检 DeepSeek 余额（/user/balance，默认开；无 key 静默跳过） */
  balanceCheckBeforeStart?: boolean;
  /** 余额低于该值（CNY）时启动告警 */
  lowBalanceWarnThreshold?: number;
}

/** Auto Memory 配置（模型自主保存跨会话记忆，对齐 Claude Code） */
export interface MemoryConfig {
  /** 是否允许模型调用 memory_save 工具自主保存记忆（/memory on|off 写项目配置） */
  autoSave: boolean;
}

/** Tavily 配置（独立 tavily_search 工具开关；web_search 的 Tavily 兜底不受此开关影响） */
export interface TavilyConfig {
  /** 注册 tavily_search 独立工具（默认关闭）；key 走统一解析：TAVILY_API_KEY 环境变量 > providerKeys.tavily */
  enabled: boolean;
}

/** 动作安全网配置（§11：高危拦截、保护路径、动作级审计） */
export interface ActionSafetyConfig {
  /** 高危动作处置：deny（默认，硬拦截）/ confirm（双确认，输入 confirmPhrase 放行一次） */
  highRiskActions: 'deny' | 'confirm';
  /** 高危双确认的确认短语（默认 yes） */
  confirmPhrase: string;
  /** 保护路径清单：write/edit 命中即拦截（realpath 规范化后匹配；空清单 = 不拦截） */
  protectedPaths: string[];
  /** 动作级审计事件记录（默认开；高危动作相关记录不可关闭） */
  auditEnabled: boolean;
}

/** Plan Mode 配置（§10：只读边界） */
export interface PlanModeConfig {
  /** plan 态 shell 只读命令白名单（命令前缀匹配；未命中一律拒绝；env/printenv/密钥路径无条件 deny） */
  readonlyCommands: string[];
}

/** 坑记忆配置（§14 坑防复发） */
export interface PitfallMemoryConfig {
  /** 注入 top-N 排序条目数（预留；当前注入由模型经 pitfall_search 主动检索） */
  injectTopN: number;
  /** 关键动作前检索提示（预留） */
  searchBeforeAction: boolean;
  /** 工具失败且错误匹配已知 trigger 时自动命中递增（不自动创建新条目） */
  autoRecordOnError: boolean;
}

/** provider 自动故障转移配置（§25：默认关闭，P1 可配置） */
export interface ProviderFailoverConfig {
  /** 主 provider 失败（5xx/402/网络超时）时自动切换备用 provider 重试一次 */
  enabled: boolean;
}

/** 首次引导状态（写全局配置，仅本地） */
export interface OnboardingConfig {
  /** 引导流程已完成（跳过或配置完成），不再自动弹出欢迎 */
  done?: boolean;
  /** 快速上手提示已展示 */
  tipsSeen?: boolean;
}

/** 上下文管理配置 */
export interface ContextConfig {
  /** 自动压缩触发阈值（token）；实际上限取 min(配置, 90% × 模型窗口) */
  autoCompactTokenLimit: number;
  /** 压缩时保留最近 N 轮完整消息（每轮 = 一次 LLM 响应，覆盖工具调用密集长任务） */
  keepRecentTurns: number;
  /** 工具输出超过该字符数进 ref 只留摘要 */
  toolOutputLimitChars: number;
  /** 压缩摘要使用的模型 */
  compactModel: string;
  /**
   * 记忆段注入 system prompt 的 token 预算（超出按优先级折叠：项目记忆优先保留）。
   * 可选：所有读取方都用 `?? DEFAULT_MEMORY_TOKEN_BUDGET` 兜底，DEFAULT_CONFIG 里有值，
   * 这里声明可选是为了不迫使既有的 ContextConfig 字面量（含测试 fixture）全部补字段。
   */
  maxMemoryTokens?: number;
  /**
   * 思考模型单次请求的输出预算下限（token）。思考模型的推理会占用输出额度，
   * 若沿用较小的 model.maxTokens（如 8192），推理可能吃光额度导致正文为空。
   * 默认 16384：足够“思考 + 正文”共存；实际值会被模型目录 maxOutputTokens 夹紧。
   */
  thinkingOutputFloor?: number;
}

/** 多 Provider Key 映射 */
export interface ProviderKeys {
  deepseek?: string;
  qwen?: string;
  [provider: string]: string | undefined;
}

/** 多 Provider 请求端点覆盖（可选配置；不配置时用内置默认表） */
export interface ProviderBaseUrls {
  deepseek?: string;
  qwen?: string;
  [provider: string]: string | undefined;
}

/** CLI 启动更新检查配置。 */
export interface UpdateCheckConfig {
  /** 是否在交互式启动时异步检查新版本（默认开启）。 */
  enabled: boolean;
}

/** 运行时从厂商接口发现的模型清单（按显式 provider 归属）。 */
export interface ProviderModels {
  [provider: string]: string[] | undefined;
}

/** 内置厂商定义：core/CLI 共用的唯一事实源，不预置具体模型。 */
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  modelsUrl: string;
}

/** 路由策略：cost-first（默认）/ quality-first / manual（手动锁定） */
export type RoutingPolicy = 'cost-first' | 'quality-first' | 'manual';

/** 模型路由持久化配置（/model 命令写入全局配置，启动时恢复） */
export interface RoutingConfig {
  policy: RoutingPolicy;
  /** manual 策略下锁定的模型名（auto / cost-first / quality-first 时为 null） */
  lockedModel?: string | null;
}

/** 完整配置类型 */
export interface ShenlanConfig {
  /** 配置 schema 版本 */
  schemaVersion?: number;
  /** 界面语言（en 默认 / zh-CN；/config 面板与配置注释随语言切换） */
  language?: Lang;
  model: ModelConfig;
  permissions: PermissionConfig;
  /** 多 Provider API Key（按 provider 名索引，入环境变量不入配置文件） */
  providerKeys?: ProviderKeys;
  /** 多 Provider 请求端点覆盖（按 provider 名索引；不配置时用内置默认表） */
  providerBaseUrls?: ProviderBaseUrls;
  /** 厂商接口动态发现或用户确认的模型名；目录外模型仅支持手动选择。 */
  providerModels?: ProviderModels;
  /** 模型路由（/model 持久化：policy + 手动锁定模型） */
  routing?: RoutingConfig;
  /** Skill 目录列表 */
  skills: string[];
  /** MCP Server 配置 */
  mcpServers: Array<{
    name: string;
    transport: 'stdio' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
  /** Tavily 独立工具开关（可选；缺省视为关闭） */
  tavily?: TavilyConfig;
  /** 动作安全网（可选；缺省按 DEFAULT_CONFIG 的 deny 语义） */
  actionSafety?: ActionSafetyConfig;
  /** Plan Mode（可选；缺省按 DEFAULT_CONFIG 内置只读白名单） */
  planMode?: PlanModeConfig;
  /** 坑记忆（可选；缺省按 DEFAULT_CONFIG） */
  pitfallMemory?: PitfallMemoryConfig;
  /** provider 自动故障转移（可选；缺省关闭） */
  providerFailover?: ProviderFailoverConfig;
  /** Agent 循环护栏 */
  agent?: AgentConfig;
  /** 上下文管理（压缩阈值、保留轮数、工具输出上限） */
  context?: ContextConfig;
  /** 成本护栏（单会话/单日上限：每次 LLM 调用前检查，超限停止当前任务；单日按本地日期持久化在 ~/.shenlan/cost-ledger.json） */
  costGuardrails?: CostGuardrailsConfig;
  /** Auto Memory（默认开启；false 时模型侧不可见 memory_save 工具） */
  memory?: MemoryConfig;
  /** 交互式启动版本检查（非阻塞、24 小时缓存）。 */
  updateCheck?: UpdateCheckConfig;
  /** 首次引导状态（欢迎 → 配 key → 快速上手，全局配置） */
  onboarding?: OnboardingConfig;
}

/** 配置作用域：项目（<cwd>/.shenlan/config.json）或全局（~/.shenlan/config.json） */
export type ConfigScope = 'project' | 'global';

/** 全局配置路径（SHENLAN_CONFIG_DIR 可重定向，供测试隔离） */
export function globalConfigPath(): string {
  return join(process.env.SHENLAN_CONFIG_DIR || join(homedir(), '.shenlan'), 'config.json');
}

/** 项目配置路径 */
export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, '.shenlan', 'config.json');
}

/**
 * provider 规范 key 环境变量名（如 openai → OPENAI_API_KEY），
 * 供 resolveApiKey / hasProviderKey / web-search 错误提示 / /keys 面板共用。
 */
export function envVarForProvider(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

/**
 * provider → 兼容别名环境变量（规范名 <PROVIDER>_API_KEY 未命中后继续探测；
 * GPT_API_KEY 为 gpt-4o 时代的历史兼容，openai 的规范名是 OPENAI_API_KEY）。
 */
const ENV_ALIASES: Record<string, string[]> = { openai: ['GPT_API_KEY'] };

/** provider 按序探测的环境变量清单：规范名 → 别名 */
export function providerEnvVars(provider: string): string[] {
  return [envVarForProvider(provider), ...(ENV_ALIASES[provider] ?? [])];
}

/**
 * 按 provider 名解析 API Key
 * 优先级：环境变量 <PROVIDER>_API_KEY（含兼容别名） > SHENLAN_API_KEY > config.providerKeys > config.model.apiKey
 *
 * 例：model 是 deepseek-v4-flash → provider=deepseek → DEEPSEEK_API_KEY
 *      model 是 qwen-plus → provider=qwen → QWEN_API_KEY
 *      model 是 glm-4-plus → provider=zhipu → ZHIPU_API_KEY
 *      model 是 gpt-5.4 → provider=openai → OPENAI_API_KEY（历史 GPT_API_KEY 兜底）
 */
export function resolveApiKey(config: ShenlanConfig, provider: string): string {
  // 1. 环境变量 <PROVIDER>_API_KEY（通用规则）+ 兼容别名
  for (const name of providerEnvVars(provider)) {
    const envKey = process.env[name];
    if (envKey) return envKey;
  }

  // 2. 也检查 SHENLAN_API_KEY 作为通用 fallback
  if (process.env.SHENLAN_API_KEY) return process.env.SHENLAN_API_KEY;

  // 3. config.providerKeys
  if (config.providerKeys?.[provider]) return config.providerKeys[provider]!;

  // 4. fallback 到 model.apiKey——仅当该 key 属于目标 provider（或未知网关的
  //    通用 key）时才发送，防止把 qwen 的 key 发到 deepseek 端点（401/泄露）。
  if (!config.model.apiKey) return '';
  // 显式 baseUrl 可识别 → key 归属该 provider；未知网关 URL → 通用 key；
  // baseUrl 为空才按配置模型名推断归属。
  const urlProvider = detectProviderFromUrl(config.model.baseUrl);
  const keyHome = urlProvider || (config.model.baseUrl ? '' : resolveModelProvider(config, config.model.model));
  if (keyHome && keyHome !== provider) {
    debugLog('resolveApiKey mismatch — 跳过跨 provider 的 model.apiKey 兜底', {
      provider,
      model: config.model.model,
      baseUrl: config.model.baseUrl,
      keyHome,
    });
    return '';
  }
  return config.model.apiKey;
}

/**
 * 从模型名推断 provider 名
 */
export function detectProvider(model: string): string {
  // 百炼托管的第三方模型快照（如 deepseek-v4-pro-0813，实测仅存在于百炼端点，
  // 官方 deepseek 端点 400）：走百炼 key 与 DashScope 端点，不走官方 deepseek 端点
  if (BAILIAN_HOSTED_MODELS.has(model)) return 'bailian';
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('qwen')) return 'qwen';
  if (model.includes('doubao') || model.includes('skylark')) return 'doubao';
  if (model.startsWith('glm')) return 'zhipu';
  if (model.startsWith('moonshot')) return 'kimi';
  // OpenAI 官方系列（gpt-5.x 主线 + o1/o3/o4 遗留）：仅识别归属（key 走
  // OPENAI_API_KEY、端点走 api.openai.com），不改协议参数（o 系列
  // max_completion_tokens 差异另行处理）
  if (OPENAI_MODEL_PREFIXES.some(p => model.startsWith(p))) return 'openai';
  // 取模型名第一段作为 provider
  return model.split('-')[0] || 'unknown';
}

/** 百炼（DashScope）托管的第三方模型快照名，与官方同名系列端点不互通 */
const BAILIAN_HOSTED_MODELS = new Set(['deepseek-v4-pro-0813']);

/** OpenAI 官方模型名前缀（gpt 覆盖 gpt-4 遗留与 gpt-5.x 主线） */
const OPENAI_MODEL_PREFIXES = ['gpt', 'o1', 'o3', 'o4'];

/**
 * 判断某 provider 是否已配置可用 key。
 * 仅认环境变量 <PROVIDER>_API_KEY 或 config.providerKeys[provider]，
 * 刻意排除 config.model.apiKey 兜底——否则所有 provider 都会被误判为可用，
 * 自动路由无法区分「配了哪个 provider 的 key」。
 */
export function hasProviderKey(config: ShenlanConfig, provider: string): boolean {
  for (const name of providerEnvVars(provider)) {
    if (process.env[name]) return true;
  }
  return Boolean(config.providerKeys?.[provider]);
}

/** 内置厂商定义（OpenAI 兼容模式）；CLI 厂商列表从这里派生。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelsUrl: 'https://api.deepseek.com/v1/models' },
  { id: 'qwen', name: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', modelsUrl: 'https://dashscope.aliyuncs.com/api/v1/models' },
  { id: 'bailian', name: 'Bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', modelsUrl: 'https://dashscope.aliyuncs.com/api/v1/models' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com', modelsUrl: 'https://api.openai.com/v1/models' },
  // 以下三家 detectProvider 早已认领模型名（doubao/skylark、glm-*、moonshot-*）却无端点，
  // resolveBaseUrl 直接抛错 —— 认了就要认到底。端点 2026-09-15 经官方文档核实：
  // doubao: 火山引擎方舟「兼容 OpenAI SDK」文档的 base_url 字面值（仅 cn-beijing 有文档；
  //   海外 BytePlus ModelArk 是另一套 host，不可替代，需要时用 providerBaseUrls.doubao 覆盖）
  { id: 'doubao', name: 'Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelsUrl: 'https://ark.cn-beijing.volces.com/api/v3/models' },
  // zhipu: docs 站迁到 docs.bigmodel.cn，但 **API host 从未搬**，仍是 open.bigmodel.cn
  { id: 'zhipu', name: 'Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models' },
  // kimi: 国内站默认；海外账号 key 与国内不互通，需 providerBaseUrls.kimi =
  //   https://api.moonshot.ai。API host 未随 platform.moonshot.cn → platform.kimi.com 改名
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn', modelsUrl: 'https://api.moonshot.cn/v1/models' },
] as const;

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = Object.fromEntries(
  PROVIDER_PRESETS.map((p) => [p.id, p.baseUrl]),
);

/** 显式模型归属优先；旧配置无 providerModels 时保留模型名前缀推断。 */
export function resolveModelProvider(config: ShenlanConfig, model: string): string {
  const owners = Object.entries(config.providerModels ?? {})
    .filter(([, models]) => models?.includes(model))
    .map(([provider]) => provider);
  if (owners.length > 1) {
    throw new Error(`Model "${model}" is assigned to multiple providers: ${owners.join(', ')}`);
  }
  return owners[0] ?? detectProvider(model);
}

/**
 * 拼接 chat/completions 端点。
 *
 * 不能无脑拼 `/v1/chat/completions`：OpenAI 兼容端点的版本段并不都是 `v1` ——
 * 方舟是 `/api/v3`，智谱是 `/api/paas/v4`，它们的完整路径是 `<base>/chat/completions`。
 * 所以 base 自带版本段时只补 `/chat/completions`，否则维持既有 `/v1/chat/completions`
 * （deepseek / openai 裸 host、DashScope `compatible-mode` 都走这条）。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v\d+(?:\.\d+)?$/.test(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

/**
 * 从 URL 推断 provider（用于判断显式 baseUrl 是否属于已知 provider）。
 * 未知网关（one-api 类自建端点）返回 ''，由 resolveBaseUrl 按「尊重显式配置」处理。
 */
export function detectProviderFromUrl(url: string): string {
  if (/deepseek/i.test(url)) return 'deepseek';
  if (/dashscope|aliyuncs/i.test(url)) return 'qwen';
  if (/openai\.com/i.test(url)) return 'openai';
  if (/volces\.com|bytepluses\.com/i.test(url)) return 'doubao';
  if (/bigmodel\.cn/i.test(url)) return 'zhipu';
  if (/moonshot\.(cn|ai)/i.test(url)) return 'kimi';
  return '';
}

/**
 * 归一化 baseUrl 到 OpenAI 兼容根路径：
 *  - DashScope Anthropic 协议端点（/apps/anthropic）→ 同 host 的 OpenAI 兼容端点 compatible-mode
 *  - 遗留 /anthropic 后缀 → 剥离（deepseek 等）
 *  - 末尾 /v1 → 剥离（客户端统一拼 /v1/chat/completions，避免双重 /v1）
 */
export function normalizeBaseUrl(url: string): string {
  const dashscopeAnthropic = url.match(/^https:\/\/(dashscope(?:-intl)?\.aliyuncs\.com)\/apps\/anthropic\/?$/);
  if (dashscopeAnthropic) return `https://${dashscopeAnthropic[1]}/compatible-mode`;
  return url.replace(/\/anthropic\/?$/, '').replace(/\/v1\/?$/, '');
}

/**
 * 解析模型请求端点（三级优先级）：
 *   1. providerBaseUrls[provider]（可选配置，显式覆盖）
 *   2. config.model.baseUrl：其所属 provider 与模型一致，或属于未知网关（one-api 类）时尊重
 *   3. 内置默认表
 *
 * 兼容遗留：老版本默认值带 /anthropic 后缀（与 /v1/chat/completions 拼接不匹配），
 * 这里归一化到根路径。
 */
export function resolveBaseUrl(config: ShenlanConfig, model: string): string {
  const provider = resolveModelProvider(config, model);

  // 1. providerBaseUrls 显式覆盖
  const providerUrl = config.providerBaseUrls?.[provider];
  if (providerUrl) return providerUrl;

  // 2. 显式 model.baseUrl：已知 provider 必须与模型一致，未知网关一律尊重
  const explicit = config.model.baseUrl;
  if (explicit) {
    const explicitProvider = detectProviderFromUrl(explicit);
    if (!explicitProvider || explicitProvider === provider) {
      return normalizeBaseUrl(explicit);
    }
  }

  // 3. 内置默认表；未知 provider 无显式配置时不再静默回退 deepseek 端点，
  //    显式报错引导用户配置 baseUrl（或走 shenlan --setup 自定义 provider）
  const builtin = PROVIDER_DEFAULT_BASE_URLS[provider];
  if (builtin) return builtin;
  throw new Error(
    `No endpoint for model "${model}" (provider "${provider}"): not a built-in provider ` +
    `(${Object.keys(PROVIDER_DEFAULT_BASE_URLS).join('/')}) and no base URL configured. ` +
    `Set model.baseUrl (or providerBaseUrls."${provider}") in ~/.shenlan/config.json ` +
    `or .shenlan/config.json, or run "shenlan --setup" and pick "Custom OpenAI-compatible".`,
  );
}

/** 默认配置 */
export const DEFAULT_CONFIG: ShenlanConfig = {
  schemaVersion: 1,
  language: 'en',
  model: {
    // 空字符串 = 未显式配置，实际端点由 resolveBaseUrl 按模型 provider 解析
    // （修掉旧默认 .../anthropic 与 /v1/chat/completions 拼接不匹配的遗留）
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-v4-flash',
    maxTokens: 8192,
  },
  permissions: {
    mode: 'default',
    allow: ['read', 'search'],
    deny: [],
  },
  skills: [],
  mcpServers: [],
  agent: {
    maxSteps: 80,
    goalMaxSteps: 300,
    maxBackground: 3,
  },
  context: {
    autoCompactTokenLimit: 200_000,
    keepRecentTurns: 20,
    toolOutputLimitChars: 8000,
    // 空字符串 = 跟随主模型 provider（deepseek → deepseek-v4-flash，qwen → qwen-plus）
    compactModel: '',
    maxMemoryTokens: 4096,
    thinkingOutputFloor: 16384,
  },
  costGuardrails: {
    enabled: true,
    maxCostPerSession: 5,
    maxCostPerDay: 20,
    currency: 'CNY',
    balanceCheckBeforeStart: true,
    lowBalanceWarnThreshold: 1,
  },
  memory: {
    autoSave: true,
  },
  updateCheck: {
    enabled: true,
  },
  tavily: {
    enabled: false,
  },
  actionSafety: {
    highRiskActions: 'deny',
    confirmPhrase: 'yes',
    protectedPaths: [],
    auditEnabled: true,
  },
  planMode: {
    readonlyCommands: [
      'git status', 'git diff', 'git log', 'git show', 'git branch',
      'ls', 'pwd', 'echo', 'cat',
    ],
  },
  pitfallMemory: {
    injectTopN: 5,
    searchBeforeAction: true,
    autoRecordOnError: true,
  },
  providerFailover: {
    enabled: false,
  },
};

/**
 * 旧版 ensureConfig 自动写入项目配置的 model 默认模板（deepseek 默认值）。
 * 该模板会按「项目配置覆盖全局」规则错误覆盖全局 qwen 配置，loadConfig 加载时
 * 与它完全一致的项目 model 块视为「未配置模型」，让全局配置生效。
 */
const LEGACY_PROJECT_DEFAULT_MODEL = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-flash',
  maxTokens: 8192,
};

/**
 * 简易深合并（只处理 config 这种浅对象）
 */
function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    const val = overrides[key];
    if (val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
      // 对象 → 递归合并
      if (typeof val === 'object' && val !== null && !Array.isArray(val) && typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
      }
      // 数组 → 合并（去重 name）
      else if (Array.isArray(val) && Array.isArray(result[key])) {
        const baseArr = result[key] as Array<Record<string, unknown>>;
        const overrideArr = val as Array<Record<string, unknown>>;
        const merged = [...baseArr];
        for (const item of overrideArr) {
          if (!baseArr.some(b => b.name === item.name)) {
            merged.push(item);
          }
        }
        result[key] = merged;
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

/**
 * 加载 JSON 配置文件，不存在则返回 null
 */
function loadJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 加载所有配置并合并
 */
export function loadConfig(cwd?: string): ShenlanConfig {
  let config = { ...DEFAULT_CONFIG };

  // 1. 全局配置 ~/.shenlan/config.json（首次自动创建目录和默认配置）
  const globalPath = globalConfigPath();
  if (!existsSync(globalPath)) {
    createDefaultConfigFile(globalPath);
  } else {
    // 老用户升级补写样例文件（config.sample.json / README.md / env.example）
    ensureConfigSampleFiles(globalPath);
  }
  const globalConfig = loadJsonFile(globalPath);
  if (globalConfig) {
    config = deepMerge(config as unknown as Record<string, unknown>, globalConfig) as unknown as ShenlanConfig;
  }

  // 2. 项目配置 <cwd>/.shenlan/config.json
  const projectPath = projectConfigPath(cwd || process.cwd());
  const projectConfig = loadJsonFile(projectPath);
  if (projectConfig) {
    // 旧版 ensureConfig 自动写入的项目 model 块（deepseek 默认值）会错误覆盖全局 qwen 配置；
    // 与模板完全一致时视为「未配置模型」，让全局配置生效（对齐 Claude Code 项目配置语义）。
    // 用户显式自定义的项目 model 块不受影响，仍按既有规则覆盖全局。
    const m = projectConfig.model as Record<string, unknown> | undefined;
    if (m && typeof m === 'object' && !Array.isArray(m) &&
        m.baseUrl === LEGACY_PROJECT_DEFAULT_MODEL.baseUrl &&
        m.apiKey === LEGACY_PROJECT_DEFAULT_MODEL.apiKey &&
        m.model === LEGACY_PROJECT_DEFAULT_MODEL.model &&
        m.maxTokens === LEGACY_PROJECT_DEFAULT_MODEL.maxTokens) {
      delete projectConfig.model;
    }
    config = deepMerge(config as unknown as Record<string, unknown>, projectConfig) as unknown as ShenlanConfig;
  }

  // 3. 环境变量覆盖
  if (process.env.SHENLAN_API_KEY) {
    config.model.apiKey = process.env.SHENLAN_API_KEY;
  }
  if (process.env.SHENLAN_BASE_URL) {
    config.model.baseUrl = process.env.SHENLAN_BASE_URL;
  }
  if (process.env.SHENLAN_MODEL) {
    config.model.model = process.env.SHENLAN_MODEL;
  }

  // 归一化（仅内存，不改写磁盘）：旧版把 key 放在 model.apiKey，
  // 而 hasProviderKey / 路由只认 providerKeys —— 按默认模型的 provider
  // 把 model.apiKey 归入 providerKeys，修复 /model 面板「有 key 却显示无 key」。
  // 环境变量与显式 providerKeys 优先级不变（resolveApiKey 仍先查它们）。
  if (config.model.apiKey && !hasProviderKey(config, resolveModelProvider(config, config.model.model))) {
    const provider = resolveModelProvider(config, config.model.model || 'deepseek-v4-flash');
    config.providerKeys = { ...(config.providerKeys || {}), [provider]: config.model.apiKey };
    debugLog('config normalize — model.apiKey → providerKeys (memory only)', { provider });
  }

  return config;
}

/**
 * 是否存在任意可用的 provider key（环境变量或 providerKeys 任一非空）。
 * 用于首次引导判断：无任何 key 时自动打开 /keys 面板。
 */
export function hasAnyProviderKey(config: ShenlanConfig): boolean {
  if (process.env.SHENLAN_API_KEY) return true;
  // 内置 provider 环境变量（含别名；与 /keys 面板一致；.env 加载后同样生效）
  for (const provider of Object.keys(PROVIDER_DEFAULT_BASE_URLS)) {
    for (const name of providerEnvVars(provider)) {
      if (process.env[name]) return true;
    }
  }
  if (config.providerKeys) {
    for (const key of Object.values(config.providerKeys)) {
      if (key) return true;
    }
  }
  return false;
}

/**
 * 创建默认配置文件（用于首次引导）
 */
export function createDefaultConfigFile(filePath: string): void {
  const isGlobal = filePath === globalConfigPath();
  mkdirSync(dirname(filePath), {
    recursive: true,
    ...(isGlobal ? { mode: 0o700 } : {}),
  });
  writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // 首次生成目录时同步产出配置样例（缺失才写，幂等）
  ensureConfigSampleFiles(filePath);
}

/**
 * 确保配置目录内的样例文件齐全（config.sample.json / README.md / env.example）。
 * 只补缺失项，不覆盖已存在文件；用于首次生成与老用户升级补写。
 */
export function ensureConfigSampleFiles(filePath: string): void {
  const dir = dirname(filePath);
  const isGlobal = filePath === globalConfigPath();
  mkdirSync(dir, {
    recursive: true,
    ...(isGlobal ? { mode: 0o700 } : {}),
  });
  const sample = isGlobal ? CONFIG_SAMPLE_GLOBAL : CONFIG_SAMPLE_PROJECT;
  const files: Array<[string, string]> = [
    ['config.sample.json', JSON.stringify(sample, null, 2) + '\n'],
    ['README.md', CONFIG_README_MD],
    ['env.example', ENV_EXAMPLE],
  ];
  for (const [name, content] of files) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      writeFileSync(p, content, { encoding: 'utf-8', mode: 0o600 });
    }
  }
}

/** 项目默认配置：model 留空（沿用全局/默认模型），避免覆盖用户全局配置 */
const PROJECT_DEFAULT_CONFIG: Record<string, unknown> = {
  model: { baseUrl: '', apiKey: '', model: '' },
  permissions: { mode: 'default', allow: ['read', 'search'], deny: [] },
  skills: [],
  mcpServers: [],
};

/**
 * 确保项目 .shenlan 目录与配置文件存在（首次运行懒生成，幂等）。
 * 项目 config.json 已存在时绝不改写；样例文件缺失时补写。
 */
export function ensureProjectConfigFiles(cwd = process.cwd()): void {
  const file = projectConfigPath(cwd);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(PROJECT_DEFAULT_CONFIG, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
  ensureConfigSampleFiles(file);
}

/**
 * 读取某个作用域的原始配置文件（不做深合并）。
 * 文件不存在返回 null；存在但无法解析时抛错，避免写操作静默覆盖损坏数据。
 */
export function readRawConfig(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`无法解析配置文件 ${filePath}: ${(err as Error).message}`);
  }
}

/** 原子写配置文件：先写临时文件再 rename，避免写一半崩溃留下损坏 JSON */
export function writeConfigFile(filePath: string, data: Record<string, unknown>): void {
  // 全局目录 ~/.shenlan 创建时收紧为 0700（含密钥配置）；
  // 项目 .shenlan 目录沿用默认 umask，不改变既有行为。
  const isGlobal = filePath === globalConfigPath();
  mkdirSync(dirname(filePath), {
    recursive: true,
    ...(isGlobal ? { mode: 0o700 } : {}),
  });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  renameSync(tmp, filePath);
}

/** 定向合并：对象递归合并，数组/标量整体替换（与 loadConfig 的按 name 去重合并语义不同） */
function mergeConfigPatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (
      typeof val === 'object' && val !== null && !Array.isArray(val) &&
      typeof out[key] === 'object' && out[key] !== null && !Array.isArray(out[key])
    ) {
      out[key] = mergeConfigPatch(out[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * 更新指定作用域的配置文件（原子写，只动 patch 涉及的字段，其余保留）。
 * 数组（mcpServers/skills）为整体替换语义，调用方需传入完整数组。
 */
export function updateConfig(
  patch: Partial<ShenlanConfig>,
  opts: { scope: ConfigScope; cwd?: string },
): { file: string } {
  const file = opts.scope === 'global' ? globalConfigPath() : projectConfigPath(opts.cwd || process.cwd());
  const raw = readRawConfig(file) || {};
  const merged = mergeConfigPatch(raw, patch as unknown as Record<string, unknown>);
  writeConfigFile(file, merged);
  return { file };
}

/** 向指定作用域配置新增一个 MCP server（同作用域 name 重复时报错） */
export function addMcpServerToConfig(
  server: { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> },
  scope: ConfigScope,
  cwd = process.cwd(),
): { file: string } {
  const file = scope === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const raw = readRawConfig(file) || {};
  const list = Array.isArray(raw.mcpServers) ? (raw.mcpServers as Array<Record<string, unknown>>) : [];
  if (list.some(s => s.name === server.name)) {
    throw new Error(`MCP server "${server.name}" already exists in ${scope} config (${file})`);
  }
  writeConfigFile(file, { ...raw, mcpServers: [...list, server] });
  return { file };
}

/** 从指定作用域配置删除一个 MCP server */
export function removeMcpServerFromConfig(
  name: string,
  scope: ConfigScope,
  cwd = process.cwd(),
): { file: string; removed: boolean } {
  const file = scope === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const raw = readRawConfig(file) || {};
  const list = Array.isArray(raw.mcpServers) ? (raw.mcpServers as Array<Record<string, unknown>>) : [];
  const next = list.filter(s => s.name !== name);
  if (next.length === list.length) return { file, removed: false };
  writeConfigFile(file, { ...raw, mcpServers: next });
  return { file, removed: true };
}

/** 计算每个已配置 MCP server 的作用域（同 name 时项目覆盖全局） */
export function getMcpServerScopes(cwd = process.cwd()): Map<string, ConfigScope> {
  const map = new Map<string, ConfigScope>();
  const globalList = readRawConfig(globalConfigPath())?.mcpServers;
  if (Array.isArray(globalList)) {
    for (const s of globalList) if (typeof s === 'object' && s !== null && (s as { name?: string }).name) {
      map.set((s as { name: string }).name, 'global');
    }
  }
  const projectList = readRawConfig(projectConfigPath(cwd))?.mcpServers;
  if (Array.isArray(projectList)) {
    for (const s of projectList) if (typeof s === 'object' && s !== null && (s as { name?: string }).name) {
      map.set((s as { name: string }).name, 'project');
    }
  }
  return map;
}
