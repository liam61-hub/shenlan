/**
 * 配置键目录（schema 驱动）— /config 命令与未来配置管理共用的唯一键面。
 *
 * 新增任何配置开关只需在这里加一行条目（或一条前缀规则），
 * /config get|set|unset 的类型校验、敏感掩码、Tab 补全自动生效。
 * 描述为双语（en/zh），随 language 配置键选择展示语言（默认 en）。
 * 与 config-samples.ts 的 SAMPLE_BASE 保持同步（新增配置时两处都补）。
 */

/** 界面语言（language 配置键取值） */
export type Lang = 'en' | 'zh-CN';

/** 双语文本（配置描述/提示用；en 为默认语言） */
export interface BilingualText {
  en: string;
  zh: string;
}

/** 按语言取双语文本 */
export function descText(d: BilingualText, lang: Lang): string {
  return lang === 'en' ? d.en : d.zh;
}

export interface ConfigKeyMeta {
  type: 'string' | 'number' | 'boolean';
  description: BilingualText;
  /** 敏感键：展示时掩码（apiKey 类） */
  secret?: boolean;
  /** string 类型允许的取值集合（路由策略、权限模式等） */
  allowedValues?: string[];
  /** 默认值：与 DEFAULT_CONFIG 嵌套值一致（schema 测试守护，防漂移） */
  default?: unknown;
}

/** 动态前缀规则（如 providerKeys.<provider> 无法穷举的键） */
export interface ConfigKeyPrefixRule {
  prefix: string;
  type: 'string' | 'number' | 'boolean';
  description: BilingualText;
  secret?: boolean;
}

