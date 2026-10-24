/**
 * 联网搜索 — 按当前模型 provider 自动选择原生搜索，无原生适配器时走 Tavily
 *
 * deepseek → Responses API（原生 web_search 工具）
 * qwen     → DashScope OpenAI 兼容 chat/completions + enable_search（黑盒回答，不返回来源）
 * 其他     → Tavily（通用）
 *
 * 原生搜索失败一律报错、不降级 Tavily（避免静默降级掩盖问题）；
 * 无原生适配器或对应 provider 没配 key 时才落到 Tavily。
 *
 * 活动模型注入：CLI router 在 /model 切换、自动路由、会话粘性时调用 setActiveModel
 * 同步「实际生效模型」到 core 模块态；web_search 优先用它做 provider 路由，
 * 未注入时回退 loadConfig().model.model（独立使用 core 的场景）。
 */
import { registerTool } from './index.js';
import type { ShenlanConfig } from '../config.js';
import { chatCompletionsUrl, detectProvider, loadConfig, resolveApiKey, resolveBaseUrl, envVarForProvider } from '../config.js';

/** 搜索结果（文本）或错误；timeout 标记供适配器决定是否走快速回退路径 */
type SearchResult = { text: string } | { error: string; timeout?: boolean };

/** provider 原生搜索适配器 */
interface NativeSearchAdapter {
  provider: string;
  execute: (
    query: string,
    apiKey: string,
    config: ShenlanConfig,
    signal?: AbortSignal,
  ) => Promise<SearchResult>;
}

/** 错误提示里的 provider 展示名 */
const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  qwen: 'qwen',
  bailian: 'DeepSeek(百炼)',
  openai: 'OpenAI',
};

/** CLI 运行时注入的实际生效模型（沿用 setAgentConfig 模式；null = 未注入） */
let activeModel: string | null = null;

/** 注入实际生效模型（CLI router 在 /model 切换 / 自动路由 / 会话粘性时同步） */
export function setActiveModel(model: string | null): void {
  activeModel = model;
}

/** 获取注入的实际生效模型；未注入返回 null（调用方回退配置 model.model） */
export function getActiveModel(): string | null {
  return activeModel;
}

/** DeepSeek 原生搜索单次请求超时（实测约 20s，历史偶发超时；60s + 超时重试 1 次） */
const DEEPSEEK_TIMEOUT_MS = 60_000;

/** DeepSeek Responses API 原生搜索 */
async function deepseekSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult> {
  let lastError = '';
  // 超时重试一次：查询幂等（同 query 重搜）；外部 abort（用户中止/外层工具超时）不重试
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS);
      const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const resp = await fetch('https://api.deepseek.com/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'deepseek-v4-flash', input: query, tools: [{ type: 'web_search' }] }),
        signal: merged,
      });
      if (!resp.ok) return { error: `HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}` };

      const data = await resp.json() as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
      const joined = parseResponsesText(data);
      if (!joined) return { error: 'API returned no text content: ' + JSON.stringify(data.output?.map(i => i.type) || []) };
      // Limit output to prevent token waste (max ~2000 chars)
      return { text: joined.length > 2000 ? joined.slice(0, 2000) + '...(truncated)' : joined };
    } catch (err) {
      const e = err as Error;
      lastError = e.message;
      // 仅超时可重试一次；外部 abort 立即返回
      const isTimeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
      if (!isTimeout || signal?.aborted) break;
    }
  }
  return { error: lastError };
}

/** 解析 Responses API 输出：跳过 reasoning/thinking，拼接 message 文本（deepseek 与 qwen 共用） */
function parseResponsesText(
  data: { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> },
): string {
  const texts: string[] = [];
  for (const item of data.output || []) {
    // Skip reasoning/thinking content — only keep search results and output
    if (item.type === 'reasoning') continue;
    if (item.content) for (const c of item.content) { if (c.text) texts.push(c.text); }
  }
  return texts.join('\n\n');
}

/**
 * qwen 原生搜索 — DashScope OpenAI 兼容 chat/completions + enable_search。
 * 服务端把搜索结果注入模型上下文并生成回答，客户端只拿到最终文本
 * （OpenAI 兼容协议不返回搜索来源，形态与 DeepSeek 原生搜索一致）。
 *
 * 实测结论（2026-08-27，国内 DashScope 端点）：
 *  - 端点必须带 /v1（compatible-mode/v1/chat/completions），缺 /v1 返回 404 空 body
 *    （由 chatCompletionsUrl 统一拼接：base 无版本段时补 /v1）
 *  - 必须 stream=true：非流式直接 400 "Non-streaming mode does not support Web Search"
 *  - search_options 必须有（仅 enable_search 时不触发搜索）；非思考模型 strategy 用 agent
 */
