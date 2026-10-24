/**
 * 模型能力目录 — 全仓唯一事实源（#8）
 *
 * router 路由能力、内置价格、向导/面板模型列表、README 模型表全部由此派生：
 *  - capabilities: provider/modalities/contextWindow/supportsTools/thinking/tier/relativeCost
 *  - price: 内置价（CNY/1M；缺省 = 无内置价，待 prices-sync 由官方接口补）
 *
 * 新增模型 = 只加一条目录记录（pricing/wizard/README 自动跟随）。
 */

/** 内置价（CNY / 1M tokens；OpenAI 官方按美元计价，见 sourceCurrency/fxRate 字段） */
export interface CatalogPrice {
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  /** 空闲时段单价（DeepSeek 官方文档提供） */
  offPeakInputPrice?: number;
  offPeakOutputPrice?: number;
  offPeakCacheReadPrice?: number;
  /** 价格生效期（YYYY-MM） */
  effectiveDate: string;
  /**
   * 原始计价币种（非 CNY 的厂商填写）。填了则 inputPrice/outputPrice 必须等于
   * source*Price × fxRate（四舍五入到分），由 model-catalog.test.ts 断言 ——
   * 让「$1≈¥7.2」这个假设从注释变成可 grep、有测试兜着的字段。
   */
  sourceCurrency?: 'USD';
  sourceInputPrice?: number;
  sourceOutputPrice?: number;
  /** 折算汇率（source 币种 → CNY） */
  fxRate?: number;
}

export interface CatalogModel {
  /** 规范 provider id（deepseek/qwen/bailian/openai 等） */
  provider: string;
  /** API 模型 ID（唯一键） */
  model: string;
  /** 能力模态：text | image */
  modalities: string[];
  contextWindow: number;
  supportsTools: boolean;
  /** 思考/推理模型标记（路由与 UI 标签用，请求体不传 thinking 参数） */
  thinking: boolean;
  /**
   * 单次响应硬输出上限（token）。思考模型的推理与正文**共享**该额度，
   * 所以「上限够大」是长任务不被思考饿死正文的前提。
   * 缺省 = 无目录值（调用方回退到 config.model.maxTokens，不冒险放大以免 400）。
   */
  maxOutputTokens?: number;
  /** 能力档位：1=flash/turbo 档 … 4=max 档 */
  tier: number;
  /** 相对成本（无生效价格时的路由回退；1=最便宜） */
  relativeCost: number;
  /** 内置价（可缺省 → 无内置价，回退 relativeCost，待 sync 校正） */
  price?: CatalogPrice;
}

