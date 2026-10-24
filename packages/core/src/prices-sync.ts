/**
 * 价格自动同步 — 联网核对官方价格并全自动写入 prices.json
 *
 * - qwen：百炼官方 GET /api/v1/models（结构化权威，providers=qwen&capabilities=TG&page_size=100）
 * - DeepSeek：官方定价文档页解析（单表格，含高峰/空闲两档）
 *
 * 规则：
 *   - 以官方返回为准：已有模型差异 → updated；官方有而当前无记录的新模型 → added（#9）
 *   - 有 manual 条目的模型跳过（用户手改优先）
 *   - 只有检测到差异才原子写入，写后读回验证
 *   - 网络/解析失败 → 记录原因、保留现有价格，绝不写坏配置
 */
import type { ShenlanConfig } from './config.js';
import { detectProvider, resolveApiKey } from './config.js';
import { MODEL_CATALOG } from './model-catalog.js';
import type { AutoPrice, PriceTable } from './pricing.js';
import {
  getEffectivePrices,
  loadUserPrices,
  writePricesFile,
} from './pricing.js';
import { debugLog } from './debug-logger.js';

export type SyncProvider = 'qwen' | 'deepseek';

export interface PriceSyncResult {
  /** 本次更新的价格模型 */
  updated: string[];
  /** 本次新增的模型（官方有而当前无记录，写入 auto 分区） */
  added: string[];
  /** 因 manual 条目而跳过的模型 */
  skippedManual: string[];
  /** 官方来源未找到的目录模型（ID 不一致不猜测映射） */
  notFound: string[];
  /** 某个 provider 整体失败（网络/HTTP/解析），其余 provider 不受影响 */
  failed?: { provider: SyncProvider; reason: string };
  /** updated/added 模型 → 来源标签（如 qwen official API） */
  updatedSources?: Record<string, string>;
}

export interface SyncPricesOptions {
  config?: ShenlanConfig;
  signal?: AbortSignal;
  /** 单次请求超时（默认 8s，启动同步不阻塞输入） */
  timeoutMs?: number;
}

/** 官方来源标签 */
export const PRICE_SOURCES: Record<SyncProvider, string> = {
  qwen: 'qwen official API',
  deepseek: 'deepseek official docs',
};

const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const QWEN_MODELS_URL = 'https://dashscope.aliyuncs.com/api/v1/models';
const DEFAULT_TIMEOUT_MS = 8000;

/** 官方某模型的价格信息（部分字段可缺省） */
interface OfficialModelPrices {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  offPeakInputPrice?: number;
  offPeakOutputPrice?: number;
  offPeakCacheReadPrice?: number;
  contextWindow?: number;
  effectiveDate?: string;
}

type OfficialPriceTable = Record<string, OfficialModelPrices>;

/**
 * 推导 qwen 官方 models API 地址：
 * providerBaseUrls.qwen 显式配置时归一化（去掉 /v1 或 /compatible-mode 后缀），
 * 否则用官方默认 https://dashscope.aliyuncs.com/api/v1/models。
 */
export function qwenModelsUrl(config?: ShenlanConfig): string {
  const base = config?.providerBaseUrls?.qwen;
  if (base) {
    const norm = base.replace(/\/+$/, '').replace(/\/(compatible-mode|v1)\/?$/i, '');
    if (norm) return `${norm}/api/v1/models`;
  }
  return QWEN_MODELS_URL;
}

/** 带超时（+ 可选外部 signal）的 fetch */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
  return fetch(url, { ...init, signal });
}

// ===== qwen 官方模型列表 API =====

function parseQwenModelsResponse(json: unknown): OfficialPriceTable {
  const output = (json as { output?: unknown } | null)?.output;
  const models = (output as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new Error('qwen models API: output.models missing');
  }
  const out: OfficialPriceTable = {};
  for (const m of models) {
    if (typeof m !== 'object' || m === null) continue;
    const rec = m as Record<string, unknown>;
    const id = typeof rec.model === 'string' ? rec.model : undefined;
    if (!id) continue;
    const entry: OfficialModelPrices = {};
    const ranges = Array.isArray(rec.prices) ? (rec.prices as Array<Record<string, unknown>>) : [];
    // 阶梯计费不在本次范围：优先取 Default 分段，否则取第一段
    const range = ranges.find(r => r.range_name === 'Default') ?? ranges[0];
    const items = Array.isArray(range?.prices) ? (range!.prices as Array<Record<string, unknown>>) : [];
    for (const item of items) {
      const num = typeof item.price === 'string' ? Number(item.price) : typeof item.price === 'number' ? item.price : NaN;
      if (item.type === 'input_token' && Number.isFinite(num) && num >= 0) entry.inputPrice = num;
      if (item.type === 'output_token' && Number.isFinite(num) && num >= 0) entry.outputPrice = num;
    }
    const info = (typeof rec.model_info === 'object' && rec.model_info !== null)
      ? rec.model_info as Record<string, unknown>
      : {};
    if (typeof info.context_window === 'number' && Number.isFinite(info.context_window) && info.context_window > 0) {
      entry.contextWindow = info.context_window;
    }
    out[id] = entry;
  }
  return out;
}

