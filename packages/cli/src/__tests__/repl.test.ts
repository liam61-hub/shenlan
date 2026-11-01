import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getToolDetail } from '../repl.js';

// repl.ts 依赖的 core 模块：mock 掉网络与工具执行，其余保留真实实现
vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return {
    ...actual,
    chatStream: vi.fn(),
    chat: vi.fn().mockRejectedValue(new Error('mock: no network')),
    executeToolCall: vi.fn(async () => ({
      status: 'executed',
      content: 'y'.repeat(1500),
      isError: false,
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

import { chat, chatStream, executeToolCall, getSessionCost, recordUsage, resetSessionCost, messageTextOf } from '@shenlan/core';
import { compactContext, runAgentLoop, resetCompressionState, getCompressionHistory } from '../repl.js';
import type { AgentCallbacks } from '../repl.js';
import { resetSessionSticky } from '../router.js';
import { resetStop } from '../repl.js';
import { setMode } from '../mode.js';

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

describe('getToolDetail', () => {
  it('agent 运行状态显示 goal，避免 spinner 只显示工具名', () => {
    expect(getToolDetail('agent', JSON.stringify({ goal: '审计协议安全', task: '检查 Rust HTTP parser' })))
      .toBe('审计协议安全');
  });

  it('agent goal 遵守状态行宽度限制', () => {
    expect(getToolDetail('agent', JSON.stringify({ goal: 'x'.repeat(100) }))).toHaveLength(80);
  });
});

describe('runAgentLoop — 步数护栏', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
  });

  it('超过 30 轮不再报错，正常完成（唯一签名不触发循环检测）', async () => {
    const script = [
      ...Array.from({ length: 35 }, (_, i) => () => toolCallMsg(`{"file_path":"f${i}.txt"}`)),
      () => textMsg('完成'),
    ];
    installChatScript(script);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 40 } }, messages, callbacks);

    expect(events.filter(e => e.kind === 'error')).toEqual([]);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(36);
  });

  it('普通交互任务超过 headless 步数配置后继续运行并自动收尾', async () => {
    const same = () => toolCallMsg('{"file_path":"a.txt"}');
    installChatScript([same, same, same, () => textMsg('完成')]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 3 } }, messages, callbacks);

    expect(events.filter(e => e.kind === 'error')).toEqual([]);
    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('已达步数上限'))).toBe(false);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(4);
  });
});

describe('runAgentLoop — 循环检测', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
  });

  it('同签名工具调用 ≥5 次注入纠正消息，随后正常完成', async () => {
    const same = () => toolCallMsg('{"file_path":"a.txt"}');
    installChatScript([
      same, same, same, same, same,
      () => textMsg('好的，直接回答'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    const correction = messages.find(
      m => m.role === 'user' && messageTextOf(m).includes('检测到重复调用'),
    );
    expect(correction).toBeTruthy();
    const corrections = messages.filter(
      m => m.role === 'user' && messageTextOf(m).includes('检测到重复调用'),
    );
    expect(corrections).toHaveLength(1);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(6);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.filter(e => e.kind === 'error')).toEqual([]);
  });

  it('纠正后连续 6 轮无进展 → 优雅收尾并说明原因', async () => {
    const same = () => toolCallMsg('{"file_path":"a.txt"}');
    installChatScript(Array.from({ length: 11 }, () => same));
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('无进展'))).toBe(true);
    const corrections = messages.filter(
      m => m.role === 'user' && messageTextOf(m).includes('检测到重复调用'),
    );
    expect(corrections).toHaveLength(1);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.filter(e => e.kind === 'error')).toEqual([]);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(11);
  });

  it('同一文件 10 次不同区间读取不触发纠正、不停止', async () => {
    const reads = Array.from({ length: 10 }, (_, i) => () =>
      toolCallMsg(JSON.stringify({ file_path: 'a.txt', offset: i * 10 + 1, limit: 10 })),
    );
    installChatScript([...reads, () => textMsg('完成')]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '分块读取文件' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    const corrections = messages.filter(
      m => m.role === 'user' && messageTextOf(m).includes('检测到重复调用'),
    );
    expect(corrections).toHaveLength(0);
    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('无进展'))).toBe(false);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.filter(e => e.kind === 'error')).toEqual([]);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(11);
  });

  it('纠正后「读 + 编辑成功」交替不触发停止', async () => {
    const sameRead = () => toolCallMsg('{"file_path":"a.txt"}');
    const edit = () => toolCallMsg(
      '{"file_path":"a.txt","old_string":"x","new_string":"y"}',
      'edit',
    );
    installChatScript([
      sameRead, sameRead, sameRead, sameRead, sameRead,
      sameRead, edit, sameRead, edit, sameRead, edit,
      sameRead, edit, sameRead, edit, sameRead, edit,
      () => textMsg('完成'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '边读边改' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('无进展'))).toBe(false);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.filter(e => e.kind === 'error')).toEqual([]);
  });

  it('纠正后同一调用返回内容变化计为进展，不触发停止', async () => {
    const sameRead = () => toolCallMsg('{"file_path":"a.txt"}');
    installChatScript([
      sameRead, sameRead, sameRead, sameRead, sameRead,
      sameRead, sameRead, sameRead, sameRead, sameRead, sameRead,
      () => textMsg('完成'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '读取变化中的文件' },
    ];
    // 每次执行返回不同内容 → 同签名工具结果变化 = 进展
    let execIdx = 0;
    vi.mocked(executeToolCall).mockImplementation(async () => {
      execIdx++;
      return { status: 'executed', content: `result-${execIdx}`, isError: false };
    });
    try {
      const { events, callbacks } = harness();
      await runAgentLoop('', baseConfig, messages, callbacks);

      const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
      expect(notices.some(n => n.includes('无进展'))).toBe(false);
      expect(events.some(e => e.kind === 'complete')).toBe(true);
      expect(events.filter(e => e.kind === 'error')).toEqual([]);
    } finally {
      vi.mocked(executeToolCall).mockImplementation(async () => ({
        status: 'executed',
        content: 'y'.repeat(1500),
        isError: false,
      }));
    }
  });
});

