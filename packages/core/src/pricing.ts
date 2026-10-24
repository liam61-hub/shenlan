/**
 * 价格表 — 按 provider 单价，用于成本估算与自动同步
 *
 * 价格单位: CNY / 1M tokens
 * 生效优先级：manual（用户手改）> auto（自动同步）> 内置表
 * 持久化：~/.shenlan/prices.json（SHENLAN_CONFIG_DIR 可重定向，供测试隔离）
 *
 * 分区：
 *   manual — 用户手改，优先级最高，自动同步跳过；支持部分字段覆盖
 *   auto   — 自动同步写入（qwen 官方 API / DeepSeek 官方文档），带来源与抓取时间
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectProvider } from './config.js';
import { MODEL_CATALOG, catalogModel, type CatalogModel } from './model-catalog.js';

/** 用户手动覆盖（部分字段可缺省：缺省字段回落 auto/内置） */
export interface ManualPrice {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
}

/** 自动同步价格（机器写入，基础三字段齐全） */
export interface AutoPrice {
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  /** 空闲时段单价（DeepSeek 官方文档提供；qwen API 暂无） */
  offPeakInputPrice?: number;
  offPeakOutputPrice?: number;
  offPeakCacheReadPrice?: number;
  /** 展示用：qwen list-models 返回的上下文窗口 */
  contextWindow?: number;
  /** 官方价格生效期（YYYY-MM） */
  effectiveDate: string;
  /** 来源描述（qwen official API / deepseek official docs） */
  source: string;
  /** 抓取时间 ISO */
  fetchedAt: string;
}

/** prices.json 结构：manual 与 auto 两个分区 */
export interface PriceFile {
  manual: Record<string, ManualPrice>;
  auto: Record<string, AutoPrice>;
}

/** 生效价格条目（合并后，带来源标记） */
export interface PriceTable {
  provider: string;
  model: string;
  inputPrice: number;      // CNY per 1M input tokens
  outputPrice: number;     // CNY per 1M output tokens
  cacheReadPrice: number;  // CNY per 1M cache read tokens
  effectiveDate: string;
  source: 'builtin' | 'manual' | 'auto';
  offPeakInputPrice?: number;
  offPeakOutputPrice?: number;
  offPeakCacheReadPrice?: number;
  contextWindow?: number;
  fetchedAt?: string;
}

/** 价格文件加载结果（解析/校验问题不静默） */
export interface LoadedPrices {
  manual: Record<string, ManualPrice>;
  auto: Record<string, AutoPrice>;
  /** JSON 解析失败原因（此时 manual/auto 为空，生效价格回落内置） */
  parseError?: string;
  /** 无效条目等警告 */
  warnings: string[];
}

/**
 * 内置价格表 — 由 MODEL_CATALOG 的 price 字段派生（#8 单一事实源）：
 * DeepSeek 为官方当前值（高峰：flash 3.0/9.0、缓存命中 0.10；pro 9.0/27.0、缓存命中 0.30；
 * 空闲半价存 offPeak 字段）；qwen 内置价为占位，首次成功同步后由官方接口自动校正。
 */
function builtinPriceTable(): PriceTable[] {
  return MODEL_CATALOG
    .filter((c) => c.price)
    .map((c) => ({
      provider: c.provider,
      model: c.model,
      inputPrice: c.price!.inputPrice,
      outputPrice: c.price!.outputPrice,
      cacheReadPrice: c.price!.cacheReadPrice,
      offPeakInputPrice: c.price!.offPeakInputPrice,
      offPeakOutputPrice: c.price!.offPeakOutputPrice,
      offPeakCacheReadPrice: c.price!.offPeakCacheReadPrice,
      effectiveDate: c.price!.effectiveDate,
      source: 'builtin' as const,
    }));
}

/** 模块级价格文件缓存（loadUserPrices 刷新） */
let loaded: LoadedPrices | null = null;

/** 价格文件路径（SHENLAN_CONFIG_DIR 可重定向） */
export function pricesFilePath(): string {
  return join(process.env.SHENLAN_CONFIG_DIR || join(homedir(), '.shenlan'), 'prices.json');
}

/** 数值须 ≥0 且有限 */
function isValidPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isValidPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 校验一个 manual 条目：定义过的数值字段必须 ≥0 有限数；
 * 任一字段非法 → 整个条目无效（跳过并报告）。
 */
