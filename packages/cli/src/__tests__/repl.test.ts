import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// repl.ts 依赖的 core 模块：mock 掉网络与工具执行，其余保留真实实现
vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return {
    ...actual,
    chatStream: vi.fn(),
    chat: vi.fn().mockRejectedValue(new Error('mock: no network')),
    executeToolWithTimeout: vi.fn(async () => ({
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

import { chatStream, executeToolWithTimeout, recordUsage, resetSessionCost, messageTextOf } from '@shenlan/core';
import { runAgentLoop, resetCompressionState, getCompressionHistory } from '../repl.js';
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

  it('命中步数上限时优雅收尾（onComplete + 通知，可继续输入续跑）', async () => {
    const same = () => toolCallMsg('{"file_path":"a.txt"}');
    installChatScript([same, same, same]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 3 } }, messages, callbacks);

    expect(events.filter(e => e.kind === 'error')).toEqual([]);
    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('已达步数上限，输入继续可接着跑'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
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
    vi.mocked(executeToolWithTimeout).mockImplementation(async () => {
      execIdx++;
      return { content: `result-${execIdx}`, isError: false, timedOut: false };
    });
    try {
      const { events, callbacks } = harness();
      await runAgentLoop('', baseConfig, messages, callbacks);

      const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
      expect(notices.some(n => n.includes('无进展'))).toBe(false);
      expect(events.some(e => e.kind === 'complete')).toBe(true);
      expect(events.filter(e => e.kind === 'error')).toEqual([]);
    } finally {
      vi.mocked(executeToolWithTimeout).mockImplementation(async () => ({
        content: 'y'.repeat(1500),
        isError: false,
        timedOut: false,
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
      lines: ['hello', 'world'],
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

describe('runAgentLoop — 成本护栏', () => {
  let ledgerDir: string;
  let configDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky();
    resetCompressionState();
    resetSessionCost();
    // 账本重定向到临时目录，避免污染真实 ~/.shenlan/cost-ledger.json
    ledgerDir = mkdtempSync(join(tmpdir(), 'shenlan-repl-cost-'));
    process.env.SHENLAN_COST_LEDGER = join(ledgerDir, 'cost-ledger.json');
    // 全局配置重定向：调高上限的写回不触碰真实 ~/.shenlan/config.json
    configDir = mkdtempSync(join(tmpdir(), 'shenlan-repl-config-'));
    process.env.SHENLAN_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    delete process.env.SHENLAN_COST_LEDGER;
    delete process.env.SHENLAN_CONFIG_DIR;
    try { rmSync(ledgerDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('会话成本已达上限：不再调用 LLM，弹窗询问后按「停止」正常收尾', async () => {
    // flash 1M input = ¥0.28，先超过 0.01 的单会话上限
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    const confirmInfos: Array<{ kind: string; guardKind?: string }> = [];
    callbacks.onConfirm = async (info) => {
      confirmInfos.push({ kind: info.kind, guardKind: info.guardKind });
      return 'stop';
    };
    await runAgentLoop('', {
      ...baseConfig,
      costGuardrails: {
        enabled: true,
        maxCostPerSession: 0.01,
        maxCostPerDay: 20,
        currency: 'CNY',
      },
    }, messages, callbacks);

    expect(vi.mocked(chatStream)).not.toHaveBeenCalled();
    expect(confirmInfos).toEqual([{ kind: 'cost-guardrail', guardKind: 'session' }]);
    expect(events.some(e => e.kind === 'notice' && (e.detail || '').includes('成本护栏'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });

  it('成本弹窗选「继续」：waiveSession 放行并继续调用 LLM', async () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    installChatScript([() => textMsg('继续执行')]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    callbacks.onConfirm = async () => 'continue';
    await runAgentLoop('', {
      ...baseConfig,
      costGuardrails: {
        enabled: true,
        maxCostPerSession: 0.01,
        maxCostPerDay: 1000,
        currency: 'CNY',
      },
    }, messages, callbacks);

    // 豁免后调用 LLM 完成（不再被会话上限拦截）
    expect(vi.mocked(chatStream)).toHaveBeenCalled();
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });

  it('成本弹窗选 abort：终止任务', async () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    callbacks.onConfirm = async () => 'abort';
    await runAgentLoop('', {
      ...baseConfig,
      costGuardrails: { enabled: true, maxCostPerSession: 0.01, maxCostPerDay: 1000, currency: 'CNY' },
    }, messages, callbacks);

    expect(vi.mocked(chatStream)).not.toHaveBeenCalled();
    expect(events.some(e => e.kind === 'error' && (e.detail || '').includes('已终止'))).toBe(true);
  });

  it('成本弹窗输入新上限：校验后写回 config 并继续调用', async () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0);
    installChatScript([() => textMsg('继续')]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务' },
    ];
    const { events, callbacks } = harness();
    callbacks.onConfirm = async () => 'deny_feedback:50';
    const config: ShenlanConfig = {
      ...baseConfig,
      costGuardrails: { enabled: true, maxCostPerSession: 0.01, maxCostPerDay: 1000, currency: 'CNY' },
    };
    await runAgentLoop('', config, messages, callbacks);

    expect(config.costGuardrails?.maxCostPerSession).toBe(50);
    expect(vi.mocked(chatStream)).toHaveBeenCalled();
    expect(events.some(e => e.kind === 'complete')).toBe(true);
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

  it('无工具调用轮不结束：注入「继续执行」消息续跑，直到步数上限收尾', async () => {
    installChatScript([
      () => textMsg('我先看一下测试状态'),
      () => textMsg('继续推进中...'),
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '把全部测试跑绿' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 80, goalMaxSteps: 3 } }, messages, callbacks, undefined, goalParam);

    // 纯文本轮不会结束：goalMaxSteps=3 → 3 次调用后优雅收尾（goal 保持 active）
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(3);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.some(e => e.kind === 'notice' && (e.detail || '').includes('goal 步数上限'))).toBe(true);
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
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 80, goalMaxSteps: 300 } }, messages, callbacks, undefined, goalParam);

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
    await runAgentLoop('', { ...baseConfig, agent: { maxSteps: 80, goalMaxSteps: 300 } }, messages, callbacks, undefined, goalParam);

    const notices = events.filter(e => e.kind === 'notice').map(e => e.detail || '');
    expect(notices.some(n => n.includes('连续 3 轮无进展'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
  });

  it('goal 模式成本超限只预警不硬停（LLM 照常调用）', async () => {
    recordUsage('deepseek-v4-flash', 1_000_000, 0); // ¥0.28 超 0.01 会话上限
    installChatScript([() => textMsg('目标完成')]);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '目标' },
    ];
    const { events, callbacks } = harness();
    await runAgentLoop('', {
      ...baseConfig,
      costGuardrails: { enabled: true, maxCostPerSession: 0.01, maxCostPerDay: 20, currency: 'CNY' },
    }, messages, callbacks, undefined, goalParam);

    expect(vi.mocked(chatStream)).toHaveBeenCalled();
    expect(events.some(e => e.kind === 'notice' && (e.detail || '').includes('goal 模式仅预警'))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
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
