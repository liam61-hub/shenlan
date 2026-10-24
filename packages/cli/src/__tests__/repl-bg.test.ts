/**
 * 后台任务结果注入主循环 + /stop 终止接线 集成测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';

// 与 repl.test.ts 同款 harness：mock 网络与工具执行，保留 core 真实实现
vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return {
    ...actual,
    chatStream: vi.fn(),
    chat: vi.fn().mockRejectedValue(new Error('mock: no network')),
    executeToolWithTimeout: vi.fn(async () => ({ content: 'ok', isError: false })),
    getAvailableTools: vi.fn(() => []),
    getTool: vi.fn(() => ({
      name: 'read',
      description: 'read a file',
      parameters: {},
      execute: async () => ({ content: '', isError: false }),
    })),
  };
});

import {
  chatStream,
  setBackgroundRunner,
  startBackgroundTask,
  consumePendingInjections,
  clearBackgroundTasks,
} from '@shenlan/core';
import { runAgentLoop, triggerStop, resetStop } from '../repl.js';
import type { AgentCallbacks } from '../repl.js';

const baseConfig: ShenlanConfig = {
  model: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
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

const toolCallMsg = (): Message => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
});

const textMsg = (content: string): Message => ({ role: 'assistant', content });

/** chatStream 脚本：round 1 工具调用，round 2 文本结束；第 1 次调用时触发 hook。
 *  每次调用对 messages 做快照（runAgentLoop 原地修改同一数组，事后读取调用参数是活引用）。 */
function installChatScript(onFirstCall: () => void): Array<string[]> {
  let idx = 0;
  const captured: Array<string[]> = [];
  vi.mocked(chatStream).mockImplementation(
    (_cfg: unknown, msgs: unknown, _tools: unknown, cb: StreamCallbacks): Promise<void> => {
      if (idx === 0) onFirstCall();
      captured.push((msgs as Message[]).map(m => (m.content ?? '') as string));
      const msg = idx === 0 ? toolCallMsg() : textMsg('(end)');
      idx++;
      setImmediate(() => cb.onComplete(msg, { promptTokens: 10, completionTokens: 5 }));
      return Promise.resolve();
    },
  );
  return captured;
}

function harness() {
  const events: Array<{ kind: string; detail?: string }> = [];
  const callbacks: AgentCallbacks = {
    onToken: () => {},
    onToolStart: () => {},
    onToolDone: () => {},
    onToolError: () => {},
    onConfirm: async () => 'allow',
    onComplete: () => { events.push({ kind: 'complete' }); },
    onError: (err: Error) => { events.push({ kind: 'error', detail: err.message }); },
    onNotice: (content: string) => { events.push({ kind: 'notice', detail: content }); },
  };
  return { events, callbacks };
}

describe('后台任务结果注入主循环', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    clearBackgroundTasks();
  });

  it('任务在轮次间完成：下一轮 LLM 调用前注入一次，不打断在途请求', async () => {
    let resolveTask!: (v: { goal: string; summary: string; success: boolean }) => void;
    setBackgroundRunner(() => new Promise((res) => { resolveTask = res; }));
    startBackgroundTask('研究定价', '查 Tavily 定价', undefined, { maxBackground: 3 });

    // 第 1 次 LLM 调用（在途请求）发起后，任务才完成
    const captured = installChatScript(() => {
      resolveTask({ goal: '研究定价', summary: '结论：按月计费', success: true });
    });

    const { events, callbacks } = harness();
    const messages: Message[] = [{ role: 'user', content: '开始' }];
    await runAgentLoop('', baseConfig, messages, callbacks);

    expect(vi.mocked(chatStream).mock.calls.length).toBe(2);

    const round1Texts = captured[0]!.join('\n');
    expect(round1Texts).not.toContain('[background task');

    const round2Texts = captured[1]!.join('\n');
    expect(round2Texts).toContain('[background task bg-');
    expect(round2Texts).toContain('done] Goal: 研究定价');
    expect(round2Texts).toContain('结论：按月计费');

    // 只注入一次：队列已清空
    expect(consumePendingInjections()).toHaveLength(0);
    // 完成瞬态通知
    expect(events).toContainEqual(expect.objectContaining({ kind: 'notice', detail: '✓ bg: 研究定价 done' }));
  });
});

describe('/stop 终止后台任务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    clearBackgroundTasks();
  });

  it('triggerStop 终止全部运行中后台任务（AbortSignal 生效）', () => {
    let seenSignal: AbortSignal | undefined;
    setBackgroundRunner((_g, _t, signal) => new Promise((_, rej) => {
      seenSignal = signal;
      signal!.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    startBackgroundTask('g', 't', undefined, { maxBackground: 1 });
    triggerStop();
    expect(seenSignal!.aborted).toBe(true);
  });
});