export async function qwenSearch(
  query: string,
  apiKey: string,
  model: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  try {
    const timeoutSignal = AbortSignal.timeout(30000);
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const resp = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: query }],
        // 非 OpenAI 标准参数：enable_search 开启联网搜索；forced_search 保证工具语义下
        // 每次都真正搜索；非思考模式搜索策略必须为 agent（官方文档 + 实测）
        enable_search: true,
        search_options: { forced_search: true, search_strategy: 'agent' },
        stream: true,
      }),
      signal: merged,
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}` };

    // 流式响应：SSE 行逐个拼接 choices[0].delta.content
    const text = await readSseText(resp);
    if (!text) return { error: 'qwen search returned empty content' };
    return { text: text.length > 2000 ? text.slice(0, 2000) + '...(truncated)' : text };
  } catch (err) { return { error: (err as Error).message }; }
}

/** 读取 chat/completions SSE 流，拼接 choices[0].delta.content */
async function readSseText(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 行以 \n 分隔（兼容 \r\n）；只处理 data: 行
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') text += delta;
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text.trim();
}

/**
 * 可通过 Chat Completions（enable_search + 流式）启用联网搜索的 qwen 模型白名单
 * （2026-08-27 实测）：agent 策略 + 流式，实测返回真实联网结果（含当日实时预报）。
 *
 * 维护约定（#12）：新增 qwen 目录模型时必须复核搜索归属——仅 qwen-plus /
 * qwen3.7-plus 走 enable_search Chat 路径；qwen3.7-max 及之后旗舰走 Responses API；
 * 名单外模型（qwen-turbo/qwen3.7-flash/qwen-vl-max 等）一律回退 qwen-plus（实测不可用）。
 * 无法实测时宁可回退 qwen-plus，不要凭官方能力表猜。漂移守卫测试锁定本表 ⊆ 目录。
 */
export const QWEN_CHAT_SEARCH_MODELS = new Set(['qwen-plus', 'qwen3.7-plus']);

/**
 * 仅支持通过 Responses API（tools: web_search）联网搜索的 qwen 模型白名单
 * （2026-08-27 实测）：qwen3.8-max / qwen3.7-max / qwen3.8-2.4t-a95b 均返回真实
 * 联网结果（含当日预警/来源），Chat Completions 路径一律 400 agent 策略不支持
 * （与官方文档「qwen3.7-max 及之后的旗舰仅 Responses API 支持搜索」一致）。
 * 不可用：qwen-max（旧名）Responses API 400 Unsupported model、Chat 路径 500。
 */
export const QWEN_RESPONSES_MODELS = new Set(['qwen3.8-max', 'qwen3.7-max', 'qwen3.8-2.4t-a95b']);

/**
 * qwen Responses API 单次请求超时（实测延迟波动 24s–90s+，旗舰模型+联网搜索偏慢；
 * 30s 内完成才值得等，超时后 qwen 适配器回退 qwen-plus Chat 快速路径 ~10s）
 */
const QWEN_RESPONSES_TIMEOUT_MS = 30_000;

/**
 * 百炼托管模型（deepseek-v4-pro-0813）Responses API 单次请求超时：
 * 实测简单查询 ~16s、复杂法律查询 ~39s；无回退路径（qwen 免费额度已耗尽），
 * 60s 覆盖观察到的耗时，超时则明确报错。
 */
const BAILIAN_RESPONSES_TIMEOUT_MS = 60_000;

/**
 * DashScope Responses API 原生搜索 — compatible-mode/v1/responses + web_search 工具。
 * qwen Max 系列（qwen3.7-max 及之后）与百炼托管的第三方模型（deepseek-v4-pro-0813）
 * 共用此路径，返回最终文本。
 */
export async function dashscopeResponsesSearch(
  query: string,
  apiKey: string,
  model: string,
  baseUrl: string,
  signal?: AbortSignal,
  timeoutMs: number = QWEN_RESPONSES_TIMEOUT_MS,
): Promise<SearchResult> {
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const resp = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: query,
        tools: [{ type: 'web_search' }],
      }),
      signal: merged,
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}` };

    const data = await resp.json() as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
    const joined = parseResponsesText(data);
    if (!joined) return { error: 'API returned no text content: ' + JSON.stringify(data.output?.map(i => i.type) || []) };
    return { text: joined.length > 2000 ? joined.slice(0, 2000) + '...(truncated)' : joined };
  } catch (err) {
    const e = err as Error;
    const isTimeout = !signal?.aborted && (e.name === 'TimeoutError' || /timeout/i.test(e.message));
    return isTimeout ? { error: e.message, timeout: true } : { error: e.message };
  }
}

/**
 * qwen 原生搜索适配器模型决策：
 *  - Chat Completions 白名单（qwen-plus / qwen3.7-plus）→ 原模型 + enable_search 流式
 *  - Responses API 白名单（qwen3.8-max / qwen3.7-max / qwen3.8-2.4t-a95b）→ 原模型 + web_search 工具
 *  - 其余（qwen-turbo 实测不触发真实搜索、qwen3.7-flash 单次 65s 超预算、qwen-max 旧名
 *    双路径均报错等）→ 统一回退 qwen-plus 执行搜索
 */
