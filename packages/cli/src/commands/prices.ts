/**
 * /prices 命令 — 查看生效价格表 / 手动触发一次官方同步
 */
import type { ShenlanConfig } from '@shenlan/core';
import {
  fallbackPriceFor,
  formatCost,
  getEffectivePrices,
  loadUserPrices,
  pricesFilePath,
  syncPrices,
  unpricedCatalogModels,
} from '@shenlan/core';
import type { PriceSyncResult } from '@shenlan/core';

/** 展示生效价格表（模型、高峰/空闲、有效期、来源标记、文件路径、last sync） */
export function formatPricesReport(config: ShenlanConfig): string {
  const loaded = loadUserPrices();
  const lines: string[] = [];
  lines.push(`  prices.json: ${pricesFilePath()}`);
  if (loaded.parseError) lines.push(`  ⚠ ${loaded.parseError}`);
  for (const w of loaded.warnings) lines.push(`  ⚠ ${w}`);

  const table = getEffectivePrices();
  if (table.length === 0) {
    lines.push('  (empty)');
  }
  const fetched = table
    .map(p => p.fetchedAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);
  if (fetched) lines.push(`  last sync: ${fetched}`);

  for (const p of table) {
    const src = p.source === 'builtin' ? '内置' : p.source === 'manual' ? '手动' : '自动';
    const cache = p.cacheReadPrice > 0 ? ` · 缓存 ${p.cacheReadPrice}` : '';
    let line = `  ${p.model} [${src}] 高峰 ${p.inputPrice}/${p.outputPrice}${cache}`;
    if (p.offPeakInputPrice !== undefined && p.offPeakOutputPrice !== undefined) {
      const offCache = p.offPeakCacheReadPrice ? ` · 缓存 ${p.offPeakCacheReadPrice}` : '';
      line += ` · 空闲 ${p.offPeakInputPrice}/${p.offPeakOutputPrice}${offCache}`;
    }
    if (p.contextWindow) line += ` · 上下文 ${p.contextWindow}`;
    line += ` · ${p.effectiveDate}`;
    lines.push(line);
  }

  // 无内置价的目录模型：按同档回退估算计费，必须显式可见（否则用户以为账面 ¥0 = 免费）
  const unpriced = unpricedCatalogModels();
  if (unpriced.length > 0) {
    lines.push('  ⚠ 无内置价（按同档最高价保守估算计费，可 /prices check 同步官方价）：');
    for (const model of unpriced) {
      const fb = fallbackPriceFor(model);
      lines.push(fb
        ? `    ${model} ~估 ${fb.inputPrice}/${fb.outputPrice}（依据 ${fb.basedOn.join('、')}）`
        : `    ${model} 无法估算（同档无已定价同伴，记账为 0）`);
    }
  }
  return lines.join('\n');
}

/**
 * /cost 与 /budget 的估算说明行：账面成本含多少来自无内置价模型的同档回退估算。
 * 目的是不让用户把「账面 ¥0/偏低」误读成免费 —— 无价 ≠ 不收费。
 */
export function formatEstimatedNotice(
  estimatedCostCny: number,
  estimatedCalls: number,
  unpricedModels: string[],
): string {
  const models = unpricedModels.length > 0 ? `（${unpricedModels.slice(0, 3).join('、')}${unpricedModels.length > 3 ? ' 等' : ''}）` : '';
  return `其中 ${formatCost(estimatedCostCny)} 为估算：${estimatedCalls} 次调用的模型无内置价${models}，可 /prices check 同步官方价`;
}

/** 格式化同步结果（/prices check 与启动自动同步共用） */
export function formatSyncResult(result: PriceSyncResult): string {
  const lines: string[] = [];
  if (result.updated.length > 0) {
    const sources = new Set(result.updated.map(m => result.updatedSources?.[m]).filter(Boolean));
    const srcText = sources.size > 0 ? `（来源 ${[...sources].join('、')}）` : '';
    lines.push(`  ✔ 价格表已自动更新：${result.updated.join(', ')}${srcText}`);
  }
  if (result.added.length > 0) {
    lines.push(`  ✔ 新增价格模型：${result.added.join(', ')}`);
  }
  if (result.skippedManual.length > 0) {
    lines.push(`  ⏭ 手动条目跳过：${result.skippedManual.join(', ')}`);
  }
  if (result.notFound.length > 0) {
    lines.push(`  ⚠ 官方未找到对应模型（ID 不一致不猜测）：${result.notFound.join(', ')}`);
  }
  if (result.failed) {
    lines.push(`  ⚠ ${result.failed.provider} 同步失败：${result.failed.reason}`);
  }
  if (lines.length === 0) lines.push('  价格已是最新（与官方一致）');
  return lines.join('\n');
}

/** /prices check：手动触发一次官方同步并返回结果文本 */
export async function runPricesCheck(config: ShenlanConfig): Promise<string> {
  const result = await syncPrices(['qwen', 'deepseek'], { config });
  return formatSyncResult(result);
}