describe('runAgentLoop — 上下文压缩', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
  });

  it('超过阈值自动压缩并通知，_summary 与最近轮保留', async () => {
    const big = 'x'.repeat(1200);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 12 }, (_, i) => [
        { role: 'user' as const, content: `问题${i} ${big}` },
        { role: 'assistant' as const, content: `回答${i}` },
      ]).flat(),
    ];
    const config: ShenlanConfig = {
      ...baseConfig,
      context: { ...baseConfig.context!, autoCompactTokenLimit: 500, keepRecentTurns: 2 },
    };
    installChatScript([() => textMsg('好了')]);
    const { events, callbacks } = harness();
    await runAgentLoop('', config, messages, callbacks);

    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('上下文已压缩'))).toBe(true);
    const summaries = messages.filter(
      m => m.role === 'user' && messageTextOf(m).includes('=== shenlan 上下文交接摘要 (_summary) ==='),
    );
    expect(summaries.length).toBe(1);
    // 最近 2 个 assistant 轮保留（末尾 user 轮与其回答）
    const tailUsers = messages.filter(
      m => m.role === 'user' && !messageTextOf(m).includes('_summary'),
    );
    expect(tailUsers.some(m => messageTextOf(m).includes('问题11'))).toBe(true);
    expect(tailUsers.some(m => messageTextOf(m).includes('问题0'))).toBe(false);
    expect(messages.some(m => m.role === 'assistant' && m.content === '回答10')).toBe(true);
    expect(getCompressionHistory().length).toBe(1);
  });

  it('10 轮内压缩 3 次仍超限 → 防抖动停止并提示', async () => {
    const big = 'x'.repeat(2000);
    // 大量消息确保每次压缩后仍超阈值
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 40 }, (_, i) => [
        { role: 'user' as const, content: `问题${i} ${big}` },
        { role: 'assistant' as const, content: `回答${i}` },
      ]).flat(),
    ];
    const config: ShenlanConfig = {
      ...baseConfig,
      context: { ...baseConfig.context!, autoCompactTokenLimit: 300, keepRecentTurns: 2 },
    };
    // 每轮都返回工具调用，让循环持续到防抖动触发
    installChatScript(Array.from({ length: 20 }, () => () => toolCallMsg('{}')));
    const { events, callbacks } = harness();
    await runAgentLoop('', config, messages, callbacks);

    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('反复压缩循环，建议新开会话或 /clear'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.filter(e => e.kind === 'error')).toEqual([]);
  });
});

