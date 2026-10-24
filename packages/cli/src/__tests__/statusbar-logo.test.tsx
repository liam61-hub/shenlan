/**
 * 头部 logo —— 村民头（Claude Code 画法：背景色涂块 + 角字形），2026-10-05
 *
 * 守死三条，防止再退回"缺字形 → 空心"的老路：
 *  1. 实心块**只用背景色**画：输出含青色背景序列（`46m`），且**不含** `█▐▌│▀▄…` 等整块字形；
 *  2. 字形只用四象限角 `▗ ▖ ▘ ▝`（Claude Code logo 同款，已验证可渲染）+ 圆点眼睛 `•`
 *     + 发用的半长竖线 `╷`（U+2577，只占下半格）；
 *  3. 配色为原来的村民青（前景 `36m` / 背景 `46m`）。
 */
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import React from 'react';
import chalk from 'chalk';
import type { ShenlanConfig } from '@shenlan/core';
import { StatusBar } from '../components/StatusBar.js';
import { AppContext } from '../context.js';
import type { AppContextType } from '../context.js';
import { baseState, makeTtyStream } from './scrollback-harness.js';

/** 村民青，必须与 StatusBar 的 LOGO_COLOR 一致 */
const CYAN_FG = '\x1b[36m';
const CYAN_BG = '\x1b[46m';

/** 会"缺字形"的整块/半块/方框类码位（这些就是旧版空心的元凶）。
 *  注：`│`(U+2502) 不在其列 —— 发有意用它（竖线位于格子正中、天然居中）。 */
const BLOCKY = /[█▐▌▀▄▛▜▙▟░▒▓▚▞]/;

/** 允许出现的非 ASCII 字符：发 `╷`（半长竖线）+ 腿角字形 `▘▝` + 圆点眼睛 `•` + 信息行的中点 `·` */
const ALLOWED_NON_ASCII = new Set(['╷', '│', '▗', '▖', '▘', '▝', '•', '·']);

const testConfig: ShenlanConfig = {
  model: { baseUrl: 'http://localhost', apiKey: 'test', model: 'test', maxTokens: 100 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
};

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function renderStatusBar(): string {
  const stdout = makeTtyStream('stdout');
  const stdin = makeTtyStream('stdin');
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const ctx = {
    config: testConfig,
    mode: 'default',
    model: 'deepseek-v4-flash',
    termWidth: 120,
    termHeight: 40,
    state: baseState(),
    dispatch: (() => {}) as unknown as AppContextType['dispatch'],
  } satisfies AppContextType;
  const { unmount } = render(
    React.createElement(
      AppContext.Provider,
      { value: ctx },
      React.createElement(StatusBar, { version: '0.4.88' }),
    ),
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  unmount();
  return chunks.map(c => c.toString('utf8')).join('');
}

function withChalkLevel<T>(level: 0 | 1 | 2 | 3, fn: () => T): T {
  const prev = chalk.level;
  chalk.level = level;
  try { return fn(); } finally { chalk.level = prev; }
}

describe('StatusBar logo — 村民头（背景色涂块 + 角字形）', () => {
  it('实心块用背景色画（脸行 + 下巴行），字形里无方块字符', () => {
    const raw = withChalkLevel(3, renderStatusBar);
    // 两行实心（脸、下巴）各以青色背景起止
    expect(raw.match(/\x1b\[46m/g)).toHaveLength(2);
    expect(raw.match(/\x1b\[49m/g)).toHaveLength(2);
    // 两颗圆点眼睛（• 共出现 2 次）
    expect([...stripAnsi(raw)].filter(c => c === '•')).toHaveLength(2);
    // 绝不使用整块/半块字形
    expect(raw).not.toMatch(BLOCKY);
  });

  it('字形只用 发`╷` / 腿`▘▝` / 眼`•`（外加信息行的 `·`），配色为村民青', () => {
    const raw = withChalkLevel(3, renderStatusBar);
    const clean = stripAnsi(raw);
    const nonAscii = [...new Set([...clean])].filter(c => c.charCodeAt(0) > 0x7e);
    for (const c of nonAscii) {
      expect(ALLOWED_NON_ASCII.has(c)).toBe(true);
    }
    // 角字形用村民青前景、实心块用村民青背景
    expect(raw).toContain(CYAN_FG);
    expect(raw).toContain(CYAN_BG);
  });

  it('信息行照常渲染，且与 logo 对齐（logo 之后有文本）', () => {
    const raw = withChalkLevel(3, renderStatusBar);
    expect(raw).toContain('SHENLAN');
    expect(raw).toContain('v0.4.88');
    expect(raw).toContain('deepseek-v4-flash');
    expect(raw).toContain('NORMAL');
  });
});