function sanitizeManual(raw: unknown): ManualPrice | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: ManualPrice = {};
  for (const field of ['inputPrice', 'outputPrice', 'cacheReadPrice'] as const) {
    if (o[field] === undefined) continue;
    if (!isValidPrice(o[field])) return null;
    out[field] = o[field];
  }
  return out;
}

/** 校验一个 auto 条目：基础三字段必须齐全合法；可选字段非法 → 条目无效 */
function sanitizeAuto(raw: unknown): AutoPrice | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isValidPrice(o.inputPrice) || !isValidPrice(o.outputPrice) || !isValidPrice(o.cacheReadPrice)) {
    return null;
  }
  const out: AutoPrice = {
    inputPrice: o.inputPrice,
    outputPrice: o.outputPrice,
    cacheReadPrice: o.cacheReadPrice,
    effectiveDate: typeof o.effectiveDate === 'string' ? o.effectiveDate : 'unknown',
    source: typeof o.source === 'string' ? o.source : 'auto',
    fetchedAt: typeof o.fetchedAt === 'string' ? o.fetchedAt : '',
  };
  for (const field of ['offPeakInputPrice', 'offPeakOutputPrice', 'offPeakCacheReadPrice'] as const) {
    if (o[field] === undefined) continue;
    if (!isValidPrice(o[field])) return null;
    out[field] = o[field];
  }
  if (o.contextWindow !== undefined) {
    if (!isValidPositiveInt(o.contextWindow)) return null;
    out.contextWindow = o.contextWindow;
  }
  return out;
}

/**
 * 加载本地价格文件（重新读盘，替换模块缓存）。
 * 文件缺失 → 空分区；解析失败 → parseError（不静默，生效价格回落内置）；
 * 无效条目逐个跳过并记入 warnings。
 */
export function loadUserPrices(): LoadedPrices {
  const file = pricesFilePath();
  if (!existsSync(file)) {
    loaded = { manual: {}, auto: {}, warnings: [] };
    return loaded;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    const msg = `无法解析价格文件 ${file}: ${(err as Error).message}（已忽略，使用内置价格）`;
    loaded = { manual: {}, auto: {}, parseError: msg, warnings: [msg] };
    return loaded;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const msg = `价格文件 ${file} 结构无效（已忽略，使用内置价格）`;
    loaded = { manual: {}, auto: {}, parseError: msg, warnings: [msg] };
    return loaded;
  }

  const warnings: string[] = [];
  const manual: Record<string, ManualPrice> = {};
  const auto: Record<string, AutoPrice> = {};
  const rawManual = (raw as Record<string, unknown>).manual;
  const rawAuto = (raw as Record<string, unknown>).auto;

  if (rawManual !== undefined) {
    if (typeof rawManual !== 'object' || rawManual === null || Array.isArray(rawManual)) {
      warnings.push(`价格文件 ${file} manual 分区结构无效，已忽略`);
    } else {
      for (const [model, entry] of Object.entries(rawManual as Record<string, unknown>)) {
        const cleaned = sanitizeManual(entry);
        if (cleaned === null) {
          warnings.push(`价格文件 manual 条目 ${model} 无效，已跳过`);
        } else {
          manual[model] = cleaned;
        }
      }
    }
  }

  if (rawAuto !== undefined) {
    if (typeof rawAuto !== 'object' || rawAuto === null || Array.isArray(rawAuto)) {
      warnings.push(`价格文件 ${file} auto 分区结构无效，已忽略`);
    } else {
      for (const [model, entry] of Object.entries(rawAuto as Record<string, unknown>)) {
        const cleaned = sanitizeAuto(entry);
        if (cleaned === null) {
          warnings.push(`价格文件 auto 条目 ${model} 无效，已跳过`);
        } else {
          auto[model] = cleaned;
        }
      }
    }
  }

  loaded = { manual, auto, warnings };
  return loaded;
}

/** 清空价格文件缓存（测试隔离 / 强制重读用） */
export function resetPrices(): void {
  loaded = null;
}

/** 从模型名推断 provider（未知模型标 unknown） */
function providerFor(model: string): string {
  const p = detectProvider(model);
  return p === 'unknown' ? 'unknown' : p;
}