export function qwenSearchModel(active: string): { model: string; viaResponses: boolean } {
  if (QWEN_CHAT_SEARCH_MODELS.has(active)) return { model: active, viaResponses: false };
  if (QWEN_RESPONSES_MODELS.has(active)) return { model: active, viaResponses: true };
  return { model: 'qwen-plus', viaResponses: false };
}

/** 原生搜索适配器表：新增 provider 时在此登记 */
const NATIVE_SEARCH_ADAPTERS: Record<string, NativeSearchAdapter> = {
  deepseek: {
    provider: 'deepseek',
    execute: (query, apiKey, _config, signal) => deepseekSearch(query, apiKey, signal),
  },
  /** 百炼托管的第三方模型（如 deepseek-v4-pro-0813）：DashScope Responses API + web_search */
  bailian: {
    provider: 'bailian',
    execute: (query, apiKey, config, signal) => {
      const active = getActiveModel() ?? config.model.model;
      const model = detectProvider(active) === 'bailian' ? active : 'deepseek-v4-pro-0813';
      const baseUrl = resolveBaseUrl(config, model);
      return dashscopeResponsesSearch(query, apiKey, model, baseUrl, signal, BAILIAN_RESPONSES_TIMEOUT_MS);
    },
  },
  qwen: {
    provider: 'qwen',
    execute: async (query, apiKey, config, signal) => {
      const active = getActiveModel() ?? config.model.model;
      const { model, viaResponses } = detectProvider(active) === 'qwen'
        ? qwenSearchModel(active)
        : { model: 'qwen-plus', viaResponses: false };
      const baseUrl = resolveBaseUrl(config, model);
      if (!viaResponses) return qwenSearch(query, apiKey, model, baseUrl, signal);

      const result = await dashscopeResponsesSearch(query, apiKey, model, baseUrl, signal);
      // Responses API 延迟波动大（实测同类查询 24s–90s+），超时后回退 qwen-plus
      // Chat Completions 快速路径（实测 ~10s），保证慢响应不阻塞用户；非超时错误
      // 仍原样报错（避免掩盖 API 侧真实问题）
      if ('text' in result || !result.timeout) return result;
      const fbUrl = resolveBaseUrl(config, 'qwen-plus');
      return qwenSearch(query, apiKey, 'qwen-plus', fbUrl, signal);
    },
  },
};

/** Tavily Search API（通用 fallback） */
async function tavilySearch(query: string, apiKey: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(15000);
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: 5 }),
      signal: merged,
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { results?: Array<{ title: string; url: string; content: string }> };
    return data.results?.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content.slice(0, 200)}`
    ).join('\n\n') || null;
  } catch { return null; }
}

registerTool({
  name: 'web_search',
  description: 'Search the web for current information. Uses the active model\'s native search when available, falls back to Tavily for other providers.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query string' } },
    required: ['query'],
  },
  async execute(params, signal?) {
    const query = params.query as string;
    const config = loadConfig();
    // 优先使用 CLI 注入的实际生效模型（/model 切换后 web_search 与主循环一致），
    // 未注入（独立 core 使用）时回退配置里的 model.model
    const model = getActiveModel() ?? config.model.model;
    const provider = detectProvider(model);

    // 1. 该 provider 有原生搜索适配器且配置了 key → 原生搜索；失败报错不降级
    const adapter = NATIVE_SEARCH_ADAPTERS[provider];
    if (adapter) {
      const key = resolveApiKey(config, adapter.provider);
      if (key) {
        const result = await adapter.execute(query, key, config, signal);
        if ('text' in result) return { content: result.text };
        const label = PROVIDER_LABELS[provider] || provider;
        return { content: `${label} search error: ${result.error}`, isError: true };
      }
    }

    // 2. 通用 fallback: Tavily（key 统一解析：TAVILY_API_KEY 环境变量 > providerKeys.tavily）
    const tvKey = resolveApiKey(config, 'tavily');
    if (tvKey) {
      const result = await tavilySearch(query, tvKey, signal);
      if (result) return { content: result + '\n\n_(via Tavily)_' };
    }

    // 3. 全部失败：按实际 provider 提示（有原生适配器 → 提示其 key 环境变量；
    //    无适配器（openai/自定义）→ 说明无原生搜索，统一给 Tavily 出口）
    const label = PROVIDER_LABELS[provider] || provider;
    const nativeHint = NATIVE_SEARCH_ADAPTERS[provider]
      ? `Set ${envVarForProvider(provider)} env var to enable ${label} native search`
      : `no native search adapter for ${label} (${model})`;
    return {
      content: `Web search unavailable: ${nativeHint}; or set TAVILY_API_KEY env var (or providerKeys.tavily) to enable the Tavily fallback`,
      isError: true,
    };
  },
});
