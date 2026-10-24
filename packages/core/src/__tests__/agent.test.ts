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
import { DEFAULT_CONFIG, resetSessionCost, getSessionCost } from '../index.js';

describe('agent 工具配置注入', () => {
  it('getAgentConfig 返回 setAgentConfig 注入的配置与模型', () => {
    const config = { ...DEFAULT_CONFIG };
    setAgentConfig(config, 'deepseek-v4-flash');
    expect(getAgentConfig()).toEqual({ config, model: 'deepseek-v4-flash' });
  });
});

describe('runSubTask usage 记账（§26.3：子任务成本计入同一会话护栏）', () => {
  beforeEach(() => {
    resetSessionCost();
    setAgentConfig({ ...DEFAULT_CONFIG }, 'deepseek-v4-flash');
  });

  it('一次成功往返的 LLM usage 计入会话成本', async () => {
    const result = await runSubTask('查一下', 'goal-记账', { ...DEFAULT_CONFIG }, 'deepseek-v4-flash', 3);
    expect(result.success).toBe(true);
    const cost = getSessionCost();
    expect(cost.calls).toBe(1);
    expect(cost.promptTokens).toBe(100);
    expect(cost.completionTokens).toBe(50);
  });
});
