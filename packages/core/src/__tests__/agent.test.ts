/**
 * Agent 工具配置注入与子任务 usage 记账测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock provider：一次成功往返（onComplete 带 usage），不发起真实网络请求
vi.mock('../provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.js')>();
  return {
    ...actual,
    chatStream: vi.fn(async (...args: unknown[]) => {
      const cb = args[3] as {
        onComplete: (m: unknown, u?: { promptTokens: number; completionTokens: number }) => void;
      };
      cb.onComplete(
        { role: 'assistant', content: 'done' },
        { promptTokens: 100, completionTokens: 50 },
      );
    }),
  };
});

import { runSubTask, setAgentConfig, getAgentConfig } from '../tools/agent.js';
import { chatStream } from '../provider.js';
import {
  DEFAULT_CONFIG,
  resetSessionCost,
  getSessionCost,
  registerTool,
  unregisterTool,
} from '../index.js';

describe('agent 工具配置注入', () => {
  it('getAgentConfig 返回 setAgentConfig 注入的配置与模型', () => {
    const config = { ...DEFAULT_CONFIG };
    setAgentConfig(config, 'deepseek-v4-flash');
    expect(getAgentConfig()).toEqual({ config, model: 'deepseek-v4-flash' });
  });
});

describe('runSubTask usage tracking', () => {
  beforeEach(() => {
    vi.mocked(chatStream).mockClear();
    resetSessionCost();
    setAgentConfig({ ...DEFAULT_CONFIG }, 'deepseek-v4-flash');
  });

  it('records API-reported usage while running a subtask', async () => {
    const result = await runSubTask('look it up', 'usage tracking', { ...DEFAULT_CONFIG }, 'deepseek-v4-flash', 3);
    expect(result.status).toBe('completed');
    expect(getSessionCost()).toMatchObject({ calls: 1, promptTokens: 100, completionTokens: 50 });
  });
});