async function fetchQwenPrices(opts: SyncPricesOptions): Promise<OfficialPriceTable> {
  const url = qwenModelsUrl(opts.config);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.config) {
    const key = resolveApiKey(opts.config, 'qwen');
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetchWithTimeout(
    url,
    { headers, signal: opts.signal },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`qwen models API HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch (err) {
    throw new Error(`qwen models API: invalid JSON: ${(err as Error).message}`);
  }
  if (typeof json === 'object' && json !== null) {
    const code = (json as Record<string, unknown>).code;
    const message = (json as Record<string, unknown>).message;
    if (typeof code === 'string' && code !== 'OK') {
      throw new Error(`qwen models API: ${typeof message === 'string' && message ? message : code}`);
    }
  }
  return parseQwenModelsResponse(json);
}

// ===== DeepSeek 官方定价文档 =====

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 DeepSeek 官方定价页（单表格，清洗 NUL 字节后按行解析）。
 * 结构（已抓取确认）：
 *   头行：模型列标题 + 各模型 ID
 *   价格区：缓存命中 / 缓存未命中 / 输出 各两行（空闲时段 / 高峰时段）
 * rowspan 导致后续行没有标签列，用 lastLabel 继承。
 */
export function parseDeepSeekPricing(html: string): OfficialPriceTable {
  const clean = html.replace(/\0/g, '');
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const rows: string[][] = [];
  for (const tr of clean.matchAll(trRe)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(cellRe)) {
      cells.push(stripTags(td[1]));
    }
    if (cells.length > 0) rows.push(cells);
  }

  const header = rows.find(r => r.includes('模型'));
  if (!header) throw new Error('DeepSeek pricing page: model header row not found');
  const headerIdx = header.indexOf('模型');
  const models = header.slice(headerIdx + 1).filter(Boolean);
  if (models.length === 0) throw new Error('DeepSeek pricing page: no model columns found');

  const priceCell = (c: string): number | undefined => {
    const m = c.match(/^(\d+(?:\.\d+)?)\s*元$/);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const out: OfficialPriceTable = {};
  for (const model of models) out[model] = {};
  let lastLabel: 'cache' | 'input' | 'output' | null = null;

  for (const row of rows) {
    const joined = row.join(' ');
    const label: 'cache' | 'input' | 'output' | null = /缓存命中/.test(joined) ? 'cache'
      : /缓存未命中/.test(joined) ? 'input'
      : /百万tokens输出/.test(joined) ? 'output'
      : lastLabel;
    if (!label) continue;

    const priceCells = row.map(priceCell).filter((v): v is number => v !== undefined);
    if (priceCells.length !== models.length) continue;

    const offPeak = /空闲时段/.test(joined);
    if (!offPeak && !/高峰时段/.test(joined)) continue;
    if (label !== lastLabel) lastLabel = label;

    for (let i = 0; i < models.length; i++) {
      const entry = out[models[i]];
      const value = priceCells[i];
      if (offPeak) {
        if (label === 'cache') entry.offPeakCacheReadPrice = value;
        if (label === 'input') entry.offPeakInputPrice = value;
        if (label === 'output') entry.offPeakOutputPrice = value;
      } else {
        if (label === 'cache') entry.cacheReadPrice = value;
        if (label === 'input') entry.inputPrice = value;
        if (label === 'output') entry.outputPrice = value;
      }
    }
  }
  return out;
}

async function fetchDeepSeekPrices(opts: SyncPricesOptions): Promise<OfficialPriceTable> {
  const res = await fetchWithTimeout(
    DEEPSEEK_PRICING_URL,
    { headers: { Accept: 'text/html' }, signal: opts.signal },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`deepseek pricing page HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  }
  return parseDeepSeekPricing(await res.text());
}

// ===== 同步主流程 =====

/**
 * 比较当前生效价与新 auto 条目（仅比较价格字段）。
 * contextWindow 为展示用字段，不参与差异判定——只随价格变更一并写入，
 * 避免「仅上下文窗口不同」触发无意义的价格文件改写。
 */
function hasPriceDifference(current: PriceTable, entry: AutoPrice): boolean {
  if (current.inputPrice !== entry.inputPrice) return true;
  if (current.outputPrice !== entry.outputPrice) return true;
  if (current.cacheReadPrice !== entry.cacheReadPrice) return true;
  if ((current.offPeakInputPrice ?? undefined) !== (entry.offPeakInputPrice ?? undefined)) return true;
  if ((current.offPeakOutputPrice ?? undefined) !== (entry.offPeakOutputPrice ?? undefined)) return true;
  if ((current.offPeakCacheReadPrice ?? undefined) !== (entry.offPeakCacheReadPrice ?? undefined)) return true;
  return false;
}

