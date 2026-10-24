import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPriceTableExpired, resetPrices } from '../pricing.js';

describe('isPriceTableExpired', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shenlan-expiry-'));
    process.env.SHENLAN_CONFIG_DIR = dir;
    resetPrices();
  });
  afterEach(() => {
    delete process.env.SHENLAN_CONFIG_DIR;
    resetPrices();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns boolean', () => {
    const result = isPriceTableExpired();
    expect(typeof result).toBe('boolean');
  });

  it('current price table is not expired (effective 2026-08)', () => {
    // 我们的价格表是 2026-08，当前日期也是 2026-08，不应过期
    expect(isPriceTableExpired()).toBe(false);
  });
});