export const MODEL_CATALOG: CatalogModel[] = [
  {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    modalities: ['text'],
    contextWindow: 1_000_000,
    supportsTools: true,
    // 实测该端点会回传 delta.reasoning_content（思考流），且推理与正文共享 max_tokens。
    // 曾误标 false，导致空回复兜底把空 content 归因为“模型空回”（见 .shenlan 调试日志）。
    thinking: true,
    maxOutputTokens: 32_768,
    tier: 1,
    relativeCost: 1,
    price: {
      inputPrice: 3.0,        // ¥3.0/1M input（高峰）
      outputPrice: 9.0,       // ¥9.0/1M output（高峰）
      cacheReadPrice: 0.10,   // ¥0.10/1M cache read（高峰）
      offPeakInputPrice: 1.5,
      offPeakOutputPrice: 4.5,
      offPeakCacheReadPrice: 0.05,
      effectiveDate: '2026-08',
    },
  },
  {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    modalities: ['text'],
    contextWindow: 1_000_000,
    supportsTools: true,
    thinking: true,
    maxOutputTokens: 32_768,
    tier: 3,
    relativeCost: 3,
    price: {
      inputPrice: 9.0,        // ¥9.0/1M input（高峰）
      outputPrice: 27.0,      // ¥27.0/1M output（高峰）
      cacheReadPrice: 0.30,   // ¥0.30/1M cache read（高峰）
      offPeakInputPrice: 4.5,
      offPeakOutputPrice: 13.5,
      offPeakCacheReadPrice: 0.15,
      effectiveDate: '2026-08',
    },
  },
  {
    // 百炼托管的 deepseek 快照（仅存在于百炼端点，走百炼 key；官方端点 400）
    provider: 'bailian',
    model: 'deepseek-v4-pro-0813',
    modalities: ['text'],
    contextWindow: 1_000_000,
    supportsTools: true,
    thinking: true,
    maxOutputTokens: 32_768,
    tier: 3,
    relativeCost: 3,
  },
  {
    provider: 'qwen',
    model: 'qwen-turbo',
    modalities: ['text'],
    contextWindow: 1_000_000,
    supportsTools: true,
    thinking: false,
    tier: 1,
    relativeCost: 1,
    price: {
      inputPrice: 0.30,       // ¥0.30/1M input（百炼华北2 原价）
      outputPrice: 0.60,      // ¥0.60/1M output
      cacheReadPrice: 0,      // 官方原价未含缓存价，同步后按接口返回校正
      effectiveDate: '2026-08',
    },
  },
  {
    provider: 'qwen',
    model: 'qwen-plus',
    modalities: ['text'],
    contextWindow: 128_000,
    supportsTools: true,
    thinking: false,
    tier: 2,
    relativeCost: 2,
    price: {
      inputPrice: 0.80,       // ¥0.80/1M input（百炼华北2 原价）
      outputPrice: 2.00,      // ¥2.00/1M output
      cacheReadPrice: 0,
      effectiveDate: '2026-08',
    },
  },
  {
    provider: 'qwen',
    model: 'qwen-max',
    modalities: ['text'],
    contextWindow: 128_000,
    supportsTools: true,
    thinking: true,
    maxOutputTokens: 32_768,
    tier: 4,
    relativeCost: 4,
    price: {
      inputPrice: 2.40,       // ¥2.40/1M input（百炼华北2 原价）
      outputPrice: 9.60,      // ¥9.60/1M output
      cacheReadPrice: 0,
      effectiveDate: '2026-08',
    },
  },
  {
    provider: 'qwen',
    model: 'qwen3.7-flash',
    modalities: ['text'],
    contextWindow: 1_000_000,
    supportsTools: true,
    thinking: false,
    tier: 1,
    relativeCost: 1,
  },
  {
    provider: 'qwen',
    model: 'qwen3.7-plus',
    modalities: ['text'],
    contextWindow: 128_000,
    supportsTools: true,
    thinking: false,
    tier: 2,
    relativeCost: 2,
  },
  {
    provider: 'qwen',
    model: 'qwen3.7-max',
    modalities: ['text'],
    contextWindow: 128_000,
    supportsTools: true,
    thinking: true,
    maxOutputTokens: 32_768,
    tier: 4,
    relativeCost: 4,
  },
  {
    provider: 'qwen',
    model: 'qwen3.8-max',
    modalities: ['text'],
    contextWindow: 128_000,
    supportsTools: true,
    thinking: true,
    maxOutputTokens: 32_768,
    tier: 4,
    relativeCost: 4,
  },
  {
    provider: 'qwen',
    model: 'qwen3.8-2.4t-a95b',
    modalities: ['text'],
    contextWindow: 128_000,
    supportsTools: true,
    thinking: true,
    maxOutputTokens: 32_768,
    tier: 4,
    relativeCost: 4,
  },
  {
    // 视觉模型（qwen-vl）：图片直传；上下文按阿里云官方模型列表 131072（最大输入 129024）
    // 核对于 2026-09：32k 是 2024 快照 qwen-vl-max-0809 的历史值
    provider: 'qwen',
    model: 'qwen-vl-max',
    modalities: ['text', 'image'],
    contextWindow: 131_072,
    supportsTools: true,
    thinking: false,
    tier: 4,
    relativeCost: 4,
    price: {
      inputPrice: 1.6,        // ¥1.6/1M input（华北2 原价占位，首次 sync 由官方接口校正）
      outputPrice: 4.0,       // ¥4.0/1M output
      cacheReadPrice: 0.32,   // 缓存命中
      effectiveDate: '2026-09',
    },
  },
  {
    // OpenAI 官方（官方按美元计价，$1≈¥7.2 折算以便跨厂 cost-first 同单位比较；
    // gpt-4o 已 legacy，2026 主线为 gpt-5.x）
    provider: 'openai',
    model: 'gpt-5.4',
    modalities: ['text', 'image'],
    contextWindow: 400_000,
    supportsTools: true,
    thinking: true,
    maxOutputTokens: 128_000,
    tier: 3,
    relativeCost: 4,
    price: {
      inputPrice: 18.0,       // $2.50/1M input
      outputPrice: 108.0,     // $15/1M output
      cacheReadPrice: 0,
      effectiveDate: '2026-09',
      sourceCurrency: 'USD',
      sourceInputPrice: 2.50,
      sourceOutputPrice: 15.0,
      fxRate: 7.2,
    },
  },
  {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    modalities: ['text'],
    contextWindow: 400_000,
    supportsTools: true,
    thinking: false,
    tier: 1,
    relativeCost: 2,
    price: {
      inputPrice: 5.40,       // $0.75/1M input
      outputPrice: 32.40,     // $4.50/1M output
      cacheReadPrice: 0,
      effectiveDate: '2026-09',
      sourceCurrency: 'USD',
      sourceInputPrice: 0.75,
      sourceOutputPrice: 4.50,
      fxRate: 7.2,
    },
  },
];

