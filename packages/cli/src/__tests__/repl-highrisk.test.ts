/**
 * 高危动作双确认 — repl 预检（默认 deny / confirm 短语放行）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';

// 与 repl-bg.test.ts 同款 harness：mock 网络与工具执行，保留 core 真实实现
vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return {
    ...actual,
    chatStream: vi.fn(),
    chat: vi.fn().mockRejectedValue(new Error('mock: no network')),
    executeToolWithTimeout: vi.fn(async () => ({ content: 'executed ok', isError: false })),
    getAvailableTools: vi.fn(() => []),
    getTool: vi.fn(() => ({
      name: 'shell',
      description: 'run a command',
      parameters: {},
      execute: async () => ({ content: 'executed ok', isError: false }),
    })),
  };
});

import { chatStream, executeToolWithTimeout } from '@shenlan/core';
import { runAgentLoop, resetStop } from '../repl.js';
import type { AgentCallbacks } from '../repl.js';
import { setMode } from '../mode.js';

function configWith(highRiskActions: 'deny' | 'confirm'): ShenlanConfig {
  return {
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
    actionSafety: {
      highRiskActions,
      confirmPhrase: 'yes',
      protectedPaths: [],
      auditEnabled: true,
    },
  };
}

const shellCall = (command: string): Message => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } }],
});

const textMsg = (content: string): Message => ({ role: 'assistant', content });

function installChatScript(script: Array<() => Message>): Array<string[]> {
  let idx = 0;
  const captured: Array<string[]> = [];
  vi.mocked(chatStream).mockImplementation(
    (_cfg: unknown, msgs: unknown, _tools: unknown, cb: StreamCallbacks): Promise<void> => {
      captured.push((msgs as Message[]).map(m => (m.content ?? '') as string));
      const msg = script[idx] ? script[idx]() : textMsg('(end)');
      idx++;
      setImmediate(() => cb.onComplete(msg, { promptTokens: 10, completionTokens: 5 }));
      return Promise.resolve();
    },
  );
  return captured;
}

function harness(onConfirm: AgentCallbacks['onConfirm']) {
  const events: Array<{ kind: string; detail?: string }> = [];
  const callbacks: AgentCallbacks = {
    onToken: () => {},
    onToolStart: () => {},
    onToolDone: () => {},
    onToolError: () => {},
    onConfirm,
    onComplete: () => { events.push({ kind: 'complete' }); },
    onError: (err: Error) => { events.push({ kind: 'error', detail: err.message }); },
    onNotice: () => {},
  };
  return { events, callbacks };
}

describe('高危命令预检（repl）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    // 运行时 bypass：普通权限门不再弹确认，只测高危预检路径
    setMode('bypassPermissions');
  });

  afterEach(() => {
    setMode('default');
  });

  it('highRiskActions=deny（默认）：高危命令不弹确认、直接拦截、不执行', async () => {
    let confirmCalls = 0;
    const { callbacks } = harness(async () => { confirmCalls++; return 'allow'; });
    installChatScript([() => shellCall('rm -rf /tmp/x'), () => textMsg('(end)')]);

    const messages: Message[] = [{ role: 'user', content: '删掉临时目录' }];
    await runAgentLoop('', configWith('deny'), messages, callbacks);

    expect(confirmCalls).toBe(0);
    expect(vi.mocked(executeToolWithTimeout)).not.toHaveBeenCalled();
    const toolMsgs = messages.filter(m => m.role === 'tool').map(m => m.content ?? '');
    expect(toolMsgs.join('\n')).toContain('HIGH RISK');
  });

  it('highRiskActions=confirm：短语正确放行执行一次', async () => {
    let confirmCalls = 0;
    const { callbacks } = harness(async () => { confirmCalls++; return 'phrase:yes'; });
    installChatScript([() => shellCall('git push --force origin main'), () => textMsg('(end)')]);

    const messages: Message[] = [{ role: 'user', content: '强推' }];
    await runAgentLoop('', configWith('confirm'), messages, callbacks);

    expect(confirmCalls).toBe(1);
    expect(vi.mocked(executeToolWithTimeout)).toHaveBeenCalledTimes(1);
    const toolMsgs = messages.filter(m => m.role === 'tool').map(m => m.content ?? '');
    expect(toolMsgs.join('\n')).not.toContain('HIGH RISK');
  });

  it('highRiskActions=confirm：短语错误拒绝执行', async () => {
    const { callbacks } = harness(async () => 'phrase:no');
    installChatScript([() => shellCall('rm -rf /tmp/x'), () => textMsg('(end)')]);

    const messages: Message[] = [{ role: 'user', content: '删掉临时目录' }];
    await runAgentLoop('', configWith('confirm'), messages, callbacks);

    expect(vi.mocked(executeToolWithTimeout)).not.toHaveBeenCalled();
    const toolMsgs = messages.filter(m => m.role === 'tool').map(m => m.content ?? '');
    expect(toolMsgs.join('\n')).toContain('denied');
  });

  it('普通命令不受预检影响（照常走权限门与执行）', async () => {
    let confirmCalls = 0;
    const { callbacks } = harness(async () => { confirmCalls++; return 'allow'; });
    installChatScript([() => shellCall('npm run build'), () => textMsg('(end)')]);

    const messages: Message[] = [{ role: 'user', content: '构建' }];
    await runAgentLoop('', configWith('deny'), messages, callbacks);

    expect(vi.mocked(executeToolWithTimeout)).toHaveBeenCalledTimes(1);
    const toolMsgs = messages.filter(m => m.role === 'tool').map(m => m.content ?? '');
    expect(toolMsgs.join('\n')).not.toContain('HIGH RISK');
  });
});