describe('runAgentLoop — 权限模式即时生效', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
    setMode('default');
  });

  it('default 模式下写工具需要确认（onConfirm 被调用）', async () => {
    const cfg: ShenlanConfig = {
      ...baseConfig,
      permissions: { mode: 'default', allow: ['read', 'search'], deny: [] },
    };
    installChatScript([
      () => toolCallMsg('{"file_path":"a.txt"}', 'write'),
      () => textMsg('完成'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写文件' },
    ];
    let confirmCount = 0;
    const { events, callbacks } = harness();
    callbacks.onConfirm = async () => { confirmCount++; return 'allow'; };
    await runAgentLoop('', cfg, messages, callbacks);
    expect(confirmCount).toBeGreaterThan(0);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });

  it('运行时切到 bypassPermissions 后不再弹确认（配置文件仍是 default）', async () => {
    setMode('bypassPermissions');
    const cfg: ShenlanConfig = {
      ...baseConfig,
      permissions: { mode: 'default', allow: ['read', 'search'], deny: [] },
    };
    installChatScript([
      () => toolCallMsg('{"file_path":"a.txt"}', 'write'),
      () => textMsg('完成'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写文件' },
    ];
    let confirmCount = 0;
    const { callbacks } = harness();
    callbacks.onConfirm = async () => { confirmCount++; return 'allow'; };
    await runAgentLoop('', cfg, messages, callbacks);
    expect(confirmCount).toBe(0);
  });
});

describe('runAgentLoop — 文件变更卡片数据接线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
  });

  it('write 成功 → onToolDone 携带 FileChange（不存在=add + 内容预览）', async () => {
    installChatScript([
      () => toolCallMsg('{"file_path":"__card_new_xyz.txt","content":"hello\\nworld"}', 'write'),
      () => textMsg('完成'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写文件' },
    ];
    const doneEvents: Array<{ name: string; fileChange?: unknown }> = [];
    const { callbacks } = harness();
    callbacks.onToolDone = (id, name, detail, resultContent, fileChange) => {
      doneEvents.push({ name, fileChange });
    };
    await runAgentLoop('', baseConfig, messages, callbacks);

    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].name).toBe('write');
    expect(doneEvents[0].fileChange).toEqual({
      path: '__card_new_xyz.txt',
      kind: 'add',
      lines: [
        { text: 'hello', kind: 'add', oldLine: null, newLine: 1 },
        { text: 'world', kind: 'add', oldLine: null, newLine: 2 },
      ],
      truncated: false,
    });
  });

  it('非 write/edit 成功 → onToolDone 不带 FileChange', async () => {
    installChatScript([
      () => toolCallMsg('{"file_path":"a.txt"}', 'read'),
      () => textMsg('完成'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '读文件' },
    ];
    const doneEvents: Array<{ name: string; fileChange?: unknown }> = [];
    const { callbacks } = harness();
    callbacks.onToolDone = (id, name, detail, resultContent, fileChange) => {
      doneEvents.push({ name, fileChange });
    };
    await runAgentLoop('', baseConfig, messages, callbacks);

    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].name).toBe('read');
    expect(doneEvents[0].fileChange).toBeUndefined();
  });
});

describe('runAgentLoop — cost estimates do not gate requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
    resetSessionCost();
  });

  it('continues to call the model after high usage has accumulated', async () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    installChatScript([() => textMsg('request completed')]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
    ];
    const { callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    expect(vi.mocked(chatStream)).toHaveBeenCalledOnce();
    expect(getSessionCost().calls).toBe(2);
  });
});

describe('runAgentLoop — /goal 长任务模式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
    resetSessionCost();
  });

  const goalParam = { text: '把全部测试跑绿', status: 'active' as const };

  it('goal 模式忽略旧步数上限，自动压缩/续跑直至目标完成', async () => {
    installChatScript([
      () => textMsg('我先看一下测试状态'),
      () => textMsg('继续推进中...'),
      () => toolCallMsg('{"reason":"目标步骤已完成"}', 'goal_complete', 'g1'),
      () => textMsg('目标已完成。'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '把全部测试跑绿' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 1, goalMaxSteps: 1 } }, messages, callbacks, undefined, goalParam);

    // 两次纯文本续跑 + goal_complete + 最终总结，超过遗留步数配置后正常完成
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(4);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.some(e => e.kind === 'notice' && (e.detail || '').includes('目标已完成'))).toBe(true);
    // 续跑消息已注入
    const continueMsg = messages.find(m => m.role === 'user' && messageTextOf(m).includes('继续执行当前目标'));
    expect(continueMsg).toBeDefined();
    // system 消息含 goal 标记（随会话 JSONL 持久化）
    expect(messages[0]?.content).toContain('shenlan-goal');
    expect(messages[0]?.content).toContain('把全部测试跑绿');
  });

  it('模型调用 goal_complete 即达成：通知 + 下一轮总结后收尾', async () => {
    installChatScript([
      () => toolCallMsg('{"reason":"全部用例通过"}', 'goal_complete', 'g1'),
      () => textMsg('目标已完成：全部用例通过。'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '把全部测试跑绿' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 80 } }, messages, callbacks, undefined, goalParam);

    expect(events.some(e => e.kind === 'notice' && (e.detail || '').includes('目标已完成'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    // 工具调用轮 + 总结轮
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(2);
  });

  it('goal 模式连续 3 轮相同文本：提醒并优雅收尾（goal 保持 active，不继续）', async () => {
    const same = () => textMsg('同上');
    installChatScript([same, same, same]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '目标' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 80 } }, messages, callbacks, undefined, goalParam);

    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('连续 3 轮无进展'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });

  it('goal mode continues after prior usage estimates exceed historical limits', async () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    installChatScript([() => textMsg('goal complete')]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
    ];
    const { callbacks } = harness();
    const confirm = vi.fn(async () => 'stop');
    callbacks.onConfirm = confirm;
    await runAgentLoop('', baseConfig, messages, callbacks, undefined, goalParam);

    expect(confirm).not.toHaveBeenCalled();
    expect(vi.mocked(chatStream)).toHaveBeenCalled();
  });
});

