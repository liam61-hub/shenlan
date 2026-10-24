/**
 * /model 面板分组展示测试：
 *  - computePanelWindow 纯函数：组标题行计入高度预算、选中行保持在窗口内
 *  - TuiHarness 渲染：组标题出现、编号连续无跳号、不触发整屏清屏
 */
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import React from 'react';
import { baseState, TuiHarness, makeTtyStream } from './scrollback-harness.js';
import type { ModelOption } from '../context.js';
import { computePanelWindow } from '../components/ModelPanel.js';

function makeOptions(): ModelOption[] {
  const base = {
    contextWindow: 128000, available: true, current: false, tag: '', priceText: '',
  };
  return [
    { kind: 'auto', model: 'Default', provider: 'auto', group: '自动路由', ...base },
    { kind: 'model', model: 'deepseek-v4-flash', provider: 'deepseek', group: 'DeepSeek（官方 API）', ...base },
    { kind: 'model', model: 'deepseek-v4-pro', provider: 'deepseek', group: 'DeepSeek（官方 API）', ...base },
    { kind: 'model', model: 'deepseek-v4-pro-0813', provider: 'bailian', group: '百炼 DashScope', ...base },
    { kind: 'model', model: 'qwen-turbo', provider: 'qwen', group: '百炼 DashScope', ...base },
    { kind: 'model', model: 'qwen3.8-max', provider: 'qwen', group: '百炼 DashScope', ...base },
  ];
}

/** 窗口 [start, start+count) 内的标题行 + 组前空白行（与组件内预算逻辑一致） */
function extraRowsInWindow(models: ModelOption[], start: number, count: number): number {
  const isGroupStart = (i: number) => i === 0 || models[i]!.group !== models[i - 1]!.group;
  let headers = 0;
  for (let i = start; i < start + count; i++) {
    if (isGroupStart(i)) headers++;
  }
  if (headers === 0) return 0;
  return headers * 2 - (isGroupStart(start) ? 1 : 0);
}

describe('computePanelWindow — 组标题行计入面板高度预算', () => {
  it('窗口内模型行 + 组标题行 + 组前空白行不超过 rowBudget', () => {
    const models = makeOptions(); // 6 模型行、3 个组首（自动路由 / 官方 / 百炼）
    for (const budget of [1, 3, 5, 8, 20]) {
      for (const sel of [0, 2, 5]) {
        const w = computePanelWindow(models, sel, budget);
        expect(w.count + extraRowsInWindow(models, w.start, w.count)).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('选中行保持在窗口内', () => {
    const models = makeOptions();
    for (const sel of [0, 1, 3, 5]) {
      const w = computePanelWindow(models, sel, 4);
      expect(sel).toBeGreaterThanOrEqual(w.start);
      expect(sel).toBeLessThan(w.start + w.count);
    }
  });

  it('窗口充足时展示全部模型行（start=0，count=n）', () => {
    const models = makeOptions();
    const w = computePanelWindow(models, 3, 20);
    expect(w).toEqual({ start: 0, count: models.length });
  });

  it('无模型时返回空窗口', () => {
    expect(computePanelWindow([], 0, 8)).toEqual({ start: 0, count: 0 });
  });
});

describe('ModelPanel 渲染 — 分组展示', () => {
  it('组标题行显示、模型编号连续无跳号、不触发整屏清屏', async () => {
    const stdout = makeTtyStream('stdout');
    // 必须传假 stdin：CI（无 TTY）下 process.stdin 不支持 raw mode，Ink 会渲染错误页
    // 而不是应用内容（与 scrollback.test.ts 同款处理）
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const state = baseState({ modelPanel: { models: makeOptions(), selected: 2 } });
    const { unmount } = render(React.createElement(TuiHarness, { state, termHeight: 30, termWidth: 100 }), {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
      // 必须显式 interactive: true：Ink 默认按 isInteractive(stdout, stdin) 推断，
      // 假 stdin 无 isTTY → POSIX（Ubuntu CI）判为非交互，主输出不渲染
      // （Windows 判定路径不同恰好为 true，本地才不暴露；与 scrollback.test 同款）
      interactive: true,
    });

    // Ink 分帧输出：静态区（StatusBar）与动态区（面板）可能分多次 write，
    // 不能拿到第一个 chunk 就断言——等面板组标题真正出现（或超时）
    const deadline = Date.now() + 3000;
    let raw = '';
    while (Date.now() < deadline) {
      raw = Buffer.concat(chunks).toString('utf8');
      if (raw.includes('DeepSeek（官方 API）')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    unmount();
    // 去掉 ANSI 控制码后断言文本
    const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
    expect(plain).toContain('DeepSeek（官方 API）');
    expect(plain).toContain('百炼 DashScope');
    // 百炼组只出现一个标题行（deepseek 快照 + qwen 同组）
    expect(plain.match(/百炼 DashScope/g)).toHaveLength(1);
    // 组标题前有空白分隔行（窗口顶部的自动路由组除外）
    expect(plain).toContain('\n\n  百炼 DashScope');
    // 6 个模型行编号连续（组标题行不占编号）
    for (const num of ['1.', '2.', '3.', '4.', '5.', '6.']) {
      expect(plain).toContain(num);
    }
    expect(raw).not.toContain('\x1b[2J');
    expect(raw).not.toContain('\x1b[3J');
  });
});
