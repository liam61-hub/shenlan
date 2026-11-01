import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink';
import type { ShenlanConfig } from '@shenlan/core';
import type { AgentCallbacks } from '../repl.js';
import type { AppAction, AppState } from '../context.js';
import { baseState, makeTtyStream, TuiHarness } from './scrollback-harness.js';
import { reducer } from '../app.js';
import { useAgentLoop } from '../hooks/useAgentLoop.js';
import { shellActivities } from '../shell-activity.js';

vi.mock('../repl.js', async importOriginal => ({
  ...await importOriginal<typeof import('../repl.js')>(), runAgentLoop: vi.fn(),
}));
import { runAgentLoop } from '../repl.js';

const config: ShenlanConfig = {
  model: { baseUrl: 'http://localhost', apiKey: '', model: 'test', maxTokens: 100 },
  permissions: { mode: 'bypassPermissions', allow: [], deny: [] }, skills: [], mcpServers: [],
};

function Runner({ state, dispatch }: { state: AppState; dispatch: React.Dispatch<AppAction> }) {
  useAgentLoop({ state, dispatch, config, model: 'test' });
  return null;
}

afterEach(() => { vi.clearAllMocks(); });

describe('tool lifecycle in live scrollback', () => {
  it('records starts and decisive results immediately, without waiting for another tool', async () => {
    let callbacks: AgentCallbacks | undefined;
    let release: (() => void) | undefined;
    vi.mocked(runAgentLoop).mockImplementation(async (_input, _config, _messages, cb) => {
      callbacks = cb;
      await new Promise<void>(resolve => { release = resolve; });
    });
    let state = baseState();
    const dispatch = (action: AppAction) => { state = reducer(state, action); };
    const app = render(<Runner state={state} dispatch={dispatch} />, {
      stdout: makeTtyStream('stdout'), stdin: makeTtyStream('stdin'), patchConsole: false, exitOnCtrlC: false,
    });
    try {
      state = baseState({ submitSeq: 1, messages: [{ role: 'user', content: 'work' }] });
      app.rerender(<Runner state={state} dispatch={dispatch} />);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      const cb = callbacks!;
      for (const [id, command, output, failed] of [
        ['test1', 'cargo test', 'test result: FAILED. 4 passed; 1 failed', true],
        ['test2', 'cargo test', 'test result: ok. 5 passed; 0 failed', false],
        ['commit', 'git commit -m fix', 'Scan passed\n[main f3714bc] test: cover try_files', false],
      ] as const) {
        const activities = shellActivities(command);
        cb.onToolStart(id, 'shell', command, command);
        cb.onShellActivity?.({ id, activities, phase: 'started' });
        expect(state.history.at(-1)?.content).toContain(`${command.startsWith('git') ? 'git commit' : command} started`);
        cb.onShellActivity?.({ id, activities, phase: 'finished', output, failed });
        if (failed) cb.onToolError(id, 'shell', output);
        else cb.onToolDone(id, 'shell', command, output);
        expect(state.history.at(-1)?.content).toContain(output.split('\n').at(-1));
      }
      cb.onToolStart('progress', 'task_progress', '');
      cb.onToolDone('progress', 'task_progress', '', 'Progress recorded: commit passed — S1');
      expect(state.history.at(-1)?.content).toContain('commit passed');

      const stdout = makeTtyStream('stdout');
      const chunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      const terminal = render(<TuiHarness state={state} />, {
        stdout, stdin: makeTtyStream('stdin'), patchConsole: false, exitOnCtrlC: false,
      });
      terminal.unmount();
      const bytes = Buffer.concat(chunks).toString('utf8');
      expect(bytes).toContain('git commit started');
      expect(bytes).toContain('f3714bc');
      expect(bytes).toContain('cargo test failed');
      expect(bytes).toContain('5 passed');
      expect(bytes).not.toContain('\x1b[3J');
      expect(state.history.filter(item => item.content === 'cargo test started')).toHaveLength(2);
    } finally {
      release?.();
      app.unmount();
    }
  });
});
