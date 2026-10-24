import { describe, expect, it, vi, afterEach } from 'vitest';
import { resetViewportToTop } from '../screen-reset.js';

describe('resetViewportToTop（/clear 视觉重置：推屏 + 光标归位 + Ink 帧状态重置）', () => {
  const originalWrite = process.stdout.write;
  const originalRowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const originalInk = (globalThis as any).__shenlanInk;

  afterEach(() => {
    process.stdout.write = originalWrite;
    if (originalRowsDesc) {
      Object.defineProperty(process.stdout, 'rows', originalRowsDesc);
    } else {
      delete (process.stdout as unknown as { rows?: number }).rows;
    }
    (globalThis as any).__shenlanInk = originalInk;
  });

  function captureWrites(): string[] {
    const writes: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    return writes;
  }

  it('推屏序列：末行定位 + rows 个换行 + 光标归位，不发 2J/3J', () => {
    const writes = captureWrites();
    (globalThis as any).__shenlanInk = undefined;

    resetViewportToTop(24);

    expect(writes[0]).toBe('\x1b[24;1H');
    expect(writes[1]).toBe('\n'.repeat(24));
    expect(writes[2]).toBe('\x1b[H');
    const all = writes.join('');
    expect(all).not.toContain('\x1b[2J');
    expect(all).not.toContain('\x1b[3J');
  });

  it('termHeight 缺失（0）时回退 stdout.rows，再回退 24', () => {
    const writes = captureWrites();
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    (globalThis as any).__shenlanInk = undefined;

    resetViewportToTop(0);
    expect(writes[0]).toBe('\x1b[40;1H');
    expect(writes[1]).toBe('\n'.repeat(40));

    const writes2 = captureWrites();
    delete (process.stdout as unknown as { rows?: number }).rows;
    resetViewportToTop(0);
    expect(writes2[0]).toBe('\x1b[24;1H');
  });

  it('重置 Ink 帧状态：lastOutput/lastOutputHeight 清零，log.reset 被调用', () => {
    captureWrites();
    const reset = vi.fn();
    (globalThis as any).__shenlanInk = {
      lastOutput: 'old',
      lastOutputToRender: 'old\n',
      lastOutputHeight: 4,
      log: { reset },
    };

    resetViewportToTop(10);

    const ink = (globalThis as any).__shenlanInk;
    expect(ink.lastOutput).toBe('');
    expect(ink.lastOutputToRender).toBe('');
    expect(ink.lastOutputHeight).toBe(0);
    expect(reset).toHaveBeenCalledOnce();
  });
});
