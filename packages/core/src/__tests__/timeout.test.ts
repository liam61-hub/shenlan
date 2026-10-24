import { describe, expect, it } from 'vitest';
import {
  executeToolWithTimeout,
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_TIMEOUTS,
} from '../tools/timeout.js';
import type { Tool } from '../tools/index.js';

function fakeTool(name: string, impl: (signal?: AbortSignal) => Promise<{ content: string; isError?: boolean }>): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: async (_params, signal) => impl(signal),
  };
}

describe('executeToolWithTimeout', () => {
  it('正常完成返回结果，不标记超时', async () => {
    const tool = fakeTool('read', async () => ({ content: 'ok' }));
    const result = await executeToolWithTimeout(tool, {}, { timeoutMs: 500 });
    expect(result).toEqual({ content: 'ok', isError: false, timedOut: false });
  });

  it('超时后 abort 底层工具并返回超时错误', async () => {
    let aborted = false;
    const tool = fakeTool('shell', async (signal) => {
      await new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          resolve(null);
        });
      });
      return { content: 'killed', isError: true };
    });
    const result = await executeToolWithTimeout(tool, {}, { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('command timed out after');
    expect(aborted).toBe(true);
  });

  it('超时默认值 60s，shell/agent 使用专属超时', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(60_000);
    // shell 超时语义由工具自身管理（超时转后台），外层不设硬超时
    expect(TOOL_TIMEOUTS.shell).toBe(Number.POSITIVE_INFINITY);
    expect(TOOL_TIMEOUTS.agent).toBe(300_000);
  });

  it('shell 使用 Infinity 外层超时时不设定时器，工具结果直达', async () => {
    const tool = fakeTool('shell', async () => ({ content: 'ok' }));
    const result = await executeToolWithTimeout(tool, {});
    expect(result).toEqual({ content: 'ok', isError: false, timedOut: false });
  });

  it('外层 signal 中止也会终止工具', async () => {
    const controller = new AbortController();
    let aborted = false;
    const tool = fakeTool('read', async (signal) => {
      await new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          resolve(null);
        });
      });
      return { content: 'x' };
    });
    const promise = executeToolWithTimeout(tool, {}, { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    const result = await promise;
    expect(aborted).toBe(true);
    expect(result.content).toBe('x');
  });
});
