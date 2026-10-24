import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordUsage,
  getSessionCost,
  getDailyCost,
  resetSessionCost,
  checkCostGuardrail,
  waiveSession,
  waiveDay,
  isDayWaived,
  costLedgerPath,
} from '../cost-tracker.js';
import { resetPrices } from '../pricing.js';

let dir: string;

beforeEach(() => {
  resetSessionCost();
  // 账本重定向到临时目录，避免污染真实 ~/.shenlan/cost-ledger.json
  dir = mkdtempSync(join(tmpdir(), 'shenlan-cost-'));
  process.env.SHENLAN_COST_LEDGER = join(dir, 'cost-ledger.json');
  // 价格文件也重定向到临时目录，避免真实 ~/.shenlan/prices.json 干扰折算
  process.env.SHENLAN_CONFIG_DIR = dir;
  resetPrices();
});

afterEach(() => {
  delete process.env.SHENLAN_COST_LEDGER;
  delete process.env.SHENLAN_CONFIG_DIR;
  resetPrices();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cost-tracker 会话成本记账', () => {
  it('recordUsage 累加 token 与折算成本', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 1_000_000);

    const c = getSessionCost();
    expect(c.promptTokens).toBe(1_000_000);
    expect(c.completionTokens).toBe(1_000_000);
    expect(c.calls).toBe(1);
    // flash（2026-08 官方高峰）：1M input ¥3.0 + 1M output ¥9.0 = ¥12.0
    expect(c.costCny).toBeCloseTo(12.0, 5);
  });

  it('多次调用累加，价格按模型分别折算', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    recordUsage('deepseek-v4-pro', 0, 1_000_000);

    const c = getSessionCost();
    expect(c.calls).toBe(2);
    expect(c.promptTokens).toBe(1_000_000);
    expect(c.completionTokens).toBe(1_000_000);
    // flash input ¥3.0 + pro output ¥27.0 = ¥30.0
    expect(c.costCny).toBeCloseTo(30.0, 5);
  });

  it('未知模型成本为 0，但 token 仍累加', () => {
    recordUsage('unknown-model', 100, 200);

    const c = getSessionCost();
    expect(c.promptTokens).toBe(100);
    expect(c.completionTokens).toBe(200);
    expect(c.costCny).toBe(0);
    expect(c.calls).toBe(1);
  });

  it('getSessionCost 返回副本，外部修改不影响内部状态', () => {
    recordUsage('deepseek-v4-flash', 10, 20);
    const copy = getSessionCost();
    copy.promptTokens = 999;

    expect(getSessionCost().promptTokens).toBe(10);
  });

  it('resetSessionCost 重置会话计数，但不重置日账本', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥3.0
    resetSessionCost();

    expect(getSessionCost()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      costCny: 0,
      calls: 0,
      estimatedCostCny: 0,
      estimatedCalls: 0,
      unpricedModels: [],
    });
    // 单日账本跨会话持久，不受 /clear 影响
    expect(getDailyCost().costCny).toBeCloseTo(3.0, 5);
    expect(getDailyCost().calls).toBe(1);
  });
});

describe('cost-tracker 单日账本', () => {
  it('recordUsage 同时写入日账本文件', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥3.0
    recordUsage('deepseek-v4-pro', 1_000_000, 0); // ¥9.0

    const d = getDailyCost();
    expect(d.costCny).toBeCloseTo(12.0, 5);
    expect(d.calls).toBe(2);

    expect(existsSync(costLedgerPath())).toBe(true);
    const raw = JSON.parse(readFileSync(costLedgerPath(), 'utf-8'));
    expect(raw.date).toBe(d.date);
    expect(raw.costCny).toBeCloseTo(12.0, 5);
    expect(raw.calls).toBe(2);
  });

  it('账本日期跨天（文件是昨天）→ 按今日归零重新累计', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    writeFileSync(costLedgerPath(), JSON.stringify({ date: yDate, costCny: 99, calls: 10 }), 'utf-8');

    // 读取旧账本 → 今日为零
    expect(getDailyCost().costCny).toBe(0);
    expect(getDailyCost().calls).toBe(0);

    // 新调用只累计今天
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    expect(getDailyCost().costCny).toBeCloseTo(3.0, 5);
    expect(getDailyCost().calls).toBe(1);
  });
});

