/**
 * /prices 与 /cost /budget 的成本可见性文案
 *
 * 重点：无内置价模型按同档估算计费这件事必须在 UI 上可见 ——
 * 否则用户会把「账面 ¥0 / 偏低」误读成免费（A2 修复的核心风险）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShenlanConfig } from '@shenlan/core';
import { resetPrices } from '@shenlan/core';
import { formatPricesReport, formatEstimatedNotice } from './prices.js';

const config = {
  model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
} as ShenlanConfig;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shenlan-prices-report-'));
  process.env.SHENLAN_CONFIG_DIR = dir;
  resetPrices();
});
afterEach(() => {
  delete process.env.SHENLAN_CONFIG_DIR;
  resetPrices();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('formatPricesReport — 无内置价段', () => {
  it('列出无内置价模型及其估算依据', () => {
    const out = formatPricesReport(config);
    expect(out).toContain('无内置价');
    expect(out).toContain('qwen3.7-max');
    // 估算依据必须写明，让"这个数从哪来"可追溯
    expect(out).toMatch(/qwen3\.7-max ~估 2\.4\/9\.6（依据 qwen-max、qwen-vl-max）/);
    expect(out).toContain('deepseek-v4-pro-0813 ~估 9/27（依据 deepseek-v4-pro）');
  });

  it('有内置价的模型不出现在无内置价段', () => {
    const out = formatPricesReport(config);
    const unpricedBlock = out.slice(out.indexOf('无内置价'));
    expect(unpricedBlock).not.toContain('deepseek-v4-flash');
    expect(unpricedBlock).not.toMatch(/^\s+qwen-turbo/m);
  });

  it('用户补齐官方价后该段消失', () => {
    writeFileSync(join(dir, 'prices.json'), JSON.stringify({
      manual: Object.fromEntries(
        ['deepseek-v4-pro-0813', 'qwen3.7-flash', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.8-2.4t-a95b']
          .map((m) => [m, { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0 }]),
      ),
    }), 'utf-8');
    resetPrices();
    expect(formatPricesReport(config)).not.toContain('无内置价');
  });
});

describe('formatEstimatedNotice — /cost /budget 估算说明行', () => {
  it('含金额、次数、模型名与补价指引', () => {
    const line = formatEstimatedNotice(12.5, 3, ['qwen3.7-max']);
    expect(line).toContain('¥12.50');
    expect(line).toContain('3 次调用');
    expect(line).toContain('qwen3.7-max');
    expect(line).toContain('/prices check');
  });

  it('模型多于 3 个时截断并加「等」', () => {
    const line = formatEstimatedNotice(1, 4, ['a', 'b', 'c', 'd']);
    expect(line).toContain('a、b、c 等');
    expect(line).not.toContain('d');
  });

  it('无模型名（仅目录外未知模型场景）也不产生空括号', () => {
    expect(formatEstimatedNotice(0, 1, [])).not.toContain('（）');
  });
});