export const CONFIG_KEYS: Record<string, ConfigKeyMeta> = {
  'language': {
    type: 'string',
    description: { en: 'UI language (en / zh-CN)', zh: '界面语言（en / zh-CN）' },
    allowedValues: ['en', 'zh-CN'],
    default: 'en',
  },
  'model.model': {
    type: 'string',
    description: {
      en: 'Default model name (baseline when routing is not locked)',
      zh: '默认模型名（未路由锁定时的基线模型）',
    },
    default: 'deepseek-v4-flash',
  },
  'model.baseUrl': {
    type: 'string',
    description: {
      en: 'Explicit API endpoint (empty = resolve by provider built-in defaults)',
      zh: '显式请求端点（留空按 provider 内置默认解析）',
    },
    secret: true,
    default: '',
  },
  'model.apiKey': {
    type: 'string',
    description: { en: 'Fallback API key (prefer providerKeys)', zh: '单 key 兜底（推荐改用 providerKeys）' },
    secret: true,
    default: '',
  },
  'model.maxTokens': {
    type: 'number',
    description: { en: 'Max tokens per response', zh: '单次回复最大 token 数' },
    default: 8192,
  },
  'model.maxOutputTokens': {
    type: 'number',
    description: {
      en: 'Hard output cap per response (thinking + answer share it). Defaults to model catalog value.',
      zh: '单次响应硬输出上限（思考与正文共享）。缺省按模型目录值。',
    },
    // 无 default：缺省时不写盘，按模型目录 maxOutputTokens 解析
  },
  'permissions.mode': {
    type: 'string',
    description: { en: 'Permission mode', zh: '权限模式' },
    allowedValues: ['default', 'acceptEdits', 'bypassPermissions'],
    default: 'default',
  },
  'routing.policy': {
    type: 'string',
    description: { en: 'Model routing policy', zh: '模型路由策略' },
    allowedValues: ['cost-first', 'quality-first', 'manual'],
    // 无 default 声明：缺省 cost-first 由 router.ts initRoutingFromConfig 应用，
    // DEFAULT_CONFIG 不落 routing 块（声明 default 会误导生成配置文件）
  },
  'routing.lockedModel': {
    type: 'string',
    description: {
      en: 'Model locked under manual policy (null when auto)',
      zh: 'manual 策略锁定的模型名（auto 时为 null）',
    },
  },
  'agent.maxSteps': {
    type: 'number',
    description: { en: 'Headless agent run max steps', zh: '无界面单次 Agent 运行步数上限' },
    default: 80,
  },
  'agent.maxBackground': {
    type: 'number',
    description: {
      en: 'Max concurrent background Explore agents (background_agent)',
      zh: '后台 Explore agent（background_agent）并发上限',
    },
    default: 3,
  },
  'context.autoCompactTokenLimit': {
    type: 'number',
    description: {
      en: 'Auto-compaction token threshold (capped at min(config, 90% × window))',
      zh: '自动压缩触发阈值（token，实际上限取 min(配置, 90%×窗口)）',
    },
    default: 200_000,
  },
  'context.keepRecentTurns': {
    type: 'number',
    description: {
      en: 'Recent turns kept fully during compaction',
      zh: '压缩时保留最近 N 轮完整消息',
    },
    default: 20,
  },
  'context.toolOutputLimitChars': {
    type: 'number',
    description: {
      en: 'Tool output over this size goes to ref as summary',
      zh: '工具输出超过该字符数进 ref 只留摘要',
    },
    default: 8000,
  },
  'context.compactModel': {
    type: 'string',
    description: {
      en: 'Model for compaction summaries (empty = follow main model provider)',
      zh: '压缩摘要模型（留空跟随主模型 provider）',
    },
    default: '',
  },
  'context.maxMemoryTokens': {
    type: 'number',
    description: {
      en: 'Token budget for the memory section in the system prompt (project memories kept first when folding)',
      zh: '记忆段注入 system prompt 的 token 预算（超预算折叠时项目记忆优先保留）',
    },
    default: 4096,
  },
  'context.thinkingOutputFloor': {
    type: 'number',
    description: {
      en: 'Minimum output budget for thinking models (reasoning shares the output budget)',
      zh: '思考模型的输出预算下限（推理与正文共享输出额度，过小会导致正文为空）',
    },
    default: 16384,
  },
  'balanceCheck.enabled': {
    type: 'boolean',
    description: {
      en: 'Check DeepSeek account balance at startup (/user/balance)',
      zh: '启动时预检 DeepSeek 账户余额（/user/balance）',
    },
    default: true,
  },
  'updateCheck.enabled': {
    type: 'boolean',
    description: {
      en: 'Check for CLI updates at interactive startup (non-blocking, cached for 24 hours)',
      zh: '交互式启动时检查 CLI 新版本（非阻塞，缓存 24 小时）',
    },
    default: true,
  },
  'balanceCheck.lowBalanceWarnThreshold': {
    type: 'number',
    description: {
      en: 'Warn at startup when balance below this (CNY)',
      zh: '余额低于该值（¥）时启动告警',
    },
    default: 1,
  },
  'memory.autoSave': {
    type: 'boolean',
    description: {
      en: 'Auto Memory: model may save cross-session memories',
      zh: 'Auto Memory：模型可自主保存跨会话记忆',
    },
    default: true,
  },
  'tavily.enabled': {
    type: 'boolean',
    description: {
      en: 'Register standalone tavily_search tool (off by default; web_search Tavily fallback unaffected)',
      zh: '注册独立 tavily_search 工具（默认关闭，web_search 的 Tavily 兜底不受影响）',
    },
    default: false,
  },
  'actionSafety.highRiskActions': {
    type: 'string',
    description: {
      en: 'High-risk actions: deny (block) / confirm (phrase once)',
      zh: '高危动作处置：deny 硬拦截 / confirm 输入确认短语放行一次',
    },
    allowedValues: ['deny', 'confirm'],
    default: 'deny',
  },
  'actionSafety.confirmPhrase': {
    type: 'string',
    description: { en: 'Confirmation phrase for high-risk actions', zh: '高危双确认的确认短语' },
    secret: true,
    default: 'yes',
  },
  // 数组类键：/config 仅展示（set 不做数组解析，编辑走配置文件，与 mcpServers 同口径）
  'actionSafety.protectedPaths': {
    type: 'string',
    description: {
      en: 'Protected paths (array; edit config file; write/edit hits are blocked)',
      zh: '保护路径清单（数组，编辑配置文件；write/edit 命中即拦截）',
    },
  },
  'actionSafety.auditEnabled': {
    type: 'boolean',
    description: {
      en: 'Action-level audit events (high-risk always recorded)',
      zh: '动作级审计事件记录（高危动作恒记录不可关闭）',
    },
    default: true,
  },
  'planMode.readonlyCommands': {
    type: 'string',
    description: {
      en: 'Plan-mode read-only shell command allowlist (array; edit config file)',
      zh: 'plan 态 shell 只读命令白名单（数组，编辑配置文件）',
    },
  },
  'pitfallMemory.injectTopN': {
    type: 'number',
    description: {
      en: 'Pitfall memory top-N injection count (reserved)',
      zh: '坑记忆注入 top-N 排序条目数（预留）',
    },
    default: 5,
  },
  'pitfallMemory.searchBeforeAction': {
    type: 'boolean',
    description: {
      en: 'Search before critical actions (reserved)',
      zh: '关键动作前检索提示（预留）',
    },
    default: true,
  },
  'pitfallMemory.autoRecordOnError': {
    type: 'boolean',
    description: {
      en: 'Auto-increment hits when a tool error matches a known trigger',
      zh: '工具失败且错误匹配已知 trigger 时自动命中递增',
    },
    default: true,
  },
  'providerFailover.enabled': {
    type: 'boolean',
    description: {
      en: 'On primary provider failure (5xx/402/network timeout), fail over once to a backup provider',
      zh: '主 provider 失败（5xx/402/网络超时）自动切换备用 provider 重试一次',
    },
    default: false,
  },
};