describe('checkCostGuardrail 成本护栏', () => {
  const baseGuardrails = { enabled: true, maxCostPerSession: 5, maxCostPerDay: 20, currency: 'CNY' as const };

  it('未配置或未启用 → 不拦截', () => {
    expect(checkCostGuardrail(undefined).blocked).toBe(false);
    expect(checkCostGuardrail({ ...baseGuardrails, enabled: false }).blocked).toBe(false);
  });

  it('会话成本未超限 → 不拦截', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥3.0
    expect(checkCostGuardrail(baseGuardrails).blocked).toBe(false);
  });

  it('会话成本达到上限 → 拦截并给出会话原因', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥0.28
    const check = checkCostGuardrail({ ...baseGuardrails, maxCostPerSession: 0.28 });
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('本会话成本');
  });

  it('今日成本达到上限 → 拦截并给出今日原因', () => {
    // flash input ¥3.0/1M × 8M = ¥24 ≥ 单日上限 20；会话上限抬高避免先命中会话
    recordUsage('deepseek-v4-flash', 8_000_000, 0);
    const check = checkCostGuardrail({ ...baseGuardrails, maxCostPerSession: 100 });
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('今日成本');
  });

  it('会话上限优先于单日上限', () => {
    recordUsage('deepseek-v4-pro', 15_000_000, 0); // 会话与今日均为 ¥135
    const check = checkCostGuardrail(baseGuardrails);
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('本会话成本');
  });

  it('60% 分档预警：level=warn 但不拦截', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥3 = 5 的 60%
    const check = checkCostGuardrail(baseGuardrails);
    expect(check.blocked).toBe(false);
    expect(check.level).toBe('warn');
    expect(check.ratio).toBeCloseTo(0.6, 5);
  });

  it('80% 分档：level=warn，ratio 正确', () => {
    recordUsage('deepseek-v4-flash', 2_000_000, 0); // ¥6 = 7.5 的 80%
    const check = checkCostGuardrail({ ...baseGuardrails, maxCostPerSession: 7.5 });
    expect(check.level).toBe('warn');
    expect(check.ratio).toBeCloseTo(0.8, 5);
  });

  it('低于 60% → level=ok', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥3 = 10 的 30%
    const check = checkCostGuardrail({ ...baseGuardrails, maxCostPerSession: 10 });
    expect(check.level).toBe('ok');
  });
});

describe('cost-tracker 豁免（waiveSession / waiveDay）', () => {
  const baseGuardrails = { enabled: true, maxCostPerSession: 5, maxCostPerDay: 20, currency: 'CNY' as const };

  beforeEach(() => {
    resetSessionCost();
  });

  it('waiveSession 后会话超限不再拦截（单次决定本会话生效），/clear 复位', () => {
    recordUsage('deepseek-v4-pro', 10_000_000, 0); // ¥90 超会话上限
    const g = { ...baseGuardrails, maxCostPerDay: 1000 }; // 隔离单日维度
    expect(checkCostGuardrail(g).blocked).toBe(true);
    expect(checkCostGuardrail(g).kind).toBe('session');

    waiveSession();
    expect(checkCostGuardrail(g).blocked).toBe(false);
    // 后续调用仍放行（豁免持续到本会话结束）
    expect(checkCostGuardrail(g).blocked).toBe(false);

    resetSessionCost();
    recordUsage('deepseek-v4-pro', 10_000_000, 0);
    expect(checkCostGuardrail(g).blocked).toBe(true);
  });

  it('waiveDay 持久化到账本：重启（重新加载）后仍生效', () => {
    recordUsage('deepseek-v4-flash', 8_000_000, 0); // ¥24 超单日上限 20（会话上限抬高）
    const g = { ...baseGuardrails, maxCostPerSession: 100 };
    expect(checkCostGuardrail(g).blocked).toBe(true);
    expect(checkCostGuardrail(g).kind).toBe('day');

    waiveDay();
    expect(isDayWaived()).toBe(true);
    expect(checkCostGuardrail(g).blocked).toBe(false);

    // 重启模拟：账本仍在 → 豁免仍生效
    expect(checkCostGuardrail(g).blocked).toBe(false);
    const raw = JSON.parse(readFileSync(costLedgerPath(), 'utf-8'));
    expect(raw.dayWaived).toBe(true);
  });

  it('账本跨天豁免失效（昨天豁免不延续到今天）', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    writeFileSync(costLedgerPath(), JSON.stringify({ date: yDate, costCny: 0, calls: 0, dayWaived: true }), 'utf-8');
    expect(isDayWaived()).toBe(false);
  });
});

