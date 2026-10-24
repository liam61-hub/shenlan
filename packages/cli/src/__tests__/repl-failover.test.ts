/**
 * LLM 调用故障转移 — 默认关闭 / 切换重试 / 无备用不切换 / 审计与 notice
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 同款 harness：mock chatStream/chat/工具执行，保留 core 真实实现
vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return {
    ...actual,
    chatStream: vi.fn(),
    chat: vi.fn().mockRejectedValue(new Error('mock: no network')),
    executeToolWithTimeout: vi.fn(async () => ({ content: 'ok', isError: false })),
    getAvailableTools: vi.fn(() => []),
    getTool: vi.fn(() => ({
      name: 'read', description: 'read', parameters: {},
      execute: async () => ({ content: '', isError: false }),
    })),
  };
});

import { chatStream } from '@shenlan/core';
import { runAgentLoop, resetStop } from '../repl.js';
import type { AgentCallbacks } from '../repl.js';
import { setMode } from '../mode.js';
import { resetSessionSticky, findFailoverTarget } from '../router.js';

function configWith(providerKeys: Record<string, string>, failoverEnabled: boolean): ShenlanConfig {
  return {
    model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
    permissions: { mode: 'bypassPermissions', allow: [], deny: [] },
    skills: [],
    mcpServers: [],
    providerKeys,
    agent: { maxSteps: 80 },
    context: {
      autoCompactTokenLimit: 200_000,
      keepRecentTurns: 20,
      toolOutputLimitChars: 8000,
      compactModel: 'deepseek-v4-flash',
    },
    providerFailover: { enabled: failoverEnabled },
  };
}

const textMsg = (content: string): Message => ({ role: 'assistant', content });

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

describe('LLM 调用故障转移（repl）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-failover-'));
    mkdirSync(join(tmp, '.shenlan'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    vi.clearAllMocks();
    resetStop();
    resetSessionSticky(); // 防止跨用例粘性残留（模块态）
    setMode('bypassPermissions');
  });

  afterEach(() => {
    setMode('default');
    vi.restoreAllMocks();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function errorCall(error: Error) {
    vi.mocked(chatStream).mockImplementation(
      (_cfg, _msgs, _tools, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onError(error));
        return Promise.resolve();
      },
    );
  }

  function successCall(content: string) {
    vi.mocked(chatStream).mockImplementation(
      (_cfg, _msgs, _tools, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onComplete(textMsg(content), { promptTokens: 10, completionTokens: 5 }));
        return Promise.resolve();
      },
    );
  }

  it('enabled=false（默认）：失败不重试，原错误上抛', async () => {
    errorCall(new Error('API error 500: internal error'));
    const { events, callbacks } = harness();
    await runAgentLoop('', configWith({ deepseek: 'sk-ds', qwen: 'sk-qwen' }, false),
      [{ role: 'user', content: '你好' }], callbacks);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.kind === 'error')).toBe(true);
  });

  it('enabled=true + 5xx：自动切备用重试成功，notice + 审计记录', async () => {
    // 第一次调用失败，第二次成功（备用 qwen-turbo）
    vi.mocked(chatStream)
      .mockImplementationOnce((_cfg, _msgs, _tools, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onError(new Error('API error 502: bad gateway')));
        return Promise.resolve();
      })
      .mockImplementationOnce((_cfg, _msgs, _tools, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onComplete(textMsg('备用成功'), { promptTokens: 10, completionTokens: 5 }));
        return Promise.resolve();
      });
    const { events, callbacks } = harness();
    await runAgentLoop('', configWith({ deepseek: 'sk-ds', qwen: 'sk-qwen' }, true),
      [{ role: 'user', content: '你好' }], callbacks);

    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(2);
    // 动态断言：第二次模型 ≠ 第一次，且等于 findFailoverTarget(第一次模型)
    // （真实价格下「你好」可能路由到任一 provider，断言不绑定具体模型名）
    const firstModel = (vi.mocked(chatStream).mock.calls[0]![0] as { model: string }).model;
    const secondModel = (vi.mocked(chatStream).mock.calls[1]![0] as { model: string }).model;
    expect(secondModel).not.toBe(firstModel);
    expect(secondModel).toBe(findFailoverTarget(firstModel, configWith({ deepseek: 'sk-ds', qwen: 'sk-qwen' }, true)));
    expect(events.some(e => e.kind === 'notice' && e.detail?.includes(secondModel))).toBe(true);
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    // 审计记录（tmp cwd 的 audit.jsonl）
    const auditPath = join(tmp, '.shenlan', 'audit.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    expect(readFileSync(auditPath, 'utf-8')).toContain('failover');
  });

  it('enabled=true + 备用无 key：不切换，原错误上抛', async () => {
    errorCall(new Error('API error 502: bad gateway'));
    const { events, callbacks } = harness();
    await runAgentLoop('', configWith({ deepseek: 'sk-ds' }, true),
      [{ role: 'user', content: '你好' }], callbacks);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.kind === 'error')).toBe(true);
  });

  it('enabled=true + 4xx 参数错误：不切换（错误在请求侧）', async () => {
    errorCall(new Error('API error 400: bad request'));
    const { callbacks } = harness();
    await runAgentLoop('', configWith({ deepseek: 'sk-ds', qwen: 'sk-qwen' }, true),
      [{ role: 'user', content: '你好' }], callbacks);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(1);
  });

  it('瞬时网络错误（fetch failed）：同 provider 自动重试一次成功（无需故障转移开关）', async () => {
    vi.mocked(chatStream)
      .mockImplementationOnce((_cfg, _msgs, _tools, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onError(new Error('fetch failed')));
        return Promise.resolve();
      })
      .mockImplementationOnce((_cfg, _msgs, _tools, cb: StreamCallbacks): Promise<void> => {
        setImmediate(() => cb.onComplete(textMsg('重试成功'), { promptTokens: 10, completionTokens: 5 }));
        return Promise.resolve();
      });
    const { events, callbacks } = harness();
    await runAgentLoop('', configWith({ deepseek: 'sk-ds' }, false),
      [{ role: 'user', content: '你好' }], callbacks);

    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(2);
    const m0 = (vi.mocked(chatStream).mock.calls[0]![0] as { model: string }).model;
    const m1 = (vi.mocked(chatStream).mock.calls[1]![0] as { model: string }).model;
    expect(m1).toBe(m0); // 同 provider 重试
    expect(events.some(e => e.kind === 'complete')).toBe(true);
    expect(events.some(e => e.kind === 'error')).toBe(false);
  });

  it('网络错误重试仍失败：原错误上抛', async () => {
    errorCall(new Error('fetch failed'));
    const { events, callbacks } = harness();
    await runAgentLoop('', configWith({ deepseek: 'sk-ds' }, false),
      [{ role: 'user', content: '你好' }], callbacks);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(2);
    expect(events.some(e => e.kind === 'error')).toBe(true);
  });

  it('服务端 5xx 不触发同 provider 重试（只走故障转移路径）', async () => {
    errorCall(new Error('API error 502: bad gateway'));
    const { callbacks } = harness();
    await runAgentLoop('', configWith({ deepseek: 'sk-ds' }, false),
      [{ role: 'user', content: '你好' }], callbacks);
    expect(vi.mocked(chatStream)).toHaveBeenCalledTimes(1);
  });
});
