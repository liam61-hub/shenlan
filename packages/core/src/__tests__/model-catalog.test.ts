/**
 * model-catalog — 目录助手与派生表
 */
import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG,
  catalogModel,
  catalogModelsByProvider,
  isVisionModelInCatalog,
  modelSupportsModality,
  isThinkingModel,
  getModelMaxOutputTokens,
  resolveMaxOutputTokens,
  defaultCompactModelFor,
} from '../model-catalog.js';

describe('model-catalog 目录助手', () => {
  it('模型 ID 唯一', () => {
    const ids = MODEL_CATALOG.map((c) => c.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('catalogModel / catalogModelsByProvider', () => {
    expect(catalogModel('gpt-5.4')?.provider).toBe('openai');
    expect(catalogModel('no-such-model')).toBeUndefined();
    const qwen = catalogModelsByProvider('qwen').map((c) => c.model);
    expect(qwen).toContain('qwen-turbo');
    expect(qwen).toContain('qwen-vl-max');
    expect(qwen).toHaveLength(9);
  });

  it('视觉判定：qwen-vl-max / gpt-5.4 为视觉，文本模型与目录外为 false', () => {
    expect(isVisionModelInCatalog('qwen-vl-max')).toBe(true);
    expect(isVisionModelInCatalog('gpt-5.4')).toBe(true);
    expect(isVisionModelInCatalog('gpt-5.4-mini')).toBe(false);
    expect(isVisionModelInCatalog('deepseek-v4-flash')).toBe(false);
    expect(isVisionModelInCatalog('llama-3.1-70b')).toBe(false);
    expect(modelSupportsModality('qwen-vl-max', 'image')).toBe(true);
    expect(modelSupportsModality('qwen-plus', 'image')).toBe(false);
  });
});

describe('isThinkingModel / getModelMaxOutputTokens — 思考与输出上限', () => {
  it('deepseek-v4-flash 是思考模型（实测回传 reasoning_content，曾误标 false）', () => {
    expect(isThinkingModel('deepseek-v4-flash')).toBe(true);
    expect(isThinkingModel('deepseek-v4-pro')).toBe(true);
    expect(isThinkingModel('qwen-plus')).toBe(false);
    expect(isThinkingModel('qwen-max')).toBe(true);
  });

  it('目录外按命名启发式兜底（o 系列 / reasoner / -pro / thinking）', () => {
    expect(isThinkingModel('o3-mini')).toBe(true);
    expect(isThinkingModel('deepseek-reasoner')).toBe(true);
    expect(isThinkingModel('claude-thinking')).toBe(true);
    expect(isThinkingModel('gpt-4o')).toBe(false);
    expect(isThinkingModel('qwen-turbo')).toBe(false);
  });

  it('思考模型都给了 maxOutputTokens（推理与正文共享输出预算的前提）', () => {
    const thinking = MODEL_CATALOG.filter((c) => c.thinking);
    expect(thinking.length).toBeGreaterThan(0);
    for (const c of thinking) {
      expect(getModelMaxOutputTokens(c.model), `${c.model} 缺 maxOutputTokens`).toBeGreaterThan(8192);
    }
  });

  it('目录外模型无上限信息（回退调用方配置，不冒险放大）', () => {
    expect(getModelMaxOutputTokens('no-such-model')).toBeUndefined();
  });
});

describe('resolveMaxOutputTokens — 输出预算解析（思考模型根治）', () => {
  it('思考模型：配置 8192 → 抬到思考下限 16384（≤ 目录 cap）', () => {
    expect(resolveMaxOutputTokens('deepseek-v4-flash', { configured: 8192 })).toBe(16384);
  });

  it('非思考模型：保持配置值（不无谓放大）', () => {
    expect(resolveMaxOutputTokens('qwen-plus', { configured: 8192, thinkingFloor: 16384 })).toBe(8192);
  });

  it('截断升级：escalateTo 抬升，但被目录 cap 封顶', () => {
    expect(resolveMaxOutputTokens('deepseek-v4-flash', { configured: 8192, escalateTo: 20000 })).toBe(20000);
    expect(resolveMaxOutputTokens('deepseek-v4-flash', { configured: 8192, escalateTo: 999_999 })).toBe(32_768);
  });

  it('结果绝不低于用户配置值（目录 cap 更小时也守住）', () => {
    // 目录外模型 cap 缺省 = configured，放大被压回
    expect(resolveMaxOutputTokens('no-such-model', { configured: 8192, escalateTo: 64000 })).toBe(8192);
  });

  it('capOverride 优先于目录值', () => {
    expect(resolveMaxOutputTokens('deepseek-v4-flash', { configured: 8192, capOverride: 8192, thinkingFloor: 16384 })).toBe(8192);
  });
});

describe('defaultCompactModelFor — 压缩默认模型映射（#13）', () => {
  it('各内置 provider 映射', () => {
    expect(defaultCompactModelFor('deepseek')).toBe('deepseek-v4-flash');
    expect(defaultCompactModelFor('qwen')).toBe('qwen-plus');
    expect(defaultCompactModelFor('openai')).toBe('gpt-5.4-mini');
    expect(defaultCompactModelFor('bailian')).toBe('deepseek-v4-pro-0813');
  });

  it('未登记 provider 返回 null（调用方兜底主模型本身）', () => {
    expect(defaultCompactModelFor('claude')).toBeNull();
    expect(defaultCompactModelFor('unknown')).toBeNull();
  });
});

describe('外币计价条目：CNY 值必须等于 source × fxRate（A2.5）', () => {
  it('每条带 sourceCurrency 的记录算术自洽', () => {
    const foreign = MODEL_CATALOG.filter((c) => c.price?.sourceCurrency);
    expect(foreign.length).toBeGreaterThan(0); // OpenAI 两条；为 0 说明字段被误删
    for (const c of foreign) {
      const p = c.price!;
      expect(p.fxRate, `${c.model} 缺 fxRate`).toBeGreaterThan(0);
      expect(typeof p.sourceInputPrice, `${c.model} 缺 sourceInputPrice`).toBe('number');
      expect(typeof p.sourceOutputPrice, `${c.model} 缺 sourceOutputPrice`).toBe('number');
      const round2 = (n: number): number => Math.round(n * 100) / 100;
      expect(p.inputPrice, `${c.model} inputPrice 与美元原价不符`).toBe(round2(p.sourceInputPrice! * p.fxRate!));
      expect(p.outputPrice, `${c.model} outputPrice 与美元原价不符`).toBe(round2(p.sourceOutputPrice! * p.fxRate!));
    }
  });

  it('OpenAI 两条按 $1 = ¥7.2 折算', () => {
    for (const model of ['gpt-5.4', 'gpt-5.4-mini']) {
      const p = catalogModel(model)!.price!;
      expect(p.sourceCurrency).toBe('USD');
      expect(p.fxRate).toBe(7.2);
    }
  });
});