describe('压缩摘要模型预算与 usage', () => {
  const summaryConfig: ShenlanConfig = {
    ...baseConfig,
    model: { ...baseConfig.model, apiKey: 'test-summary' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionCost();
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('SHENLAN_API_KEY', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  function longConversation(): Message[] {
    return Array.from({ length: 44 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `conversation message ${index}`,
    }));
  }

  it('does not let prior local estimates block a summary request', async () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    vi.mocked(chat).mockResolvedValue({
      id: 'summary', model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'summary' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const result = await compactContext(summaryConfig, longConversation());
    expect(result.method).toBe('llm');
    expect(vi.mocked(chat)).toHaveBeenCalledOnce();
  });

  it('将压缩摘要响应 usage 按 compactModel 计入共享账本', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'summary',
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'handoff summary' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 },
    });

    const result = await compactContext({
      ...summaryConfig,
      context: {
        autoCompactTokenLimit: 200_000,
        keepRecentTurns: 20,
        toolOutputLimitChars: 8000,
        compactModel: 'deepseek-v4-flash',
      },
    }, longConversation());

    expect(result.method).toBe('llm');
    expect(getSessionCost()).toMatchObject({ promptTokens: 42, completionTokens: 12, calls: 1 });
  });

  it('uses rule compression without calling the model when credentials are absent', async () => {
    const result = await compactContext(baseConfig, longConversation());
    expect(result.method).toBe('rule');
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('runAgentLoop — 空回复兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
    resetSessionCost();
  });

  /** 安装“总是空回复”的 chatStream 脚本，usage 固定 */
  function installEmptyScript(usage: unknown): void {
    vi.mocked(chatStream).mockImplementation(
      (_cfg: unknown, _msgs: unknown, _tools: unknown, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onComplete({ role: 'assistant', content: null }, usage as never));
        return Promise.resolve();
      },
    );
  }

  it('思考模型：输出预算自动抬到思考下限（16384），截断(depth)空回复再升级到模型 cap', async () => {
    installEmptyScript({
      promptTokens: 97_549,
      completionTokens: 8192,
      finishReason: 'length',
      reasoningChars: 26_433,
    });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    // deepseek-v4-flash 目录 thinking:true + maxOutputTokens 32768 + 下限 16384：
    // 首轮即 16384（不再用 8192），截断空回复后升级到 cap 32768
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(2);
    const firstCfg = vi.mocked(chatStream).mock.calls[0][0] as { maxTokens: number };
    const retryCfg = vi.mocked(chatStream).mock.calls[1][0] as { maxTokens: number };
    expect(firstCfg.maxTokens).toBe(16384);
    expect(retryCfg.maxTokens).toBe(32768);

    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('被 max_tokens=16384 截断'))).toBe(true);
    expect(notices.some(n => n.includes('已达模型上限（32768）'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });

  it('非截断空回复 → 通用提示（不升级，仅重试一次）', async () => {
    installEmptyScript({ promptTokens: 100, completionTokens: 5, finishReason: 'stop' });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(2);
    // 非截断不升级：两次都停在思考下限 16384
    const retryCfg = vi.mocked(chatStream).mock.calls[1][0] as { maxTokens: number };
    expect(retryCfg.maxTokens).toBe(16384);
    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices).toContain('模型返回了空回复，本次运行未产生输出');
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });

  it('有正文被截断(length) → 保留正文并追加“继续”续写，不丢内容', async () => {
    vi.mocked(chatStream).mockImplementation(
      (_cfg: unknown, _msgs: unknown, _tools: unknown, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onComplete(
          { role: 'assistant', content: '前半段内容' },
          { promptTokens: 10, completionTokens: 9000, finishReason: 'length' } as never,
        ));
        return Promise.resolve();
      },
    );
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写一篇长文' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);

    // 每次都被 length 截断 → 续写至 MAX_CONTINUATIONS(5)+1 轮后收尾
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(6);
    // 已生成的正文被推入会话（未丢弃）
    const assistantTexts = messages
      .filter(m => m.role === 'assistant')
      .map(m => (typeof m.content === 'string' ? m.content : ''));
    expect(assistantTexts).toContain('前半段内容');
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });
});