/** 无法穷举的动态键（前缀匹配） */
export const CONFIG_KEY_PREFIXES: ConfigKeyPrefixRule[] = [
  {
    prefix: 'providerKeys.',
    type: 'string',
    description: { en: 'API key per provider', zh: '各 provider 的 API Key' },
    secret: true,
  },
  {
    prefix: 'providerBaseUrls.',
    type: 'string',
    description: { en: 'API endpoint override per provider', zh: '各 provider 的请求端点覆盖' },
    secret: true,
  },
];

/** 按点路径查键元数据：先精确键，再前缀规则；未知键返回 null */
export function lookupConfigKey(key: string): ConfigKeyMeta | null {
  const exact = CONFIG_KEYS[key];
  if (exact) return exact;
  const rule = CONFIG_KEY_PREFIXES.find((r) => key.startsWith(r.prefix));
  return rule ? { type: rule.type, description: rule.description, secret: rule.secret } : null;
}

export type ParseConfigResult = { ok: true; value: string | number | boolean } | { ok: false; error: string };

/** 按 schema 校验并转换用户输入的字符串值 */
export function parseConfigValue(key: string, raw: string): ParseConfigResult {
  const meta = lookupConfigKey(key);
  if (!meta) return { ok: false, error: `未知配置项: ${key}（/config 查看全部可配键）` };
  if (meta.type === 'boolean') {
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false, error: `${key} 需要 boolean（true/false），收到: ${raw}` };
  }
  if (meta.type === 'number') {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) return { ok: true, value: n };
    return { ok: false, error: `${key} 需要 number，收到: ${raw}` };
  }
  if (meta.allowedValues && !meta.allowedValues.includes(raw)) {
    return { ok: false, error: `${key} 只允许: ${meta.allowedValues.join(' / ')}，收到: ${raw}` };
  }
  return { ok: true, value: raw };
}

/** 按点路径读取嵌套值；路径缺失返回 undefined */
export function getNested(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 按点路径写入嵌套值，返回新根对象（不改传入对象） */
export function setNested(root: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.');
  const out = { ...root };
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    const child = typeof next === 'object' && next !== null && !Array.isArray(next)
      ? { ...(next as Record<string, unknown>) }
      : {};
    cur[part] = child;
    cur = child;
  }
  cur[parts[parts.length - 1]!] = value;
  return out;
}

/** 按点路径删除嵌套键（原地改）；返回是否真的删掉了东西 */
export function deleteNested(obj: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]!];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false;
    cur = next as Record<string, unknown>;
  }
  if (!(parts[parts.length - 1]! in cur)) return false;
  delete cur[parts[parts.length - 1]!];
  return true;
}

/** 环境变量元数据（/config 与 shenlan config 的环境变量清单区） */
export interface EnvVarMeta {
  /** 变量名（`<PROVIDER>_API_KEY` 为模式行，代表一类变量） */
  name: string;
  description: BilingualText;
  /** 敏感变量：展示时掩码（API Key / 端点类） */
  secret?: boolean;
}

/** 产品环境变量目录：新增环境变量时在此登记，展示/掩码自动生效 */
export const ENV_VARS: EnvVarMeta[] = [
  {
    name: 'SHENLAN_MODEL',
    description: { en: 'Default model (overrides config model.model)', zh: '默认模型（优先于配置文件 model.model）' },
  },
  {
    name: 'SHENLAN_BASE_URL',
    description: { en: 'API endpoint override (overrides config model.baseUrl)', zh: 'API 端点覆盖（优先于配置文件 model.baseUrl）' },
    secret: true,
  },
  {
    name: 'SHENLAN_API_KEY',
    description: { en: 'Single API key (overrides config model.apiKey)', zh: '单 API Key（优先于配置文件 model.apiKey）' },
    secret: true,
  },
  {
    name: 'SHENLAN_CONFIG_DIR',
    description: { en: 'Global config dir override (default ~/.shenlan; test isolation)', zh: '全局配置目录重定向（默认 ~/.shenlan，测试隔离用）' },
  },
  {
    name: 'SHENLAN_DEBUG',
    description: { en: 'Debug logging switch', zh: '调试日志开关' },
  },
  {
    name: 'SHENLAN_NO_UPDATE_CHECK',
    description: { en: 'Disable interactive startup update checks', zh: '关闭交互式启动版本检查' },
  },
  {
    name: 'NO_UPDATE_NOTIFIER',
    description: { en: 'Standard environment switch for disabling update notifications', zh: '关闭版本更新提示的通用环境变量' },
  },
  {
    name: '<PROVIDER>_API_KEY',
    description: {
      en: 'API key per provider (e.g. DEEPSEEK_API_KEY / QWEN_API_KEY / OPENAI_API_KEY / TAVILY_API_KEY)',
      zh: '各 provider 的 API Key（如 DEEPSEEK_API_KEY / QWEN_API_KEY / OPENAI_API_KEY / TAVILY_API_KEY）',
    },
    secret: true,
  },
];
