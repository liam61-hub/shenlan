/**
 * 头部 logo —— 村民头（Claude Code 画法：背景色涂块 + 角字形），2026-10-05
 *
 * 守死三条，防止再退回"缺字形 → 空心"的老路：
 *  1. 实心块**只用背景色**画：输出含青色背景序列（`46m`），且**不含** `█▐▌│▀▄…` 等整块字形；
 *  2. 字形使用发用的半长竖线 `╷`（U+2577，只占下半格）、腿角字形 `▘▝` 和圆点眼睛 `•`；
 *  3. 配色为原来的村民青（前景 `36m` / 背景 `46m`）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import React from 'react';
import chalk from 'chalk';
import type { ShenlanConfig } from '@shenlan/core';
import { StatusBar } from '../components/StatusBar.js';
import { AppContext } from '../context.js';
import type { AppContextType } from '../context.js';
import { baseState, makeTtyStream } from './scrollback-harness.js';
import { displayWidth } from '../markdown-utils.js';

/** 村民青，必须与 StatusBar 的 LOGO_COLOR 一致 */
const CYAN_FG = '\x1b[36m';
const CYAN_BG = '\x1b[46m';

/** 会"缺字形"的整块/半块/方框类码位（这些就是旧版空心的元凶）。 */
const BLOCKY = /[█▐▌▀▄▛▜▙▟░▒▓▚▞]/;

/** 允许出现的非 ASCII 字符：发 `╷`、腿角字形 `▘▝`、圆点眼睛 `•` 和信息行中点 `·` */
const ALLOWED_NON_ASCII = new Set(['╷', '▘', '▝', '•', '·']);

const testConfig: ShenlanConfig = {
  model: { baseUrl: 'http://localhost', apiKey: 'test', model: 'test', maxTokens: 100 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
};

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function renderStatusBar(termWidth = 120): string {
  const stdout = makeTtyStream('stdout');
  const stdin = makeTtyStream('stdin');
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const ctx = {
    config: testConfig,
    mode: 'default',
    model: 'deepseek-v4-flash',
    termWidth,
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

describe('StatusBar logo — 紧凑村民头（背景色涂块）', () => {
  it('实心脸用背景色画，字形里无方块字符', () => {
    const raw = withChalkLevel(3, renderStatusBar);
    // 实心脸以青色背景起止
    expect(raw.match(/\x1b\[46m/g)?.length).toBeGreaterThan(0);
    expect(raw.match(/\x1b\[49m/g)?.length).toBe(raw.match(/\x1b\[46m/g)?.length);
    // 两颗圆点眼睛（• 共出现 2 次）
    expect([...stripAnsi(raw)].filter(c => c === '•')).toHaveLength(2);
    // 绝不使用整块/半块字形
    expect(raw).not.toMatch(BLOCKY);
  });

  it('字形使用短发`╷` / 腿`▘▝` / 眼`•`（外加信息行的 `·`），配色为村民青', () => {
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

  it('logo 保留腿并压缩到三行八列，信息仍分三行显示', () => {
    const clean = stripAnsi(withChalkLevel(3, renderStatusBar));
    expect([...clean].filter(c => c === '╷')).toHaveLength(6);
    expect([...clean].filter(c => c === '▘')).toHaveLength(2);
    expect([...clean].filter(c => c === '▝')).toHaveLength(2);
    expect(clean).toContain('SHENLAN');
    expect(clean).toContain('deepseek-v4-flash');
    expect(clean).toContain(process.cwd());
  });

  it('信息行照常渲染在 logo 右侧', () => {
    const raw = withChalkLevel(3, renderStatusBar);
    expect(raw).toContain('SHENLAN');
    expect(raw).toContain('v0.4.88');
    expect(raw).toContain('deepseek-v4-flash');
    expect(raw).toContain('NORMAL');
  });
});

it('keeps long working-directory paths below the terminal width', () => {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/' + 'long-directory-name/'.repeat(10));
  try {
    const text = stripAnsi(withChalkLevel(3, () => renderStatusBar(60)));
    expect(text).toContain('SHENLAN');
    expect(text).toContain('/tmp/');
    for (const line of text.split('\n')) expect(displayWidth(line)).toBeLessThan(60);
  } finally { cwd.mockRestore(); }
});
