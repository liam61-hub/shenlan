/**
 * DeepSeek 余额检查（§21 L2：调用前预算与余额检查的启动预检部分）
 *
 * 接口：GET /user/balance（Bearer key），响应 is_available + balance_infos
 * （currency / total_balance / granted_balance / topped_up_balance）。
 * 字段细节以实现时官方文档为准（§25）。
 */
import { resolveApiKey, resolveBaseUrl } from './config.js';
import type { ShenlanConfig } from './config.js';

export interface BalanceCheckResult {
  /** 是否实际发起了检查（无 deepseek key 时为 false） */
  checked: boolean;
  available: boolean;
  /** CNY 余额（balance_infos 里 currency=CNY 的 total_balance） */
  balanceCny?: number;
  error?: string;
}

const BALANCE_TIMEOUT_MS = 10_000;

/** 检查 DeepSeek 账户余额可用性；无 key 静默跳过（checked=false） */
export async function checkDeepseekBalance(config: ShenlanConfig): Promise<BalanceCheckResult> {
  const apiKey = resolveApiKey(config, 'deepseek');
  if (!apiKey) return { checked: false, available: false };

  const endpoint = `${resolveBaseUrl(config, 'deepseek-v4-flash')}/user/balance`;
  try {
    const resp = await withTimeout(
      fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      }),
      BALANCE_TIMEOUT_MS,
    );
    if (!resp.ok) {
      let detail = '';
      try {
        const body = await resp.json() as { error?: { message?: string } };
        detail = body.error?.message ?? '';
      } catch { /* ignore */ }
      return {
        checked: true,
        available: false,
        error: `balance check HTTP ${resp.status}${detail ? `: ${detail}` : ''}`,
      };
    }
    const data = await resp.json() as {
      is_available?: boolean;
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = (data.balance_infos ?? []).find((b) => b.currency === 'CNY');
    return {
      checked: true,
      available: data.is_available === true,
      balanceCny: info?.total_balance !== undefined ? Number(info.total_balance) : undefined,
    };
  } catch (err) {
    return { checked: true, available: false, error: (err as Error).message };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