function buildAutoEntry(
  current: PriceTable,
  official: OfficialModelPrices,
  provider: SyncProvider,
): AutoPrice {
  const entry: AutoPrice = {
    inputPrice: official.inputPrice ?? current.inputPrice,
    outputPrice: official.outputPrice ?? current.outputPrice,
    cacheReadPrice: official.cacheReadPrice ?? current.cacheReadPrice,
    effectiveDate: official.effectiveDate ?? current.effectiveDate,
    source: PRICE_SOURCES[provider],
    fetchedAt: new Date().toISOString(),
  };
  if (official.offPeakInputPrice !== undefined) entry.offPeakInputPrice = official.offPeakInputPrice;
  if (official.offPeakOutputPrice !== undefined) entry.offPeakOutputPrice = official.offPeakOutputPrice;
  if (official.offPeakCacheReadPrice !== undefined) entry.offPeakCacheReadPrice = official.offPeakCacheReadPrice;
  if (official.contextWindow !== undefined) entry.contextWindow = official.contextWindow;
  return entry;
}

/**
 * 联网同步价格（qwen / deepseek）。
 * 任一 provider 失败不影响另一个；差异才写盘；manual 分区始终保留。
 */
export async function syncPrices(
  providers: SyncProvider[],
  opts: SyncPricesOptions = {},
): Promise<PriceSyncResult> {
  const result: PriceSyncResult = {
    updated: [],
    added: [],
    skippedManual: [],
    notFound: [],
    updatedSources: {},
  };

  for (const provider of providers) {
    try {
      const official = provider === 'qwen'
        ? await fetchQwenPrices(opts)
        : await fetchDeepSeekPrices(opts);

      const effective = getEffectivePrices();
      const file = loadUserPrices();
      const nextAuto = { ...file.auto };
      let anyChange = false;

      // 官方返回归属校验：qwen 同步收 qwen + 百炼托管第三方快照；deepseek 同步只收 deepseek
      const inScope = (modelId: string): boolean => {
        const p = detectProvider(modelId);
        if (provider === 'qwen') return p === 'qwen' || p === 'bailian';
        return p === 'deepseek';
      };
      // 有效价前置：官方至少给出 input/output 价（缺价条目不写不崩）
      const hasValidPrice = (e: OfficialModelPrices): boolean =>
        typeof e.inputPrice === 'number' && Number.isFinite(e.inputPrice) && e.inputPrice >= 0 &&
        typeof e.outputPrice === 'number' && Number.isFinite(e.outputPrice) && e.outputPrice >= 0;

      // (a) 以官方返回为准：新模型新增（added）、已有模型差异更新（updated）
      for (const [modelId, officialEntry] of Object.entries(official)) {
        if (!inScope(modelId)) continue; // 无关模型（embed 等/其他厂商托管）丢弃
        if (file.manual[modelId]) {
          result.skippedManual.push(modelId);
          continue;
        }
        if (!hasValidPrice(officialEntry)) continue;
        const current = effective.find((p) => p.model === modelId);
        const base: PriceTable = current ?? {
          provider: detectProvider(modelId),
          model: modelId,
          inputPrice: 0,
          outputPrice: 0,
          cacheReadPrice: 0,
          effectiveDate: 'unknown',
          source: 'builtin',
        };
        const entry = buildAutoEntry(base, officialEntry, provider);
        if (!current) {
          nextAuto[modelId] = entry;
          anyChange = true;
          result.added.push(modelId);
          result.updatedSources![modelId] = PRICE_SOURCES[provider];
        } else if (hasPriceDifference(current, entry)) {
          nextAuto[modelId] = entry;
          anyChange = true;
          result.updated.push(modelId);
          result.updatedSources![modelId] = PRICE_SOURCES[provider];
        }
      }

      // (b) 反向校验：目录内该 scope 模型官方未找到 → notFound（ID 不一致不猜测映射）
      for (const c of MODEL_CATALOG) {
        if (!inScope(c.model)) continue;
        if (!official[c.model]) result.notFound.push(c.model);
      }

      if (anyChange) {
        // manual 分区原样保留，auto 分区整体替换为最新同步结果
        writePricesFile({ manual: file.manual, auto: nextAuto });
        debugLog('Prices sync — written', { provider, updated: result.updated, added: result.added });
      } else {
        debugLog('Prices sync — no difference', { provider, notFound: result.notFound });
      }
    } catch (err) {
      const reason = (err as Error).message;
      result.failed = { provider, reason };
      debugLog('Prices sync — failed', { provider, reason });
    }
  }
  return result;
}
