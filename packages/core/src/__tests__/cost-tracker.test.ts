import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionCost, recordUsage, resetSessionCost } from '../cost-tracker.js';

describe('session token usage', () => {
  beforeEach(() => resetSessionCost());

  it('aggregates API usage by model and preserves the session total', () => {
    recordUsage('deepseek-v4-flash', 100, 50);
    recordUsage('deepseek-v4-flash', 20, 10);
    recordUsage('qwen3.7-max', 30, 15);
    const usage = getSessionCost();
    expect(usage).toMatchObject({ promptTokens: 150, completionTokens: 75, calls: 3 });
    expect(usage.byModel.map(({ model, promptTokens, completionTokens, calls }) => ({ model, promptTokens, completionTokens, calls }))).toEqual([
      { model: 'deepseek-v4-flash', promptTokens: 120, completionTokens: 60, calls: 2 },
      { model: 'qwen3.7-max', promptTokens: 30, completionTokens: 15, calls: 1 },
    ]);
    expect(usage.byModel.reduce((sum, item) => sum + item.promptTokens, 0)).toBe(usage.promptTokens);
    expect(usage.byModel.reduce((sum, item) => sum + item.completionTokens, 0)).toBe(usage.completionTokens);
    expect(usage.byModel.reduce((sum, item) => sum + item.calls, 0)).toBe(usage.calls);
  });

  it('marks an unknown model estimate unavailable without inventing a zero amount', () => {
    recordUsage('some-custom-gateway-model', 100, 25);
    const usage = getSessionCost();
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(25);
    expect(usage.estimatedCostCny).toBeNull();
    expect(usage.byModel[0]?.estimatedCostCny).toBeNull();
    expect(usage.unpricedModels).toEqual(['some-custom-gateway-model']);
  });

  it('returns defensive copies and resets usage for a new session', () => {
    recordUsage('deepseek-v4-flash', 10, 20);
    getSessionCost().byModel[0]!.promptTokens = 999;
    expect(getSessionCost().byModel[0]?.promptTokens).toBe(10);
    resetSessionCost();
    expect(getSessionCost()).toMatchObject({ promptTokens: 0, completionTokens: 0, calls: 0, byModel: [] });
  });
});