describe('checklist reconciliation in the agent loop', () => {
  it('sends a reminder to the next model round after a stage transition', async () => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
    setMode('bypassPermissions');
    installChatScript([
      () => toolCallMsg(JSON.stringify({ plan: [{ step: 'first', status: 'in_progress' }] }), 'update_plan', 'plan'),
      () => toolCallMsg(JSON.stringify({ kind: 'stage', status: 'completed', title: 'first' }), 'task_progress', 'stage'),
      () => textMsg('Done'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'work' }];
    const { events, callbacks } = harness();
    await runAgentLoop('', baseConfig, messages, callbacks);
    const reminders = messages.filter(message => message.role === 'user' && String(message.content).startsWith('[Progress check]'));
    expect(reminders).toHaveLength(1);
    expect(events.some(event => event.kind === 'complete')).toBe(true);
  });
});

describe('shell lifecycle reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
    setMode('bypassPermissions');
  });

  it('reports start and the full commit result before normal tool completion', async () => {
    installChatScript([() => toolCallMsg(JSON.stringify({ command: 'git commit -m fix' }), 'shell', 'commit')]);
    vi.mocked(executeToolCall).mockResolvedValueOnce({
      status: 'executed', isError: false,
      content: 'Scan passed\n[main f3714bc] test: cover try_files\n 1 file changed, 156 insertions(+)',
    });
    const { callbacks } = harness();
    const order: string[] = [];
    callbacks.onShellActivity = event => {
      order.push(event.phase);
      if (event.phase === 'started') expect(executeToolCall).not.toHaveBeenCalled();
      else expect(event.output).toContain('[main f3714bc]');
    };
    callbacks.onToolDone = () => { order.push('done'); };
    await runAgentLoop('', baseConfig, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'work' }], callbacks);
    expect(order).toEqual(['started', 'finished', 'done']);
  });

  it('reports failure without requiring a model progress tool', async () => {
    installChatScript([() => toolCallMsg(JSON.stringify({ command: 'cargo test' }), 'shell', 'tests')]);
    vi.mocked(executeToolCall).mockResolvedValueOnce({ status: 'executed', isError: true,
      content: 'Command exited with code 101\ntest result: FAILED. 4 passed; 1 failed' });
    const { callbacks } = harness();
    const onShellActivity = vi.fn();
    callbacks.onShellActivity = onShellActivity;
    await runAgentLoop('', baseConfig, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'work' }], callbacks);
    expect(onShellActivity).toHaveBeenCalledTimes(2);
    expect(onShellActivity.mock.calls[1][0]).toMatchObject({ phase: 'finished', failed: true });
  });
});

it('preserves the final test summary when polling a background check', async () => {
  vi.clearAllMocks();
  resetStop(); resetSessionSticky(); resetCompressionState(); setMode('bypassPermissions');
  installChatScript([
    () => toolCallMsg(JSON.stringify({ command: 'cargo test' }), 'shell', 'background'),
    () => toolCallMsg(JSON.stringify({ id: 'bg-tests' }), 'shell_status', 'poll'),
  ]);
  vi.mocked(executeToolCall)
    .mockResolvedValueOnce({ status: 'executed', isError: true,
      content: 'Command timed out after 120 seconds — still running in the background (id: bg-tests).' })
    .mockResolvedValueOnce({ status: 'executed', isError: false,
      content: '[bg-tests] completed (exit 0) — 140s elapsed — cargo test\ntest result: ok. 5 passed; 0 failed' });
  const { callbacks } = harness();
  const onShellActivity = vi.fn();
  callbacks.onShellActivity = onShellActivity;
  await runAgentLoop('', baseConfig, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'work' }], callbacks);
  expect(onShellActivity).toHaveBeenCalledTimes(3);
  expect(onShellActivity.mock.calls[2][0]).toMatchObject({ id: 'poll', phase: 'finished', activities: [{ label: 'cargo test' }] });
  expect(onShellActivity.mock.calls[2][0].output).toContain('5 passed');
});
