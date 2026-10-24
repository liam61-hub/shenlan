/**
 * DeepSeek 余额检查（/user/balance 启动预检，§21 L2）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { checkDeepseekBalance } from '../balance.js';
import { DEFAULT_CONFIG } from '../config.js';

const realDsKey = process.env.DEEPSEEK_API_KEY;

function configWith(providerKeys: Record<string, string> = {}): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, providerKeys };
}

describe('checkDeepseekBalance', () => {
  let fetchMock: MockInstance;

  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (realDsKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realDsKey;
  });

  it('无 deepseek key：不发起请求，checked=false', async () => {
    const r = await checkDeepseekBalance(configWith());
    expect(r.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is_available=true：返回可用与 CNY 余额', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '42.50', granted_balance: '0.00', topped_up_balance: '42.50' }],
      }),
    });
    const r = await checkDeepseekBalance(configWith({ deepseek: 'sk-ds' }));
    expect(r.checked).toBe(true);
    expect(r.available).toBe(true);
    expect(r.balanceCny).toBe(42.5);
  });

  it('is_available=false：返回不可用（余额不足）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ is_available: false, balance_infos: [] }),
    });
    const r = await checkDeepseekBalance(configWith({ deepseek: 'sk-ds' }));
    expect(r.available).toBe(false);
  });

  it('402 响应：返回不可用与错误信息', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: { message: 'Insufficient Balance' } }),
    });
    const r = await checkDeepseekBalance(configWith({ deepseek: 'sk-ds' }));
    expect(r.checked).toBe(true);
    expect(r.available).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('网络异常：返回不可用与错误（不抛异常）', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const r = await checkDeepseekBalance(configWith({ deepseek: 'sk-ds' }));
    expect(r.available).toBe(false);
    expect(r.error).toContain('network down');
  });
});
