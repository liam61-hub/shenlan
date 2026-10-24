import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimateCost,
  estimateCostDetailed,
  fallbackPriceFor,
  unpricedCatalogModels,
  getPrice,
  formatCost,
  pricesFilePath,
  loadUserPrices,
  resetPrices,
  getEffectivePrices,
  writePricesFile,
} from '../pricing.js';
import { MODEL_CATALOG } from '../model-catalog.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shenlan-pricing-'));
  process.env.SHENLAN_CONFIG_DIR = dir;
  resetPrices();
});

afterEach(() => {
  delete process.env.SHENLAN_CONFIG_DIR;
  resetPrices();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writePrices(data: unknown): void {
  writeFileSync(join(dir, 'prices.json'), JSON.stringify(data), 'utf-8');
}

describe('getPrice — 内置表（2026-08 官方当前值）', () => {
  it('deepseek-v4-flash 高峰口径', () => {
    const p = getPrice('deepseek-v4-flash');
    expect(p).toBeDefined();
    expect(p!.inputPrice).toBe(3.0);
    expect(p!.outputPrice).toBe(9.0);
    expect(p!.cacheReadPrice).toBe(0.10);
    expect(p!.offPeakInputPrice).toBe(1.5);
    expect(p!.offPeakOutputPrice).toBe(4.5);
    expect(p!.offPeakCacheReadPrice).toBe(0.05);
    expect(p!.source).toBe('builtin');
  });

  it('deepseek-v4-pro 高峰口径', () => {
    const p = getPrice('deepseek-v4-pro');
    expect(p).toBeDefined();
    expect(p!.inputPrice).toBe(9.0);
    expect(p!.outputPrice).toBe(27.0);
    expect(p!.cacheReadPrice).toBe(0.30);
    expect(p!.offPeakInputPrice).toBe(4.5);
    expect(p!.offPeakOutputPrice).toBe(13.5);
    expect(p!.offPeakCacheReadPrice).toBe(0.15);
  });

  it('qwen 内置价（首次同步前占位）', () => {
    const turbo = getPrice('qwen-turbo');
    expect(turbo).toBeDefined();
    expect(turbo!.inputPrice).toBe(0.30);
    expect(turbo!.outputPrice).toBe(0.60);
    expect(turbo!.cacheReadPrice).toBe(0);

    const plus = getPrice('qwen-plus');
    expect(plus).toBeDefined();
    expect(plus!.inputPrice).toBe(0.80);
    expect(plus!.outputPrice).toBe(2.00);

    const max = getPrice('qwen-max');
    expect(max).toBeDefined();
    expect(max!.inputPrice).toBe(2.40);
    expect(max!.outputPrice).toBe(9.60);
  });

  it('未知模型返回 undefined', () => {
    expect(getPrice('unknown-model')).toBeUndefined();
  });
});

describe('estimateCost — 内置表折算', () => {
  it('flash 1M input + 1M output = 12.0', () => {
    expect(estimateCost('deepseek-v4-flash', 1_000_000, 1_000_000)).toBeCloseTo(12.0, 5);
  });

  it('qwen-plus 折算', () => {
    expect(estimateCost('qwen-plus', 1_000_000, 1_000_000)).toBeCloseTo(2.80, 5);
  });

  it('未知模型为 0，零 token 为 0', () => {
    expect(estimateCost('unknown', 1000, 1000)).toBe(0);
    expect(estimateCost('deepseek-v4-flash', 0, 0)).toBe(0);
  });
});

describe('三级合并：manual > auto > 内置', () => {
  it('manual 完整覆盖 auto 与内置', () => {
    writePrices({
      manual: { 'deepseek-v4-flash': { inputPrice: 5, outputPrice: 6, cacheReadPrice: 0.2 } },
      auto: {
        'deepseek-v4-flash': {
          inputPrice: 2, outputPrice: 3, cacheReadPrice: 0.1,
          effectiveDate: '2026-08', source: 'test', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
    });
    const p = getPrice('deepseek-v4-flash')!;
    expect(p.inputPrice).toBe(5);
    expect(p.outputPrice).toBe(6);
    expect(p.cacheReadPrice).toBe(0.2);
    expect(p.source).toBe('manual');
    expect(p.offPeakInputPrice).toBe(1.5); // 空闲价回落 auto/内置
  });

  it('auto 覆盖内置（部分模型）', () => {
    writePrices({
      auto: {
        'deepseek-v4-flash': {
          inputPrice: 2, outputPrice: 3, cacheReadPrice: 0.1,
          effectiveDate: '2026-08', source: 'test', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
    });
    const flash = getPrice('deepseek-v4-flash')!;
    expect(flash.inputPrice).toBe(2);
    expect(flash.outputPrice).toBe(3);
    expect(flash.source).toBe('auto');
    // 未覆盖的模型仍走内置
    expect(getPrice('deepseek-v4-pro')!.source).toBe('builtin');
  });

  it('manual 部分字段覆盖：缺省字段回落 auto/内置', () => {
    writePrices({
      auto: {
        'deepseek-v4-flash': {
          inputPrice: 2, outputPrice: 3, cacheReadPrice: 0.1,
          effectiveDate: '2026-08', source: 'test', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
      manual: { 'deepseek-v4-flash': { inputPrice: 5 } },
    });
    const p = getPrice('deepseek-v4-flash')!;
    expect(p.inputPrice).toBe(5);      // manual
    expect(p.outputPrice).toBe(3);     // auto
    expect(p.cacheReadPrice).toBe(0.1); // auto
    expect(p.source).toBe('manual');
  });

  it('estimateCost 使用合并后的生效价格', () => {
    writePrices({ manual: { 'deepseek-v4-flash': { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0 } } });
    expect(estimateCost('deepseek-v4-flash', 1_000_000, 1_000_000)).toBeCloseTo(3.0, 5);
  });
});

describe('loadUserPrices — 校验与错误报告', () => {
  it('文件缺失 → 空分区无警告', () => {
    const loaded = loadUserPrices();
    expect(loaded.manual).toEqual({});
    expect(loaded.auto).toEqual({});
    expect(loaded.warnings).toEqual([]);
    expect(loaded.parseError).toBeUndefined();
  });

  it('无效条目跳过并报告，不影响有效条目', () => {
    writePrices({
      manual: {
        'bad-negative': { inputPrice: -1, outputPrice: 2, cacheReadPrice: 0 },
        'bad-string': { inputPrice: '2', outputPrice: 2, cacheReadPrice: 0 },
        'deepseek-v4-flash': { inputPrice: 5 },
      },
      auto: {
        'deepseek-v4-pro': { inputPrice: 9, outputPrice: 27, cacheReadPrice: 0.3 },
        'qwen-turbo': { inputPrice: 'x', outputPrice: 1, cacheReadPrice: 0, effectiveDate: '2026-08', source: 't', fetchedAt: 't' },
      },
    });
    const loaded = loadUserPrices();
    expect(loaded.warnings.length).toBeGreaterThanOrEqual(2);
    expect(loaded.manual['bad-negative']).toBeUndefined();
    expect(loaded.manual['bad-string']).toBeUndefined();
    expect(loaded.manual['deepseek-v4-flash']).toEqual({ inputPrice: 5 });
    expect(loaded.auto['deepseek-v4-pro']).toBeDefined();
    expect(loaded.auto['qwen-turbo']).toBeUndefined();
    // 生效表不受无效条目影响
    expect(getPrice('deepseek-v4-flash')!.inputPrice).toBe(5);
    expect(getPrice('qwen-turbo')!.inputPrice).toBe(0.30);
  });

  it('JSON 解析失败 → parseError 不静默，价格回落内置', () => {
    writeFileSync(join(dir, 'prices.json'), '{broken', 'utf-8');
    const loaded = loadUserPrices();
    expect(loaded.parseError).toContain('无法解析价格文件');
    expect(getPrice('deepseek-v4-flash')!.inputPrice).toBe(3.0);
    expect(getPrice('deepseek-v4-flash')!.source).toBe('builtin');
  });

  it('resetPrices 后重新读盘', () => {
    expect(getPrice('deepseek-v4-flash')!.inputPrice).toBe(3.0);
    writePrices({ manual: { 'deepseek-v4-flash': { inputPrice: 7 } } });
    // 未 reset 前仍用旧缓存
    expect(getPrice('deepseek-v4-flash')!.inputPrice).toBe(3.0);
    resetPrices();
    expect(getPrice('deepseek-v4-flash')!.inputPrice).toBe(7);
  });
});

describe('pricesFilePath — 目录重定向', () => {
  it('跟随 SHENLAN_CONFIG_DIR', () => {
    expect(pricesFilePath()).toBe(join(dir, 'prices.json'));
  });
});

describe('getEffectivePrices — 来源标记', () => {
  it('覆盖内置 + auto + manual，来源正确', () => {
    writePrices({
      manual: { 'deepseek-v4-flash': { inputPrice: 5 } },
      auto: {
        'deepseek-v4-pro': {
          inputPrice: 8, outputPrice: 26, cacheReadPrice: 0.3,
          effectiveDate: '2026-08', source: 'test', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
    });
    const byModel = Object.fromEntries(getEffectivePrices().map(p => [p.model, p]));
    expect(byModel['deepseek-v4-flash'].source).toBe('manual');
    expect(byModel['deepseek-v4-pro'].source).toBe('auto');
    expect(byModel['qwen-turbo'].source).toBe('builtin');
    expect(byModel['deepseek-v4-pro'].inputPrice).toBe(8);
  });
});

describe('formatCost', () => {
  it('格式化金额', () => {
    expect(formatCost(1.5)).toBe('¥1.50');
    expect(formatCost(0.005)).toBe('¥0.005000');
    expect(formatCost(0)).toBe('¥0.000000');
  });
});

describe('writePricesFile', () => {
  it('原子写入 + 读回验证，文件可被 loadUserPrices 读回', () => {
    writePricesFile({
      manual: { 'deepseek-v4-flash': { inputPrice: 5 } },
      auto: {
        'deepseek-v4-pro': {
          inputPrice: 8, outputPrice: 26, cacheReadPrice: 0.3,
          effectiveDate: '2026-08', source: 'test', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
    });
    expect(existsSync(join(dir, 'prices.json'))).toBe(true);
    const back = JSON.parse(readFileSync(join(dir, 'prices.json'), 'utf-8'));
    expect(back.manual['deepseek-v4-flash']).toEqual({ inputPrice: 5 });
    expect(back.auto['deepseek-v4-pro'].inputPrice).toBe(8);
    // 写后模块缓存已同步
    expect(getPrice('deepseek-v4-pro')!.inputPrice).toBe(8);
  });
});

// —— A2 成本漏计修复：无内置价模型的同档保守回退 ——
// 背景：14 个目录模型有 6 个无内置价，estimateCost 对它们返回 0，
// 于是会话/日账本全部记 0，¥5/¥20 成本护栏永不触发（真实花钱的 bug）。

describe('fallbackPriceFor — 同档最高价保守回退', () => {
  it('qwen3.7-flash(rc1) 回退到同档 qwen-turbo', () => {
    const fb = fallbackPriceFor('qwen3.7-flash')!;
    expect(fb.inputPrice).toBe(0.30);
    expect(fb.outputPrice).toBe(0.60);
    expect(fb.basedOn).toEqual(['qwen-turbo']);
  });

  it('qwen3.7-plus(rc2) 回退到同档 qwen-plus', () => {
    const fb = fallbackPriceFor('qwen3.7-plus')!;
    expect(fb.inputPrice).toBe(0.80);
    expect(fb.outputPrice).toBe(2.00);
    expect(fb.basedOn).toEqual(['qwen-plus']);
  });

  it('三个 rc4 qwen 模型取同档最高价 = qwen-max（而非更便宜的 qwen-vl-max）', () => {
    for (const model of ['qwen3.7-max', 'qwen3.8-max', 'qwen3.8-2.4t-a95b']) {
      const fb = fallbackPriceFor(model)!;
      expect(fb.inputPrice).toBe(2.40);   // max(qwen-max 2.40, qwen-vl-max 1.60)
      expect(fb.outputPrice).toBe(9.60);  // max(qwen-max 9.60, qwen-vl-max 4.00)
      expect(fb.basedOn).toEqual(['qwen-max', 'qwen-vl-max']);
    }
  });

  it('deepseek-v4-pro-0813(bailian, 同 provider 无有价同档) 跨 provider 取 deepseek-v4-pro', () => {
    const fb = fallbackPriceFor('deepseek-v4-pro-0813')!;
    expect(fb.inputPrice).toBe(9.0);
    expect(fb.outputPrice).toBe(27.0);
    expect(fb.basedOn).toEqual(['deepseek-v4-pro']);
  });

  it('已有生效价的模型不回退（undefined）', () => {
    expect(fallbackPriceFor('deepseek-v4-flash')).toBeUndefined();
    expect(fallbackPriceFor('qwen-max')).toBeUndefined();
  });

  it('目录外模型不猜价（undefined）—— 自定义网关我们确实一无所知', () => {
    expect(fallbackPriceFor('unknown-model')).toBeUndefined();
    expect(fallbackPriceFor('glm-4')).toBeUndefined();
  });

  it('用户 prices.json 补齐官方价后该模型不再走回退', () => {
    writePrices({
      manual: { 'qwen3.7-max': { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0 } },
    });
    expect(fallbackPriceFor('qwen3.7-max')).toBeUndefined();
    expect(estimateCostDetailed('qwen3.7-max', 1_000_000, 0).source).toBe('price');
  });
});

describe('estimateCostDetailed — 区分「真 0」与「不知道」', () => {
  it('有价模型 source=price 且与 estimateCost 完全一致', () => {
    const est = estimateCostDetailed('deepseek-v4-flash', 1_000_000, 1_000_000);
    expect(est.source).toBe('price');
    expect(est.cny).toBeCloseTo(estimateCost('deepseek-v4-flash', 1_000_000, 1_000_000), 10);
    expect(est.cny).toBeCloseTo(12.0, 5);
    expect(est.basedOn).toBeUndefined();
  });

  it('无内置价模型 source=estimated 且成本非零（本 bug 的核心回归）', () => {
    expect(estimateCost('qwen3.7-max', 1_000_000, 1_000_000)).toBe(0);
    const est = estimateCostDetailed('qwen3.7-max', 1_000_000, 1_000_000);
    expect(est.source).toBe('estimated');
    expect(est.cny).toBeCloseTo(12.0, 5); // 2.40 + 9.60
    expect(est.basedOn).toEqual(['qwen-max', 'qwen-vl-max']);
  });

  it('目录外模型 source=unknown 且记 0（不编造）', () => {
    const est = estimateCostDetailed('unknown-model', 1_000_000, 1_000_000);
    expect(est.source).toBe('unknown');
    expect(est.cny).toBe(0);
  });

  it('缓存读 token 计入回退估算', () => {
    // qwen-turbo/qwen-max 内置缓存价为 0 → 回退缓存价 0，仅验证不抛且不改主项
    const est = estimateCostDetailed('qwen3.7-flash', 1_000_000, 0, 1_000_000);
    expect(est.cny).toBeCloseTo(0.30, 5);
  });

  it('零 token 恒为 0（各来源一致）', () => {
    expect(estimateCostDetailed('deepseek-v4-flash', 0, 0).cny).toBe(0);
    expect(estimateCostDetailed('qwen3.7-max', 0, 0).cny).toBe(0);
  });
});

describe('unpricedCatalogModels — 无内置价清单（/prices 显式可见）', () => {
  it('列出当前 6 个无内置价目录模型', () => {
    expect(unpricedCatalogModels().sort()).toEqual([
      'deepseek-v4-pro-0813',
      'qwen3.7-flash',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.8-2.4t-a95b',
      'qwen3.8-max',
    ]);
  });

  it('用户补价后从清单移除', () => {
    writePrices({ manual: { 'qwen3.7-max': { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0 } } });
    expect(unpricedCatalogModels()).not.toContain('qwen3.7-max');
  });
});

describe('目录完整性：每个模型都可计费', () => {
  it('每条目录记录要么有内置价，要么能解析出非零回退', () => {
    for (const c of MODEL_CATALOG) {
      const cost = estimateCostDetailed(c.model, 1_000_000, 1_000_000);
      expect(cost.source, `${c.model} 既无内置价也无同档有价同伴 → 会被记为 ¥0，护栏失效`).not.toBe('unknown');
      expect(cost.cny, `${c.model} 折算成本为 0`).toBeGreaterThan(0);
    }
  });
});
