/**
 * 坑记忆反馈闭环 — hard 动作前拦截 + hits 递增 + 错误自动记录 + 升级提示
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, ShenlanConfig, StreamCallbacks } from '@shenlan/core';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  pitfallMemory: { injectTopN: 5, searchBeforeAction: true, autoRecordOnError: true },
};

const shellCall = (command: string): Message => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } }],
});

const textMsg = (content: string): Message => ({ role: 'assistant', content });

function installChatScript(script: Array<() => Message>): void {
  let idx = 0;
  vi.mocked(chatStream).mockImplementation(
    (_cfg: unknown, _msgs: unknown, _tools: unknown, cb: StreamCallbacks): Promise<void> => {
      const msg = script[idx] ? script[idx]() : textMsg('(end)');
      idx++;
      setImmediate(() => cb.onComplete(msg, { promptTokens: 10, completionTokens: 5 }));
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

describe('坑记忆反馈闭环（repl 流程）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-pf-flow-'));
    mkdirSync(join(tmp, '.shenlan'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    vi.clearAllMocks();
    resetStop();
    setMode('bypassPermissions');
  });

  afterEach(() => {
    setMode('default');
    vi.restoreAllMocks();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writePitfalls(content: string): string {
    const p = join(tmp, '.shenlan', 'pitfalls.md');
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('hard 坑动作前拦截（结构化 severity）并 hits+1', async () => {
    const pf = writePitfalls(
      '# push 前先检查 remote\nseverity: hard\nhits: 0\ntrigger: git push\n正文',
    );
    installChatScript([() => shellCall('git push origin main'), () => textMsg('(end)')]);
    const { events, callbacks } = harness();

    await runAgentLoop('', baseConfig, [{ role: 'user', content: '推代码' }], callbacks);

    const raw = readFileSync(pf, 'utf-8');
    expect(raw).toContain('hits: 1');
    expect(vi.mocked(executeToolWithTimeout)).not.toHaveBeenCalled();
    expect(events.map(e => e.kind)).toContain('complete');
  });

  it('工具失败且错误匹配已知 trigger：hits+1 并 notice', async () => {
    const pf = writePitfalls(
      '# npm 私服偶发 401\nseverity: soft\nhits: 1\ntrigger: npm install, 401\n正文',
    );
    vi.mocked(executeToolWithTimeout).mockResolvedValue({ timedOut: false,
      content: 'npm install 失败：401 Unauthorized from registry',
      isError: true,
    });
    installChatScript([() => shellCall('npm install lodash'), () => textMsg('(end)')]);
    const { events, callbacks } = harness();

    await runAgentLoop('', baseConfig, [{ role: 'user', content: '装依赖' }], callbacks);

    expect(readFileSync(pf, 'utf-8')).toContain('hits: 2');
    expect(events.some(e => e.kind === 'notice' && e.detail?.includes('npm 私服偶发 401'))).toBe(true);
  });

  it('autoRecordOnError=false 时错误不递增', async () => {
    const pf = writePitfalls(
      '# npm 私服偶发 401\nseverity: soft\nhits: 1\ntrigger: npm install\n正文',
    );
    vi.mocked(executeToolWithTimeout).mockResolvedValue({ timedOut: false,
      content: 'npm install 失败：401',
      isError: true,
    });
    installChatScript([() => shellCall('npm install lodash'), () => textMsg('(end)')]);
    const { callbacks } = harness();

    await runAgentLoop('', { ...baseConfig, pitfallMemory: { injectTopN: 5, searchBeforeAction: true, autoRecordOnError: false } },
      [{ role: 'user', content: '装依赖' }], callbacks);

    expect(readFileSync(pf, 'utf-8')).toContain('hits: 1');
    expect(readFileSync(pf, 'utf-8')).not.toContain('hits: 2');
  });

  it('soft 坑 hits 达 3：提示可升级 hard（不自动升级）', async () => {
    const pf = writePitfalls(
      '# 老坑\nseverity: soft\nhits: 2\ntrigger: npm install\n正文',
    );
    vi.mocked(executeToolWithTimeout).mockResolvedValue({ timedOut: false,
      content: 'npm install 失败：网络错误',
      isError: true,
    });
    installChatScript([() => shellCall('npm install x'), () => textMsg('(end)')]);
    const { events, callbacks } = harness();

    await runAgentLoop('', baseConfig, [{ role: 'user', content: '装依赖' }], callbacks);

    expect(readFileSync(pf, 'utf-8')).toContain('hits: 3');
    expect(events.some(e => e.kind === 'notice' && e.detail?.includes('升级为 hard'))).toBe(true);
    expect(readFileSync(pf, 'utf-8')).toContain('severity: soft'); // 未自动升级
  });

  it('旧格式条目（无 trigger 字段）：正文包含命令仍拦截（向后兼容）', async () => {
    const pf = writePitfalls(
      '# 旧格式坑\nseverity: hard\nnpm publish 之前必须先跑 npm run build\n',
    );
    installChatScript([() => shellCall('npm publish'), () => textMsg('(end)')]);
    const { callbacks } = harness();

    await runAgentLoop('', baseConfig, [{ role: 'user', content: '发布' }], callbacks);

    expect(readFileSync(pf, 'utf-8')).toContain('hits: 1');
    expect(vi.mocked(executeToolWithTimeout)).not.toHaveBeenCalled();
  });
});
