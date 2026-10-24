import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';

// run.ts 依赖的 core 模块：mock 掉网络与工具执行，其余保留真实实现
vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return {
    ...actual,
    chatStream: vi.fn(),
    executeToolWithTimeout: vi.fn(async () => ({
      content: 'ok',
      isError: false,
      timedOut: false,
    })),
    getAvailableTools: vi.fn(() => []),
    getTool: vi.fn(() => ({
      name: 'read',
      description: 'read a file',
      parameters: {},
      execute: async () => ({ content: '', isError: false }),
    })),
  };
});

import { chatStream } from '@shenlan/core';
import { runTask } from '../run.js';
import { resetSessionSticky } from '../router.js';

const baseConfig: ShenlanConfig = {
  model: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-v4-flash',
    maxTokens: 8192,
  },
  permissions: { mode: 'bypassPermissions', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
  agent: { maxSteps: 80 },
  context: {
    autoCompactTokenLimit: 200_000,
    keepRecentTurns: 20,
    toolOutputLimitChars: 8000,
    compactModel: 'deepseek-v4-flash',
  },
};

const toolCallMsg = (args: string, name = 'read', id = 'c1'): Message => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});

const textMsg = (content: string): Message => ({ role: 'assistant', content });

/** 安装 chatStream 脚本：按序返回 assistant 消息，超出后返回文本结束 */
function installChatScript(script: Array<() => Message>): void {
  let idx = 0;
  vi.mocked(chatStream).mockImplementation(
    (
      _cfg: unknown,
      _msgs: unknown,
      _tools: unknown,
      cb: StreamCallbacks,
    ): Promise<void> => {
      const msg = script[idx] ? script[idx]() : textMsg('(end)');
      idx++;
      setImmediate(() => {
        cb.onComplete(msg, { promptTokens: 10, completionTokens: 5 });
      });
      return Promise.resolve();
    },
  );
}

describe('runTask — 循环检测', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSticky();
  });

  it('同一签名连续出现 5 次 → failed 且含 Tool loop', async () => {
    const same = () => toolCallMsg('{"file_path":"a.txt"}');
    installChatScript(Array.from({ length: 5 }, () => same));

    const result = await runTask('读文件', baseConfig);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Tool loop');
    expect(result.error).toContain('read');
    expect(result.steps).toBe(5);
  });

  it('同一签名被其他调用打断后重新计数，不误判为循环', async () => {
    const readA = () => toolCallMsg('{"file_path":"a.txt"}');
    const readB = () => toolCallMsg('{"file_path":"b.txt"}');
    installChatScript([
      readA, readA, readB, readA, readA, readA,
      () => textMsg('完成'),
    ]);

    const result = await runTask('读文件', baseConfig);

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
  });

  it('同一文件不同区间分块读取不误判为循环', async () => {
    const reads = Array.from({ length: 10 }, (_, i) => () =>
      toolCallMsg(JSON.stringify({ file_path: 'a.txt', offset: i * 10 + 1, limit: 10 })),
    );
    installChatScript([...reads, () => textMsg('完成')]);

    const result = await runTask('读文件', baseConfig);

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
  });
});