/** 获取生效价格表：内置 + auto + manual 三级合并（manual 最高） */
export function getEffectivePrices(): PriceTable[] {
  if (!loaded) loadUserPrices();
  const file = loaded!;
  const byModel = new Map<string, PriceTable>();

  for (const p of builtinPriceTable()) {
    byModel.set(p.model, { ...p });
  }

  for (const [model, auto] of Object.entries(file.auto)) {
    const base = byModel.get(model) ?? {
      provider: providerFor(model),
      model,
      inputPrice: 0,
      outputPrice: 0,
      cacheReadPrice: 0,
      effectiveDate: auto.effectiveDate,
      source: 'builtin' as const,
    };
    byModel.set(model, {
      provider: base.provider,
      model,
      inputPrice: auto.inputPrice,
      outputPrice: auto.outputPrice,
      cacheReadPrice: auto.cacheReadPrice,
      effectiveDate: auto.effectiveDate || base.effectiveDate,
      source: 'auto',
      offPeakInputPrice: auto.offPeakInputPrice ?? base.offPeakInputPrice,
      offPeakOutputPrice: auto.offPeakOutputPrice ?? base.offPeakOutputPrice,
      offPeakCacheReadPrice: auto.offPeakCacheReadPrice ?? base.offPeakCacheReadPrice,
      contextWindow: auto.contextWindow ?? base.contextWindow,
      fetchedAt: auto.fetchedAt || base.fetchedAt,
    });
  }

  for (const [model, manual] of Object.entries(file.manual)) {
    const base = byModel.get(model) ?? {
      provider: providerFor(model),
      model,
      inputPrice: 0,
      outputPrice: 0,
      cacheReadPrice: 0,
      effectiveDate: 'unknown',
      source: 'builtin' as const,
    };
    byModel.set(model, {
      provider: base.provider,
      model,
      inputPrice: manual.inputPrice ?? base.inputPrice,
      outputPrice: manual.outputPrice ?? base.outputPrice,
      cacheReadPrice: manual.cacheReadPrice ?? base.cacheReadPrice,
      effectiveDate: base.effectiveDate,
      source: 'manual',
      offPeakInputPrice: base.offPeakInputPrice,
      offPeakOutputPrice: base.offPeakOutputPrice,
      offPeakCacheReadPrice: base.offPeakCacheReadPrice,
      contextWindow: base.contextWindow,
      fetchedAt: base.fetchedAt,
    });
  }

  return [...byModel.values()];
}

/** 检查价格表是否过期（超过 90 天未更新；合并表内最新有效期为准） */
export function isPriceTableExpired(): boolean {
  const latest = getEffectivePrices()
    .map(p => p.effectiveDate)
    .filter(d => d && d !== 'unknown')
    .reduce((max, d) => d > max ? d : max, '');
  if (!latest) return true;
  const priceDate = new Date(latest);
  if (Number.isNaN(priceDate.getTime())) return false;
  const now = new Date();
  const daysDiff = (now.getTime() - priceDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysDiff > 90;
}

/** 获取模型生效价格（manual > auto > 内置） */
export function getPrice(model: string): PriceTable | undefined {
  return getEffectivePrices().find(p => p.model === model);
}

/** 估算单次调用成本（CNY）。无生效价的模型返回 0 —— 需要区分「真 0」与「不知道」时用 estimateCostDetailed */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number = 0,
): number {
  const price = getPrice(model);
  if (!price) return 0;

  return (
    (promptTokens / 1_000_000) * price.inputPrice +
    (completionTokens / 1_000_000) * price.outputPrice +
    (cacheReadTokens / 1_000_000) * price.cacheReadPrice
  );
}

/** 成本数据来源：price=生效价格表 / estimated=同档回退估算 / unknown=目录外未知模型 */
export type CostSource = 'price' | 'estimated' | 'unknown';

/** 带来源标记的成本估算结果 */
export interface CostEstimate {
  cny: number;
  source: CostSource;
  /** source='estimated' 时的估算依据模型（供 UI 解释「这个数是怎么来的」） */
  basedOn?: string[];
}

/** 回退单价（无内置价模型的保守估算依据） */
export interface FallbackPrice {
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  /** 取价参考的模型（同档已定价同伴） */
  basedOn: string[];
}

/**
 * 无生效价模型的保守回退单价：
 * 取**同 relativeCost 档位**内已定价模型的最高输入/输出/缓存单价，同 provider 优先
 * （无同 provider 同档同伴时跨 provider 取）。
 *
 * 为什么按档取而不是按 provider 取最高：同 provider 跨档取最高会把 flash 档按 max 档计价
 * （qwen3.7-flash 会被按 qwen-max 算，约 8 倍高估），护栏将荒谬地提前触发。
 * 同档取最高既保守又不串味，且每个数字都追溯到目录里已核实的条目，不编造价格。
 *
 * 返回 undefined = 无法估算（目录外模型 / 已有生效价 / 同档无任何已定价同伴）。
 */