/** 按模型 ID 查目录 */
export function catalogModel(model: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((c) => c.model === model);
}

/** 按 provider 查目录模型（目录序） */
export function catalogModelsByProvider(provider: string): CatalogModel[] {
  return MODEL_CATALOG.filter((c) => c.provider === provider);
}

/** 目录内视觉模型判定（modalities 含 image；目录外 false） */
export function isVisionModelInCatalog(model: string): boolean {
  return MODEL_CATALOG.some((c) => c.model === model && c.modalities.includes('image'));
}

/** 目录内模型能力判定 */
export function modelSupportsModality(model: string, modality: 'text' | 'image'): boolean {
  const c = catalogModel(model);
  return c ? c.modalities.includes(modality) : false;
}

/**
 * 是否思考/推理模型：目录标记为准；目录外按命名启发式兜底
 * （deepseek-*-pro / o1-o4 / *-thinking / reasoner 等 —— 避免未登记模型被当成非思考模型）。
 */
export function isThinkingModel(model: string): boolean {
  const c = catalogModel(model);
  if (c) return c.thinking;
  return /(^o[1-9](\b|-)|reason|thinking|deepseek-v?\d*.*-pro)/i.test(model);
}

/**
 * 模型硬输出上限（token）：目录值优先；目录外返回 undefined，
 * 调用方回退到 config.model.maxTokens（不冒险放大以免端点 400）。
 */
export function getModelMaxOutputTokens(model: string): number | undefined {
  return catalogModel(model)?.maxOutputTokens;
}

/** 思考模型输出预算默认下限：足够「推理 + 正文」共存 */
export const DEFAULT_THINKING_OUTPUT_FLOOR = 16_384;

export interface OutputBudgetOptions {
  /** 用户配置的期望输出（model.maxTokens） */
  configured: number;
  /** 显式硬上限（model.maxOutputTokens），优先于模型目录值 */
  capOverride?: number;
  /** 思考模型输出预算下限（context.thinkingOutputFloor） */
  thinkingFloor?: number;
  /** 额外抬升值（截断升级），取三者最大 */
  escalateTo?: number;
}

/**
 * 解析单次请求应发送的 max_tokens —— 根治「思考吃光输出预算 → 正文为空」。
 *
 * 思考模型的推理与正文**共享**输出额度，因此：
 *   desired = max(configured, 思考下限, 截断升级值)
 *   cap     = max(capOverride ?? 目录 maxOutputTokens ?? configured, configured)
 *   effective = min(desired, cap)   —— 且绝不低于用户配置的 configured
 *
 * 目录外模型无 cap 信息 → cap=configured（不冒险放大，避免端点 400）。
 */
export function resolveMaxOutputTokens(model: string, opts: OutputBudgetOptions): number {
  const configured =
    Number.isFinite(opts.configured) && opts.configured > 0 ? Math.floor(opts.configured) : 8192;
  const cap = Math.max(opts.capOverride ?? getModelMaxOutputTokens(model) ?? configured, configured);
  const floor = isThinkingModel(model) ? (opts.thinkingFloor ?? DEFAULT_THINKING_OUTPUT_FLOOR) : 0;
  const desired = Math.max(configured, floor, opts.escalateTo ?? 0);
  return Math.min(desired, cap);
}

/**
 * 压缩摘要默认模型映射（compactModel 空时按主模型 provider 选取）：
 * 未登记 provider 返回 null（调用方兜底主模型本身，绝不跨 provider 送历史）。
 */
export function defaultCompactModelFor(provider: string): string | null {
  const map: Record<string, string> = {
    deepseek: 'deepseek-v4-flash',
    qwen: 'qwen-plus',
    openai: 'gpt-5.4-mini',
    bailian: 'deepseek-v4-pro-0813',
  };
  return map[provider] ?? null;
}
