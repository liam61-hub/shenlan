/**
 * /config 交互面板渲染测试：
 *  - TuiHarness 渲染：列表行出现、选中行详情（描述+允许取值）、掩码值不回显明文
 *  - 编辑模式渲染输入提示与页脚
 *  - 全程不触发整屏清屏（\x1b[2J / \x1b[3J）
 */
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import React from 'react';
import { baseState, TuiHarness, makeTtyStream } from './scrollback-harness.js';
import type { ConfigRow } from '../commands/config.js';

function makeRows(): ConfigRow[] {
  return [
    { key: 'actionSafety.auditEnabled', kind: 'boolean', display: 'true', raw: 'true', source: 'default', description: 'Action-level audit events', secret: false },
    { key: 'agent.maxSteps', kind: 'number', display: '80', raw: '80', source: 'default', description: 'Agent loop max steps', secret: false },
    { key: 'costGuardrails.enabled', kind: 'boolean', display: 'true', raw: 'true', source: 'default', description: 'Cost guardrails master switch', secret: false },
    { key: 'permissions.mode', kind: 'enum', display: 'default', raw: 'default', source: 'default', description: 'Permission mode', allowedValues: ['default', 'acceptEdits', 'bypassPermissions'], secret: false },
    { key: 'providerKeys.deepseek', kind: 'string', display: 'sk-1****7890', raw: 'sk-1234567890', source: 'global', description: 'API key per provider', secret: true },
  ];
}

/** 渲染面板并等待目标文本出现（Ink 静态/动态分帧写，不能拿到首个 chunk 就断言） */
async function renderPanel(state: ReturnType<typeof baseState>, waitFor: string): Promise<{ raw: string; plain: string }> {
  const stdout = makeTtyStream('stdout');
  const stdin = makeTtyStream('stdin');
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const { unmount } = render(React.createElement(TuiHarness, { state, termHeight: 30, termWidth: 100 }), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
    // 显式 interactive：假 stdin 无 isTTY 时 POSIX 判为非交互，主输出不渲染
    interactive: true,
  });
  const deadline = Date.now() + 3000;
  let raw = '';
  while (Date.now() < deadline) {
    raw = Buffer.concat(chunks).toString('utf8');
    if (raw.includes(waitFor)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  unmount();
  const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  return { raw, plain };
}

describe('ConfigPanel 渲染 — /config 交互面板', () => {
  it('列表行 + 选中行详情渲染，掩码值不回显明文，无整屏清屏', async () => {
    const state = baseState({
      configPanel: { rows: makeRows(), selected: 3, editing: false, editText: '', scope: 'project' },
    });
    const { raw, plain } = await renderPanel(state, 'permissions.mode');
    expect(plain).toContain('Config');
    expect(plain).toContain('agent.maxSteps');
    expect(plain).toContain('providerKeys.deepseek');
    expect(plain).toContain('sk-1****7890');
    // 选中行详情：描述 + 允许取值
    expect(plain).toContain('Permission mode');
    expect(plain).toContain('default / acceptEdits / bypassPermissions');
    // 编辑预填的原始明文绝不出现
    expect(plain).not.toContain('sk-1234567890');
    expect(raw).not.toContain('\x1b[2J');
    expect(raw).not.toContain('\x1b[3J');
  });

  it('编辑模式渲染输入提示与页脚（提示行不重复），无整屏清屏', async () => {
    const state = baseState({
      configPanel: { rows: makeRows(), selected: 1, editing: true, editText: '120', scope: 'project' },
    });
    const { raw, plain } = await renderPanel(state, 'agent.maxSteps');
    expect(plain).toContain('Edit agent.maxSteps');
    expect(plain).toContain('120');
    // 编辑模式页脚只出现一次（修复重复提示行）
    const count = (plain.match(/Enter save/g) || []).length;
    expect(count).toBe(1);
    expect(raw).not.toContain('\x1b[2J');
    expect(raw).not.toContain('\x1b[3J');
  });
});
