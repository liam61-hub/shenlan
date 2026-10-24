import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';

vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return {
    ...actual,
    chatStream: vi.fn(),
    chat: vi.fn().mockRejectedValue(new Error('no network')),
    executeToolWithTimeout: vi.fn(async () => ({ content: 'ok', isError: false })),
    getAvailableTools: vi.fn(() => []),
    getTool: vi.fn((name: string) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      annotations: name.endsWith('__read') ? { readOnlyHint: true }
        : name.endsWith('__destroy') ? { destructiveHint: true }
          : undefined,
      execute: async () => ({ content: 'ok' }),
    })),
  };
});

import { chatStream } from '@shenlan/core';
import { runAgentLoop, clearSessionApprovals } from '../repl.js';
import type { AgentCallbacks, ConfirmRequestInfo } from '../repl.js';
import { setMode } from '../mode.js';

const cfg: ShenlanConfig = {
  model: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [], mcpServers: [],
  agent: { maxSteps: 80 },
  context: { autoCompactTokenLimit: 200_000, keepRecentTurns: 20, toolOutputLimitChars: 8000, compactModel: 'deepseek-v4-flash' },
};

function toolMessage(name: string, args: Record<string, unknown>, id: string): Message {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function script(messages: Message[]): void {
  let index = 0;
  vi.mocked(chatStream).mockImplementation((_cfg, _msgs, _tools, cb: StreamCallbacks) => {
    const msg = messages[index++] ?? { role: 'assistant', content: 'done' };
    setImmediate(() => cb.onComplete(msg, { promptTokens: 10, completionTokens: 5 }));
    return Promise.resolve();
  });
}

async function run(input: string, decide: (info: ConfirmRequestInfo) => string): Promise<ConfirmRequestInfo[]> {
  const prompts: ConfirmRequestInfo[] = [];
  const callbacks: AgentCallbacks = {
    onToken: () => {}, onToolStart: () => {}, onToolDone: () => {}, onToolError: () => {},
    onComplete: () => {}, onError: (e) => { throw e; },
    onConfirm: async info => { prompts.push(info); return decide(info); },
  };
  await runAgentLoop('', cfg, [{ role: 'user', content: input }], callbacks);
  return prompts;
}

describe('approval in agent loop', () => {
  beforeEach(() => { vi.clearAllMocks(); clearSessionApprovals(); setMode('default'); });
  afterEach(() => { clearSessionApprovals(); });

  it('reuses only a safe command family, then clears grants on reset', async () => {
    script([
      toolMessage('shell', { command: 'git status' }, 'a'),
      toolMessage('shell', { command: 'git status --short' }, 'b'),
      toolMessage('shell', { command: 'git status --short && echo unsafe' }, 'c'),
    ]);
    const prompts = await run('请检查仓库状态', () => 'allow_prefix');
    expect(prompts).toHaveLength(2);
    expect(prompts.every(p => p.language === 'zh-CN')).toBe(true);
    expect(prompts[0]?.commandGrant?.family).toBe(true);
    expect(prompts[1]?.commandGrant?.family).toBe(false);

    clearSessionApprovals();
    script([toolMessage('shell', { command: 'git status' }, 'd')]);
    expect(await run('Check status', () => 'allow')).toHaveLength(1);
  });

  it('uses MCP annotations and never caches destructive approval', async () => {
    script([
      toolMessage('mcp__srv__read', {}, 'r'),
      toolMessage('mcp__srv__write', {}, 'w'),
      toolMessage('mcp__srv__destroy', {}, 'd1'),
      toolMessage('mcp__srv__destroy', {}, 'd2'),
    ]);
    const prompts = await run('Please use these tools', () => 'allow_session');
    expect(prompts.map(p => p.kind)).toEqual(['external', 'destructive', 'destructive']);
  });
});