describe('cost-tracker 按合并后价格折算', () => {
  it('recordUsage 使用用户手动覆盖价（manual 优先）', () => {
    writeFileSync(join(dir, 'prices.json'), JSON.stringify({
      manual: { 'deepseek-v4-flash': { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0 } },
    }), 'utf-8');
    resetPrices();
    recordUsage('deepseek-v4-flash', 1_000_000, 1_000_000);
    expect(getSessionCost().costCny).toBeCloseTo(3.0, 5);
    expect(getDailyCost().costCny).toBeCloseTo(3.0, 5);
  });

  it('recordUsage 使用自动同步价（auto 优先于内置）', () => {
    writeFileSync(join(dir, 'prices.json'), JSON.stringify({
      auto: {
        'deepseek-v4-flash': {
          inputPrice: 2, outputPrice: 3, cacheReadPrice: 0,
          effectiveDate: '2026-08', source: 'test', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
    }), 'utf-8');
    resetPrices();
    recordUsage('deepseek-v4-flash', 1_000_000, 1_000_000);
    expect(getSessionCost().costCny).toBeCloseTo(5.0, 5);
  });
});

// —— A2 回归：无内置价模型此前记 0，导致成本护栏恒不触发 ——

describe('无内置价模型走同档回退估算', () => {
  it('recordUsage(qwen3.7-max) 成本非零且标记为估算', () => {
    recordUsage('qwen3.7-max', 1_000_000, 1_000_000);

    const c = getSessionCost();
    expect(c.costCny).toBeCloseTo(12.0, 5); // 同档 qwen-max 2.40 + 9.60
    expect(c.calls).toBe(1);
    expect(c.estimatedCalls).toBe(1);
    expect(c.estimatedCostCny).toBeCloseTo(12.0, 5);
    expect(c.unpricedModels).toEqual(['qwen3.7-max']);
  });

  it('有价与无价混用：只有无价部分计入 estimated*', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥3.0，有内置价
    recordUsage('qwen3.7-plus', 1_000_000, 0);      // ¥0.80，回退估算

    const c = getSessionCost();
    expect(c.calls).toBe(2);
    expect(c.costCny).toBeCloseTo(3.8, 5);
    expect(c.estimatedCalls).toBe(1);
    expect(c.estimatedCostCny).toBeCloseTo(0.8, 5);
    expect(c.unpricedModels).toEqual(['qwen3.7-plus']);
  });

  it('同一无价模型多次调用只登记一次模型名', () => {
    recordUsage('qwen3.7-max', 1_000_000, 0);
    recordUsage('qwen3.7-max', 1_000_000, 0);
    expect(getSessionCost().estimatedCalls).toBe(2);
    expect(getSessionCost().unpricedModels).toEqual(['qwen3.7-max']);
  });

  it('getSessionCost 深拷贝 unpricedModels，外部 push 不污染内部', () => {
    recordUsage('qwen3.7-max', 100, 100);
    getSessionCost().unpricedModels.push('injected');
    expect(getSessionCost().unpricedModels).toEqual(['qwen3.7-max']);
  });

  it('纯无价模型会话现在能触发会话护栏（本 bug 的回归测试）', () => {
    // 修复前：estimateCost 返回 0 → costCny 恒 0 → 永不拦截
    recordUsage('qwen3.7-max', 1_000_000, 1_000_000); // 估算 ¥12 > 上限 ¥5
    const check = checkCostGuardrail({
      enabled: true, maxCostPerSession: 5, maxCostPerDay: 1000, currency: 'CNY',
    });
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('本会话成本');
    expect(check.reason).toContain('估算'); // 说明账面含估算成分，"为什么被拦"可解释
  });

  it('纯无价模型会话现在能触发单日护栏', () => {
    recordUsage('qwen3.7-max', 2_000_000, 2_000_000); // 估算 ¥24 > 单日 ¥20
    const check = checkCostGuardrail({
      enabled: true, maxCostPerSession: 1000, maxCostPerDay: 20, currency: 'CNY',
    });
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('今日成本');
    expect(check.reason).toContain('估算');
  });

  it('全部有价时拦截原因不含估算说明', () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 1_000_000); // ¥12
    const check = checkCostGuardrail({
      enabled: true, maxCostPerSession: 5, maxCostPerDay: 1000, currency: 'CNY',
    });
    expect(check.blocked).toBe(true);
    expect(check.reason).not.toContain('估算');
  });

  it('日账本记录估算字段并可往返读回', () => {
    recordUsage('qwen3.7-max', 1_000_000, 0); // 估算 ¥2.40
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // 有价 ¥3.0

    const raw = JSON.parse(readFileSync(costLedgerPath(), 'utf-8'));
    expect(raw.costCny).toBeCloseTo(5.4, 5);
    expect(raw.calls).toBe(2);
    expect(raw.estimatedCostCny).toBeCloseTo(2.4, 5);
    expect(raw.estimatedCalls).toBe(1);

    const d = getDailyCost();
    expect(d.estimatedCostCny).toBeCloseTo(2.4, 5);
    expect(d.estimatedCalls).toBe(1);
  });

  it('缺新字段的旧账本干净加载（向后兼容）', () => {
    const today = new Date();
    const tDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    writeFileSync(costLedgerPath(), JSON.stringify({ date: tDate, costCny: 7, calls: 3 }), 'utf-8');

    const d = getDailyCost();
    expect(d.costCny).toBe(7);
    expect(d.calls).toBe(3);
    expect(d.estimatedCostCny ?? 0).toBe(0);
    expect(d.estimatedCalls ?? 0).toBe(0);

    // 旧账本上继续累计不丢原值
    recordUsage('qwen3.7-max', 1_000_000, 0);
    expect(getDailyCost().costCny).toBeCloseTo(9.4, 5);
    expect(getDailyCost().estimatedCalls).toBe(1);
  });

  it('目录外模型仍记 0，但计入 estimated 计数以示"未准确计费"', () => {
    recordUsage('some-custom-gateway-model', 1_000_000, 1_000_000);
    const c = getSessionCost();
    expect(c.costCny).toBe(0);
    expect(c.estimatedCalls).toBe(1);
    expect(c.unpricedModels).toEqual(['some-custom-gateway-model']);
  });
});