export function fallbackPriceFor(model: string): FallbackPrice | undefined {
  const target = catalogModel(model);
  // 目录外模型（自定义网关）：我们确实一无所知，不猜
  if (!target) return undefined;
  const effective = new Map(getEffectivePrices().map((p) => [p.model, p]));
  if (effective.has(model)) return undefined;

  const priced = MODEL_CATALOG
    .filter((c) => c.model !== model && c.relativeCost === target.relativeCost)
    .map((c) => ({ c, p: effective.get(c.model) }))
    .filter((x): x is { c: CatalogModel; p: PriceTable } => x.p !== undefined);
  const sameProvider = priced.filter((x) => x.c.provider === target.provider);
  const pool = sameProvider.length > 0 ? sameProvider : priced;
  if (pool.length === 0) return undefined;

  return {
    inputPrice: Math.max(...pool.map((x) => x.p.inputPrice)),
    outputPrice: Math.max(...pool.map((x) => x.p.outputPrice)),
    cacheReadPrice: Math.max(...pool.map((x) => x.p.cacheReadPrice)),
    basedOn: pool.map((x) => x.c.model).sort(),
  };
}

/**
 * 估算单次调用成本并标记来源。
 * 生效价格表命中 → source='price'（与 estimateCost 完全一致）；
 * 目录内但无生效价 → source='estimated'（同档回退单价，见 fallbackPriceFor）；
 * 目录外未知模型 → source='unknown' 且 cny=0。
 *
 * 存在的理由：estimateCost 把「无价」和「零成本」混为一谈，导致无价模型
 * 记账恒为 ¥0、成本护栏永不触发（真实花钱但账面不动）。
 */
export function estimateCostDetailed(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number = 0,
): CostEstimate {
  const calc = (input: number, output: number, cacheRead: number): number =>
    (promptTokens / 1_000_000) * input +
    (completionTokens / 1_000_000) * output +
    (cacheReadTokens / 1_000_000) * cacheRead;

  const price = getPrice(model);
  if (price) {
    return { cny: calc(price.inputPrice, price.outputPrice, price.cacheReadPrice), source: 'price' };
  }
  const fb = fallbackPriceFor(model);
  if (fb) {
    return {
      cny: calc(fb.inputPrice, fb.outputPrice, fb.cacheReadPrice),
      source: 'estimated',
      basedOn: fb.basedOn,
    };
  }
  return { cny: 0, source: 'unknown' };
}

/** 目录内无生效价的模型（按同档回退估算计费，/prices 显式列出） */
export function unpricedCatalogModels(): string[] {
  const effective = new Set(getEffectivePrices().map((p) => p.model));
  return MODEL_CATALOG.filter((c) => !effective.has(c.model)).map((c) => c.model);
}

/** 格式化金额 */
export function formatCost(cny: number): string {
  if (cny >= 1) return `¥${cny.toFixed(2)}`;
  if (cny >= 0.01) return `¥${cny.toFixed(4)}`;
  return `¥${cny.toFixed(6)}`;
}

/**
 * 原子写价格文件：先写临时文件 → 读回校验 → rename 覆盖。
 * 读回失败时清理临时文件并抛错，绝不留下损坏的正式文件。
 * 写成功后同步刷新模块缓存。
 */
export function writePricesFile(data: PriceFile): void {
  const file = pricesFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const serialized = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(tmp, serialized, 'utf-8');
  try {
    const back = JSON.parse(readFileSync(tmp, 'utf-8')) as Partial<PriceFile>;
    if (
      typeof back !== 'object' || back === null ||
      typeof back.manual !== 'object' || back.manual === null ||
      typeof back.auto !== 'object' || back.auto === null
    ) {
      throw new Error('read-back verification failed: prices.json structure invalid');
    }
    if (
      JSON.stringify(back.manual) !== JSON.stringify(data.manual) ||
      JSON.stringify(back.auto) !== JSON.stringify(data.auto)
    ) {
      throw new Error('read-back verification failed: content mismatch');
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw err;
  }
  renameSync(tmp, file);
  loaded = { manual: { ...data.manual }, auto: { ...data.auto }, warnings: [] };
}
