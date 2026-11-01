import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import React from 'react';
import chalk from 'chalk';
import { baseState, TuiHarness, LiveTuiHarness, makeTtyStream } from './scrollback-harness.js';
import type { AppState } from '../context.js';
import { SLASH_COMMANDS } from '../slash-commands.js';
import { buildConfirmOptions, buildConfirmTitle } from '../confirm-options.js';

// Ink 用 chalk 上色；非 TTY 环境下 chalk.level=0 会静默去掉 ANSI 码，
// 强制 level=1 让「错误行红色」断言可复现。
chalk.level = 1;

const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';
const tree = (state: AppState) => React.createElement(TuiHarness, { state });

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timeout');
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('原生滚动回滚区（<Static> + 有界动态区）', () => {
  it('用户消息使用 cyan 圆点和加粗正文，无背景、无独立 You 标题且无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const { unmount } = render(tree(baseState({
      history: [{ key: 'u1', role: 'user', content: '第一行\n第二行', ts: 1 }],
    })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain('\x1b[100m');
    expect(bytes).not.toContain('\x1b[7m');
    expect(bytes).not.toContain('❯ You');
    expect(bytes).toContain('\x1b[36m●\x1b[39m');
    expect(bytes).toContain('\x1b[1m 第一行\x1b[22m');
    expect(countOccurrences(bytes, '●')).toBe(1);
    expect(countOccurrences(bytes, '第一行')).toBe(1);
    expect(countOccurrences(bytes, '第二行')).toBe(1);
    expect(bytes).not.toContain(CLEAR_TERMINAL);
  });

  it('非空闲阶段无 tail/运行中工具时持续显示 working，已有内容时由内容覆盖', () => {
    const renderBytes = (state: AppState): string => {
      const stdout = makeTtyStream('stdout');
      const stdin = makeTtyStream('stdin');
      const chunks: Buffer[] = [];
      stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      const { unmount } = render(tree(state), {
        stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
      });
      unmount();
      return Buffer.concat(chunks).toString('utf8');
    };

    expect(renderBytes(baseState({ phase: 'streaming' }))).toContain('working');
    expect(renderBytes(baseState({ phase: 'tools' }))).toContain('working');
    expect(renderBytes(baseState({ phase: 'idle' }))).not.toContain('working');
    const withTail = renderBytes(baseState({ phase: 'streaming', streamingTail: 'partial' }));
    expect(withTail).toContain('partial');
    expect(withTail).not.toContain('working');
    const thinkingWithTail = renderBytes(baseState({ phase: 'thinking', streamingTail: 'pending' }));
    expect(thinkingWithTail).toContain('pending');
    expect(thinkingWithTail).not.toContain('working');
  });

  it('工具步骤与结果按两行固化，各出现一次且无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const state = baseState({
      history: [
        {
          key: 'tool-step-call-1',
          role: 'tool-step',
          content: '',
          toolStep: {
            id: 'call-1', name: 'read', detail: 'src/a.ts', outcome: 'done', durationMs: 250,
          },
        },
        { key: 'tool-call-1', role: 'tool', content: 'read a.ts: 12 lines' },
      ],
    });
    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    const clean = bytes.replace(/\x1b\[[0-9;]*m/g, '');
    expect(countOccurrences(clean, 'read src/a.ts')).toBe(1);
    expect(countOccurrences(clean, 'read a.ts: 12 lines')).toBe(1);
    expect(clean.indexOf('read src/a.ts')).toBeLessThan(clean.indexOf('read a.ts: 12 lines'));
    expect(bytes).not.toContain(CLEAR_TERMINAL);
  });

  it('已完成消息写入静态输出：每行只出现一次，且永不触发整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      history: [
        { key: 'u1', role: 'user', content: 'hello world', ts: 1 },
        { key: 'l1', role: 'assistant-line', content: 'line one' },
        { key: 'l2', role: 'assistant-line', content: 'line two' },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 静态内容在滚回区中恰好出现一次
    expect(countOccurrences(bytes, 'hello world')).toBe(1);
    expect(countOccurrences(bytes, 'line one')).toBe(1);
    expect(countOccurrences(bytes, 'line two')).toBe(1);
    // 输入框（动态帧）存在
    expect(bytes).toContain('❯');
  });

  it('常驻状态行：模型 · 模式 · 工作目录始终可见，且无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const { unmount } = render(tree(baseState()), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    // 输入框（动态帧）单次写入：提示符恰好出现一次
    expect(countOccurrences(bytes, '❯')).toBe(1);
    // 状态行段（dim model 段 + dim cwd 段）恰好出现一次；
    // 静态头部 StatusBar 也含 model/cwd，但无「model · 」前缀组合，不会误匹配
    expect(countOccurrences(bytes, 'test-model · ')).toBe(1);
    expect(countOccurrences(bytes, ` · ${process.cwd()}`)).toBe(1);
    // 状态行位于输入框提示符之后（StatusBar 的 cwd 在其之前）
    expect(bytes.indexOf(` · ${process.cwd()}`)).toBeGreaterThan(bytes.indexOf('❯'));
  });

  it('流式整行增量写入：新行追加一次，完成后不重复', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const app = render(tree(baseState({ streamingTail: 'partial' })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });

    // 前两行完成，进入静态列表；tail 仍为未完成行
    app.rerender(tree(baseState({
      history: [
        { key: 'l0', role: 'assistant-line', content: 'hello' },
        { key: 'l1', role: 'assistant-line', content: 'world' },
      ],
      streamingTail: 'partial',
    })));

    // COMPLETE：tail 落为最后一行静态项
    app.rerender(tree(baseState({
      history: [
        { key: 'l0', role: 'assistant-line', content: 'hello' },
        { key: 'l1', role: 'assistant-line', content: 'world' },
        { key: 'l2', role: 'assistant-line', content: 'partial' },
      ],
      streamingTail: '',
    })));
    app.unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    // 静态行只写一次（hello/world 不在动态区，出现次数 = 静态写入次数）
    expect(countOccurrences(bytes, 'hello')).toBe(1);
    expect(countOccurrences(bytes, 'world')).toBe(1);
    // 完成后 tail 冻结进静态内容（作为最后一行追加）
    expect(bytes).toContain('partial');
  });

  it('实时表格缓冲为静态块：Codex 风格分隔线一次出现，无整屏清屏，无裸管道行', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      history: [
        {
          key: 'b1',
          role: 'assistant-block' as const,
          blockKind: 'table' as const,
          content: '| 阶段 | 状态 |\n|---|---|\n| 初始化 | ⏳ 进行中 |\n| 收尾 | ⬛ 待办 |',
        },
        { key: 'l1', role: 'assistant-line', content: '完成' },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // Codex 风格（表头重线 + 行间轻线）而非盒子边框/裸管道行
    expect(bytes).toContain('━');
    expect(bytes).toContain('─');
    expect(bytes).not.toContain('┌');
    expect(bytes).not.toContain('└');
    expect(bytes).not.toContain('| 阶段 | 状态 |');
    // 块内容（含 emoji 列）恰好出现一次
    expect(countOccurrences(bytes, '阶段')).toBe(1);
    expect(countOccurrences(bytes, '⏳')).toBe(1);
    expect(countOccurrences(bytes, '⬛')).toBe(1);
  });

  it('空行恢复：assistant-line 空内容渲染为空白行，不跳过后续内容', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      history: [
        { key: 'l1', role: 'assistant-line', content: 'before' },
        { key: 'l2', role: 'assistant-line', content: '' },
        { key: 'l3', role: 'assistant-line', content: 'after' },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(countOccurrences(bytes, 'before')).toBe(1);
    expect(countOccurrences(bytes, 'after')).toBe(1);
    expect(bytes.indexOf('after')).toBeGreaterThan(bytes.indexOf('before'));
  });

  it('流式行级格式：标题去 #、有序列表保留序号、任务列表渲染 ☐/☑', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      history: [
        { key: 'h1', role: 'assistant-line', content: '# 大标题' },
        { key: 'o1', role: 'assistant-line', content: '1. 第一步' },
        { key: 't1', role: 'assistant-line', content: '- [x] 已完成' },
        { key: 't2', role: 'assistant-line', content: '- [ ] 待办' },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    const visible = bytes.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible).not.toContain('# 大标题');
    expect(visible).toContain('大标题');
    expect(visible).toContain('1. 第一步');
    expect(visible).toContain('☑ 已完成');
    expect(visible).toContain('☐ 待办');
  });

  it('工具结果冻结为紧凑单行：成功摘要与错误行各一次，无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      history: [
        { key: 't1', role: 'tool', content: 'glob "**/*.ts": 26 file(s) matched' },
        { key: 't2', role: 'tool', content: 'read package.json: 103 lines' },
        { key: 't3', role: 'tool', content: '✖ Failed to read file: ENOENT', toolError: true },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 每个工具调用恰好一行，无原始输出墙
    expect(countOccurrences(bytes, 'glob "**/*.ts": 26 file(s) matched')).toBe(1);
    expect(countOccurrences(bytes, 'read package.json: 103 lines')).toBe(1);
    expect(countOccurrences(bytes, '✖ Failed to read file: ENOENT')).toBe(1);
    expect(bytes).not.toContain('  src/a.ts');
    // 错误行带红色 ANSI 转义
    expect(bytes).toContain('\x1b[31m');
  });

  it('多阶段进度的运行中状态与阶段/验证结果都显示在滚动区', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const state = baseState({
      toolStatuses: [{ id: 'progress-1', name: 'task_progress', detail: 'Implementation', state: 'running', startTime: Date.now() }],
      history: [
        { key: 'p1', role: 'tool', content: 'task_progress: Progress recorded: stage started — Implementation' },
        { key: 'p2', role: 'tool', content: 'task_progress: Progress recorded: stage in_progress — Implementation' },
        { key: 'p3', role: 'tool', content: 'task_progress: Progress recorded: stage completed — Implementation' },
        { key: 'p4', role: 'tool', content: 'task_progress: Progress recorded: verification failed — Tests (2 failed)' },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    for (const marker of ['task_progress', 'stage started', 'stage in_progress', 'stage completed', 'verification failed']) {
      expect(bytes).toContain(marker);
    }
  });

  it('工具失败按新口径渲染：普通结果样式（无 ✖ 红字、无红色 ANSI）', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    // 对齐 onToolError 新口径：formatToolSummary(name, '', error, false) + isError: false
    const state = baseState({
      history: [
        {
          key: 't1',
          role: 'tool',
          content: 'shell: Command exited with code 1',
          toolError: false,
        },
        {
          key: 't2',
          role: 'tool',
          content: 'read foo: Failed to read file: ENOENT',
        },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    // 错误文本仍在对话中（普通样式），但没有 ✖ 前缀与红色 ANSI
    expect(bytes).toContain('Command exited with code 1');
    expect(bytes).toContain('Failed to read file: ENOENT');
    expect(bytes).not.toContain('✖');
    expect(bytes).not.toContain('\x1b[31m');
  });

  it('write/edit 成功路径冻结文件变更卡片：✏️ 首行 + 预览行持久在滚动区', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      history: [
        {
          key: 't1',
          role: 'tool',
          content: 'write hello.txt: done',
          fileChange: {
            path: 'hello.txt',
            kind: 'add',
            lines: [
              { text: '#!/bin/sh', kind: 'add', oldLine: null, newLine: 1 },
              { text: 'echo hi', kind: 'add', oldLine: null, newLine: 2 },
            ],
            truncated: false,
          },
        },
        {
          key: 't2',
          role: 'tool',
          content: 'edit main.ts: done',
          fileChange: {
            path: 'src/main.ts',
            kind: 'update',
            lines: [
              { text: 'old line', kind: 'remove', oldLine: 7, newLine: null },
              { text: 'new line', kind: 'add', oldLine: null, newLine: 7 },
            ],
            truncated: false,
          },
        },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    const plain = bytes.replace(/\x1b\[[0-9;]*m/g, '');
    // 卡片首行与预览行各恰好一次（静态区持久，不重绘）
    expect(countOccurrences(plain, 'Write(hello.txt)')).toBe(1);
    expect(countOccurrences(plain, 'Update(src/main.ts)')).toBe(1);
    expect(countOccurrences(plain, '#!/bin/sh')).toBe(1);
    expect(countOccurrences(plain, 'echo hi')).toBe(1);
    expect(countOccurrences(plain, '- old line')).toBe(1);
    expect(countOccurrences(plain, '+ new line')).toBe(1);
    // 卡片路径替代单行摘要（write/edit 不再出现 "write hello.txt: done" 摘要行）
    expect(bytes).not.toContain('↳ write hello.txt: done');
    expect(bytes).not.toContain('↳ edit main.ts: done');
  });

  it('todo_write / update_plan 动态区最小 UI：plan+todos+tail 超长内容无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const longStep = '这是一个非常长的计划步骤描述 '.repeat(20);
    const state = baseState({
      phase: 'streaming',
      streamingTail: longStep + '（流式尾巴）',
      todos: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'completed' },
      ],
      plan: [
        { step: longStep, status: 'pending' },
        { step: '步骤二', status: 'in_progress' },
        { step: '步骤三', status: 'completed' },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    // 硬性规则：plan+todos+tail 叠加也不触发整屏清空 / 备用屏幕
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    expect(bytes).not.toContain('│');
    // The same task list is no longer repeated as independent plan/todo sections.
    expect(bytes).not.toContain('todos:');
    expect(bytes).toContain('☐ 1. a');
    expect(bytes).toContain('▶ 2. b');
    expect(bytes).toContain('✔ 3. c');
    expect(bytes).not.toContain('步骤二');
  });

  it('确认弹窗 + plan + todos + 超长 tail：帧高预算内无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const longTail = '非常长的流式尾巴'.repeat(30);
    const state = baseState({
      phase: 'confirming',
      streamingTail: longTail,
      confirmPrompt: {
        kind: 'command',
        title: 'Would you like to run the following command?',
        detail: ['npm run build'],
        toolName: 'shell',
        description: 'Run the build',
        options: [
          { label: 'Yes', key: 'y', value: 'allow' },
          { label: 'No, and tell me what to do differently', key: 'd', value: 'deny' },
          { label: 'Abort', key: 'a', value: 'abort' },
        ],
        selected: 0,
        feedbackMode: false,
        feedbackText: '',
      },
      todos: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
      ],
      plan: [{ step: '步骤一', status: 'pending' }],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    expect(bytes).toContain('Would you like to run the following command?');
    // 确认期间弹窗独占动态帧：plan/todos/tail 暂隐（结束后恢复，状态不变）
    expect(bytes).not.toContain('todos:');
    expect(bytes).not.toContain('[ ]');
    expect(bytes).not.toContain('[→]');
  });

  it('多行输入值分行渲染：各行可见、光标在光标行、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      inputValue: 'const a = 1;\nconst b = 2;',
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 两行内容都渲染在输入框（光标默认在第 0 行行首，行 1 无光标块；
    // logo 实心面含 █，不能用全量计数判断光标，改为断言光标块紧跟行内容）
    expect(bytes).toContain('const a = 1;');
    expect(bytes).toContain('const b = 2;');
    expect(bytes).toContain('█const a = 1;');
    expect(bytes).not.toContain('█const b = 2;');
  });

  it('多行输入 + 流式 tail：预算联动后无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      phase: 'streaming',
      streamingTail: 'partial streaming line',
      inputValue: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np',
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).toContain('partial streaming line');
  });

  it('输入值变化（SET_INPUT 等效重渲染）不重写滚动区静态行', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const history = [{ key: 's1', role: 'system' as const, content: 'static line' }];
    const app = render(tree(baseState({ history, inputValue: 'a' })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    // 模拟每次按键 dispatch SET_INPUT：history 引用不变，静态区不应重写
    app.rerender(tree(baseState({ history, inputValue: 'ab' })));
    app.rerender(tree(baseState({ history, inputValue: 'abc\nline2' })));
    app.unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(countOccurrences(bytes, 'static line')).toBe(1);
  });

  it('普通打字只更新输入框本地状态，回显即时且 Enter 提交完整文本', async () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const actions: Array<{ type: string; input?: string }> = [];

    const app = render(
      React.createElement(LiveTuiHarness, {
        onAction: a => actions.push(a as { type: string; input?: string }),
      }),
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await new Promise(r => setTimeout(r, 50));

    stdin.write('hello');
    await waitUntil(() => Buffer.concat(chunks).toString('utf8').includes('hello'), 2000);
    expect(actions.some(a => a.type === 'SET_INPUT')).toBe(false);

    stdin.write('\r');
    await waitUntil(() => actions.some(a => a.type === 'SUBMIT_INPUT'), 2000);
    expect(actions.find(a => a.type === 'SUBMIT_INPUT')?.input).toBe('hello');
    app.unmount();
  });

  it('bracketed paste：整段插入输入框、保留换行、不触发提交', async () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const actions: Array<{ type: string; value?: string }> = [];

    const app = render(
      React.createElement(LiveTuiHarness, {
        onAction: a => actions.push(a as { type: string; value?: string }),
      }),
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    // 等 Ink 挂载并注册 paste 通道后再写入 bracketed paste 字节
    await new Promise(r => setTimeout(r, 50));
    stdin.write('\x1b[200~line1\nline2\n\x1b[201~');
    await waitUntil(() => {
      const bytes = Buffer.concat(chunks).toString('utf8');
      return bytes.includes('line2');
    }, 2000);
    app.unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(actions.some(a => a.type === 'SUBMIT_INPUT')).toBe(false);
    expect(actions.some(a => a.type === 'SET_INPUT' && a.value === 'line1\nline2')).toBe(true);
    expect(bytes).toContain('line1');
    expect(bytes).toContain('line2');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
  });

  it('用户多行消息历史区完整显示：所有行可见、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      history: [
        { key: 'u1', role: 'user', content: 'line1\nline2\nline3', ts: 1 },
      ],
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 三行全部写入滚动区，且保持顺序（每行只出现一次，无重复渲染）
    expect(countOccurrences(bytes, 'line1')).toBe(1);
    expect(countOccurrences(bytes, 'line2')).toBe(1);
    expect(countOccurrences(bytes, 'line3')).toBe(1);
    expect(bytes.indexOf('line2')).toBeGreaterThan(bytes.indexOf('line1'));
    expect(bytes.indexOf('line3')).toBeGreaterThan(bytes.indexOf('line2'));
  });

  it('bracketed paste 大段折叠：≥20 行占位符，再粘贴展开，Enter 提交完整内容', async () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const actions: Array<{ type: string; value?: string; input?: string }> = [];

    const app = render(
      React.createElement(LiveTuiHarness, {
        onAction: a => actions.push(a as { type: string; value?: string; input?: string }),
      }),
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    // 等 Ink 挂载并注册 paste 通道后再写入 bracketed paste 字节
    await new Promise(r => setTimeout(r, 50));

    // 25 行大段粘贴 → 折叠为占位符
    const big = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join('\n');
    stdin.write(`\x1b[200~${big}\x1b[201~`);
    await waitUntil(() => {
      const bytes = Buffer.concat(chunks).toString('utf8');
      return bytes.includes('Pasted text');
    }, 2000);

    expect(actions.some(a => a.type === 'SET_INPUT' && a.value === '[Pasted text #1 +25 lines]')).toBe(true);
    // 输入框不出现完整 25 行（占位符已折叠）
    expect(actions.some(a => a.type === 'SET_INPUT' && a.value!.includes('line1\nline2'))).toBe(false);
    expect(actions.some(a => a.type === 'SUBMIT_INPUT')).toBe(false);

    // 再粘贴小段 → 已有占位符展开为完整内容 + 新文本内联
    stdin.write('\x1b[200~appended\x1b[201~');
    // 注意：字节流累积所有历史帧（含首帧占位符），不能断言「无 Pasted text」；
    // 展开成功以输入框新帧渲染出 line1 为准，占位符消失由 SET_INPUT 值断言
    await waitUntil(() => {
      const bytes = Buffer.concat(chunks).toString('utf8');
      return bytes.includes('line1');
    }, 2000);

    expect(actions.some(a => a.type === 'SET_INPUT' && a.value === `${big}appended`)).toBe(true);

    // Enter → 提交完整内容（不含占位符）
    stdin.write('\r');
    await waitUntil(() => actions.some(a => a.type === 'SUBMIT_INPUT'), 2000);
    const submit = actions.find(a => a.type === 'SUBMIT_INPUT');
    expect(submit).toBeDefined();
    expect(submit!.input).toBe(`${big}appended`);

    app.unmount();
    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
  });

  it('确认弹窗在消息下方相邻渲染、输入区隐藏、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      phase: 'confirming',
      history: [{ key: 'u1', role: 'user', content: '跑个命令', ts: 1 }],
      confirmPrompt: buildConfirmPrompt(),
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 剥离控制序列后逐行检查：弹窗标题紧贴用户消息下方（无中间大片空白），
    // 输入区隐藏：状态行只剩头部 StatusBar（弹窗之前），弹窗末行即动态帧末
    const clean = bytes
      .replace(/\x1b\[\?[0-9]+[hl]/g, '')
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const lines = clean.split('\n');
    const msgIdx = lines.findIndex(l => l.includes('跑个命令'));
    const titleIdx = lines.findIndex(l => l.includes('Would you like to run the following command?'));
    const escIdx = lines.findIndex(l => l.includes('Esc explain refusal · Ctrl+C abort'));
    // 状态行取最后一次出现（头部 StatusBar 在静态区，更靠前；若输入区可见，
    // 最后一次会在弹窗之后，与隐藏断言冲突）
    let statusIdx = -1;
    // StatusBar 额头行单独渲染 model（`test-model`），CI checkout 为
    // detached HEAD 时 face 行无分支后缀；按 model 行匹配，不依赖分支
    lines.forEach((l, i) => { if (l.includes('test-model')) statusIdx = i; });
    // 弹窗紧贴消息（标题在消息之后 5 行内，含时间分隔线/空行），中间无大片空白
    expect(titleIdx).toBeGreaterThan(msgIdx);
    expect(titleIdx - msgIdx).toBeLessThanOrEqual(5);
    // 输入区隐藏：状态行只来自头部 StatusBar（弹窗之前），
    // 弹窗末行（Esc 提示）之后无输入框内容（提示符/输入行/状态行）
    expect(escIdx).toBeGreaterThan(titleIdx);
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeLessThan(titleIdx);
    // 用户消息历史也带 ❯ 前缀，因此只检查弹窗末行之后不再出现
    const afterEsc = lines.slice(escIdx + 1);
    expect(afterEsc.some(l => l.includes('❯'))).toBe(false);
  });

  it('idle → confirming → idle 帧切换：全程无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const confirmPrompt = buildConfirmPrompt();
    const app = render(tree(baseState()), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    // 进入确认：输入框隐藏、动态帧只剩弹窗（in-flow，紧贴最后一条消息）
    app.rerender(tree(baseState({ phase: 'confirming', confirmPrompt })));
    // 确认结束：输入框恢复、动态帧回落
    app.rerender(tree(baseState({
      history: [{ key: 'u1', role: 'user', content: '完成', ts: 1 }],
    })));
    app.unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 结束态输入框恢复可见（提示符渲染在动态帧）
    expect(bytes).toContain('❯');
  });

  it('/clear 后 Static 重挂载 + 瞬时提示：logo 从 index 0 重绘，确认提示贴近输入框', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const app = render(tree(baseState({
      history: [{ key: 'u1', role: 'user', content: '旧消息', ts: 1 }],
    })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    // 模拟 /clear：清空 history + staticEpoch+1（<Static> 重挂载）+ 设置瞬时提示
    app.rerender(tree(baseState({
      staticEpoch: 1,
      notice: 'Context cleared — 新会话，输入继续',
    })));
    app.unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    // logo 重绘 + 确认提示紧贴输入框（动态区）；/clear 不发清屏序列，
    // 布局测试只验证重绘与提示逻辑
    expect(bytes).toContain('SHENLAN');
    expect(bytes).toContain('Context cleared — 新会话，输入继续');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
  });

  it('斜杠命令联想：输入框下方列出匹配命令并高亮选中项，无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      inputValue: '/m',
      slashSuggestions: { matches: ['/model', '/mcp', '/memory'], selected: 1 },
    });
    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 联想渲染在输入行下方（对齐 Claude Code），且带命令说明
    expect(bytes.indexOf('/model')).toBeGreaterThan(bytes.indexOf('/m'));
    // 联想可见时常驻状态行隐藏：最后一次 NORMAL 只来自头部 StatusBar（在列表之前）
    expect(bytes.lastIndexOf('/memory')).toBeGreaterThan(bytes.lastIndexOf('NORMAL'));
    expect(bytes).toContain('管理 MCP servers');
    expect(bytes).toContain('/model');
    expect(bytes).toContain('/mcp');
    expect(bytes).toContain('/memory');
  });

  it('斜杠联想窗口滚动：选中项深入列表时后段命令可见且指示器显示 ↑，首页不渲染', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const matches = [...SLASH_COMMANDS];
    // 选中 /quit（后段命令，共 30 项）：窗口应滚动到尾部
    const state = baseState({
      inputValue: '/',
      slashSuggestions: { matches, selected: matches.indexOf('/quit') },
    });
    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 后段命令出现在帧中（窗口滚动，而非固定前 8 项）
    expect(bytes).toContain('/quit');
    expect(bytes).toContain('/exit');
    // 方向指示器数量随命令表增长，避免新增命令后测试硬编码漂移。
    expect(bytes).toContain(`↑ 还有 ${SLASH_COMMANDS.length - 8} 个`);
    // 首段命令不在窗口内（被窗口裁掉）
    expect(bytes).not.toContain('/help');
    expect(bytes).not.toContain('/model');
  });

  it('斜杠联想窗口首页：选中 0 时显示列表开头且指示器只显示 ↓', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const matches = [...SLASH_COMMANDS];
    const state = baseState({
      inputValue: '/',
      slashSuggestions: { matches, selected: 0 },
    });
    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).toContain('/help');
    expect(bytes).toContain(`↓ 还有 ${SLASH_COMMANDS.length - 8} 个`);
    expect(bytes).not.toContain('↑ 还有');
  });

  it('后台任务行：与工具状态合计 ≤4 行预算，溢出折叠，无清屏序列（§26.5）', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      phase: 'tools',
      toolStatuses: [
        { id: 't1', name: 'shell', detail: 'npm run build', state: 'running' as const, startTime: Date.now() },
        { id: 't2', name: 'read', detail: 'a.ts', state: 'running' as const, startTime: Date.now() },
        { id: 't3', name: 'edit', detail: 'b.ts', state: 'running' as const, startTime: Date.now() },
      ],
      bgTasks: [
        { id: 'bg-1', goal: '研究定价', startTime: Date.now() },
        { id: 'bg-2', goal: '查资料', startTime: Date.now() },
        { id: 'bg-3', goal: '验证接口', startTime: Date.now() },
      ],
    });
    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 3 工具 + 3 后台 = 6 > 4 行预算：工具 3 行全显 + 1 行后台 + 折叠行
    expect(bytes).toContain('⏳ bg: 研究定价');
    expect(bytes).toContain('+2 个后台任务');
    expect(bytes).not.toContain('⏳ bg: 查资料');
    expect(bytes).not.toContain('⏳ bg: 验证接口');
  });

  it('高危双确认弹窗：完整命令 + 命中模式渲染，无清屏序列（§11）', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      phase: 'confirming',
      confirmPrompt: {
        kind: 'high-risk',
        title: '⚠️ High-risk command — 需输入确认短语',
        detail: ['rm -rf /tmp/x', 'matched pattern: rm -rf 模式'],
        toolName: 'shell',
        description: 'High-risk: rm -rf /tmp/x',
        options: [{ label: '输入确认短语后回车', key: 'y', value: 'feedback' }],
        selected: 0,
        feedbackMode: true,
        feedbackText: 'ye',
        feedbackLabel: '输入确认短语「yes」后回车（Esc 拒绝）',
      },
    });
    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    expect(bytes).toContain('High-risk command');
    expect(bytes).toContain('rm -rf /tmp/x');
    expect(bytes).toContain('matched pattern');
    expect(bytes).toContain('确认短语');
  });

  it('/model 面板：模型列表渲染、输入区隐藏、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      modelPanel: {
        models: [
          { kind: 'auto', model: 'Default', provider: 'auto', group: '自动路由', contextWindow: 0, available: true, current: true, tag: '自动路由 · cost-first · 基线 deepseek-v4-flash', priceText: '' },
          { kind: 'model', model: 'deepseek-v4-flash', provider: 'deepseek', group: 'DeepSeek（官方 API）', contextWindow: 1_000_000, available: false, current: false, tag: '快速', priceText: '¥3/¥9 per Mtok' },
          { kind: 'model', model: 'qwen3.8-max', provider: 'qwen', group: '百炼 DashScope', contextWindow: 128_000, available: true, current: false, tag: '推理最强', priceText: '' },
        ],
        selected: 2,
      },
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 标题、置顶 Default、模型名、无 key 标记、页脚快捷键渲染
    expect(bytes).toContain('Select model');
    expect(bytes).toContain('Default (自动路由)');
    expect(bytes).toContain('qwen3.8-max');
    expect(bytes).toContain('无 key');
    expect(bytes).toContain('Enter 设为默认 · s 仅本次会话 · Esc 取消');
    // 输入区隐藏：面板页脚之后不再出现输入提示符
    const clean = bytes
      .replace(/\x1b\[\?[0-9]+[hl]/g, '')
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const lines = clean.split('\n');
    const footerIdx = lines.findIndex(l => l.includes('Enter 设为默认'));
    expect(footerIdx).toBeGreaterThanOrEqual(0);
    expect(lines.slice(footerIdx + 1).some(l => l.includes('❯'))).toBe(false);
  });

  it('/keys 面板：掩码列表渲染、输入框隐藏、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      keysPanel: {
        providers: [
          { id: 'deepseek', name: 'DeepSeek', masked: '****5678', configured: true, envSet: false, envVar: 'DEEPSEEK_API_KEY' },
          { id: 'qwen', name: 'qwen', masked: '(未配置)', configured: false, envSet: false, envVar: 'QWEN_API_KEY' },
        ],
        selected: 0,
        inputMode: false,
        inputText: '',
        scope: 'global',
        busy: false,
        customStep: null,
        customBaseUrl: '',
        customApiKey: '',
        customModels: [],
      },
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).toContain('****5678');
    expect(bytes).toContain('(未配置)');
    expect(bytes).toContain('全局');
    // 面板模态：输入框隐藏（无分隔线），选择标记来自面板自身
    expect(bytes).not.toContain('─');
  });

  it('/keys 面板输入模式：粘贴/输入文本渲染，仍无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      keysPanel: {
        providers: [
          { id: 'deepseek', name: 'DeepSeek', masked: '(未配置)', configured: false, envSet: false, envVar: 'DEEPSEEK_API_KEY' },
        ],
        selected: 0,
        inputMode: true,
        inputText: 'sk-abcdefghijklmnopqrstuvwxyz123456',
        scope: 'global',
        busy: false,
        customStep: null,
        customBaseUrl: '',
        customApiKey: '',
        customModels: [],
      },
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).toContain('输入 DeepSeek API Key');
  });

  it('/keys 面板自定义第 3 步：多行展示探测到的模型清单并提示未显示项，无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const many = Array.from({ length: 12 }, (_, i) => `glm-4-model-${i + 1}`);
    const state = baseState({
      keysPanel: {
        providers: [
          { id: 'custom', name: 'Custom OpenAI-compatible', masked: '(未配置)', configured: false, envSet: false, envVar: '' },
        ],
        selected: 0,
        inputMode: true,
        inputText: '',
        scope: 'global',
        busy: false,
        customStep: 2,
        customBaseUrl: 'https://gw.example.com',
        customApiKey: 'sk-gw-1',
        customModels: many,
      },
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    // 步骤提示给出可选序号范围（12 项未超 DISCOVERED_MODEL_LIST_LIMIT，全部可选）
    expect(bytes).toContain('选择模型（序号 1-12');
    // 每项独立成行（受终端行数预算约束，不足时提示未显示项）
    expect(bytes).toContain('[1] glm-4-model-1');
    expect(bytes).toContain('[2] glm-4-model-2');
    // 行数不足时给出「未显示」提示而非静默截断；行数充裕时全部展示
    const listComplete = !bytes.includes('未显示');
    if (!listComplete) {
      expect(bytes).toContain('未显示，可直接输入模型名');
    }
  });

  it('/security 面板：钩子状态 + 敏感文件提示渲染、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      securityPanel: {
        hook: { gitRepo: true, hookExists: true, ours: true, path: '/repo/.git/hooks/pre-commit' },
        trackedSensitive: ['.env'],
        selected: 0,
        busy: false,
      },
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).toContain('pre-commit 钩子');
    expect(bytes).toContain('.env');
    expect(bytes).not.toContain('─');
  });

  it('24 行终端：/keys 与 /security 动态帧 ≤ rows-1，无整屏清屏', () => {
    const runCase = (state: AppState, expectText: string) => {
      const stdout = makeTtyStream('stdout');
      const stdin = makeTtyStream('stdin');
      const chunks: Buffer[] = [];
      stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

      // 24 行终端：makeTtyStream 固定 40 行，这里通过 props 覆盖 termHeight
      const tree24 = (s: AppState) => React.createElement(TuiHarness, { state: s, termHeight: 24 });
      const { unmount } = render(tree24(state), {
        stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
      });
      unmount();

      const bytes = Buffer.concat(chunks).toString('utf8');
      expect(bytes).not.toContain(CLEAR_TERMINAL);
      expect(bytes).not.toContain('\x1b[?1049h');
      expect(bytes).toContain(expectText);
    };

    runCase(baseState({
      keysPanel: {
        providers: [
          { id: 'deepseek', name: 'DeepSeek', masked: '****5678', configured: true, envSet: false, envVar: 'DEEPSEEK_API_KEY' },
          { id: 'qwen', name: 'qwen', masked: '(未配置)', configured: false, envSet: false, envVar: 'QWEN_API_KEY' },
        ],
        selected: 0,
        inputMode: false,
        inputText: '',
        scope: 'global',
        busy: false,
        customStep: null,
        customBaseUrl: '',
        customApiKey: '',
        customModels: [],
      },
    }), 'API keys');

    runCase(baseState({
      securityPanel: {
        hook: { gitRepo: true, hookExists: true, ours: true, path: '/repo/.git/hooks/pre-commit' },
        trackedSensitive: ['.env', '.env.local'],
        selected: 2,
        busy: false,
      },
    }), 'Security');


    runCase(baseState({
      phase: 'confirming',
      confirmPrompt: {
        ...buildConfirmPrompt(),
        language: 'zh-CN',
        title: buildConfirmTitle('command', 'zh-CN'),
        options: buildConfirmOptions('command', { prefix: 'git status', family: true }, 'zh-CN'),
      },
    }), '本会话允许命令族');
  });

  it('首次引导欢迎页：渲染欢迎文案、输入框隐藏、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      onboarding: {
        step: 'welcome',
        providers: [
          { id: 'deepseek', name: 'DeepSeek', masked: '(未配置)', configured: false, envSet: false, envVar: 'DEEPSEEK_API_KEY' },
          { id: 'qwen', name: 'qwen', masked: '(未配置)', configured: false, envSet: false, envVar: 'QWEN_API_KEY' },
        ],
      },
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).toContain('欢迎使用 shenlan');
    expect(bytes).toContain('开始配置');
    // 模态：输入框隐藏（无分隔线）
    expect(bytes).not.toContain('─');
  });

  it('首次引导 tips 页：快速上手命令列表渲染、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const state = baseState({
      onboarding: {
        step: 'tips',
        providers: [],
        saved: { provider: 'deepseek', masked: '****abcd' },
      },
    });

    const { unmount } = render(tree(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).toContain('配置完成');
    expect(bytes).toContain('/model');
    expect(bytes).toContain('/goal');
    expect(bytes).toContain('/security');
    expect(bytes).toContain('开始使用');
  });

  // ===== 输入行水平开窗（Windows 左移修复）=====
  // 预算公式（与 InputBox 一致）：100 列 → 正文预算 = 100−1−1(█)−3(提示符)−2(指示符预留) = 93

  it('超宽单行输入：水平开窗渲染、行不折行、分隔线 ≤ w−1、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const { unmount } = render(tree(baseState({ inputValue: 'a'.repeat(300) })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 光标在行首（harness 光标恒 0）：窗口贴左缘、无左指示符，
    // 行 = █ + 93 个 a 后紧跟换行（不折行、行尾被窗口裁掉）
    expect(bytes).toContain('█' + 'a'.repeat(93) + '\n');
    expect(bytes).not.toContain('█' + 'a'.repeat(94));
    // 帧内所有分隔线段 ≤ w−1 = 99
    for (const run of bytes.match(/─+/g) ?? []) {
      expect(run.length).toBeLessThanOrEqual(99);
    }
  });

  it('CJK 超宽输入：按显示列开窗、无替换符、无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const { unmount } = render(tree(baseState({ inputValue: '中'.repeat(60) })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('�');
    // 120 列 > 100：窗口 93 列 → 46 个中（46×2=92 ≤ 93；47×2=94 越界）
    expect(bytes).toContain('█' + '中'.repeat(46) + '\n');
    expect(bytes).not.toContain('█' + '中'.repeat(47));
  });

  it('超宽多行输入：光标行开窗 + 非光标行截断，无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const input = 'a'.repeat(300) + '\n' + '中'.repeat(60);
    const { unmount } = render(tree(baseState({ inputValue: input })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    // 光标行（行 0）：█ + 93 a；非光标行（行 1）：截断到 w−1=99 → 49 个中
    expect(bytes).toContain('█' + 'a'.repeat(93) + '\n');
    expect(bytes).toContain('中'.repeat(49) + '\n');
    expect(bytes).not.toContain('中'.repeat(50) + '\n');
  });

  it('60×20 窄终端：超宽输入 + 斜杠联想同开，帧高预算内无整屏清屏', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const tree60 = (s: AppState) =>
      React.createElement(TuiHarness, { state: s, termWidth: 60, termHeight: 20 });
    const state = baseState({
      inputValue: '中'.repeat(60),
      slashSuggestions: { matches: ['memory', 'model', 'config'], selected: 0 },
    });
    const { unmount } = render(tree60(state), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[?1049h');
    // 60 列：正文预算 = 60−1−1−3−2 = 53 → 26 个中（26×2=52 ≤ 53）
    expect(bytes).toContain('█' + '中'.repeat(26) + '\n');
    // 联想行与分隔线均 ≤ w−1 = 59
    for (const run of bytes.match(/─+/g) ?? []) {
      expect(run.length).toBeLessThanOrEqual(59);
    }
  });

  it('打字过程（输入逐步变长跨帧重绘）：全程无整屏清屏（Windows 左移修复）', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));

    const app = render(tree(baseState({ inputValue: '' })), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
    });
    // 模拟每次按键 SET_INPUT 重渲染：输入从短到超宽（含 CJK 切换）
    for (let n = 10; n <= 300; n += 10) {
      app.rerender(tree(baseState({ inputValue: 'a'.repeat(n) })));
    }
    app.rerender(tree(baseState({ inputValue: '中'.repeat(60) })));
    app.unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[2J');
    expect(bytes).not.toContain('\x1b[3J');
    // 31 次全量 Ink 重渲染，满载并行时接近默认 5s 超时（实测 2.2s 独跑 / 4.9s 满载）
  }, 20_000);
});

/** 命令确认弹窗（scrollback 测试共用形状） */
function buildConfirmPrompt() {
  return {
    kind: 'command' as const,
    title: 'Would you like to run the following command?',
    detail: ['npm run build'],
    toolName: 'shell',
    description: 'Run the build',
    options: [
      { label: 'Yes', key: 'y', value: 'allow' },
      { label: 'No, and tell me what to do differently', key: 'd', value: 'deny' },
      { label: 'Abort', key: 'a', value: 'abort' },
    ],
    selected: 0,
    feedbackMode: false,
    feedbackText: '',
  };
}

describe('live read group display', () => {
  it('keeps the latest completed target visible between reads without clearing scrollback', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const { unmount } = render(tree(baseState({
      phase: 'thinking',
      toolStatuses: [{ id: 'latest', name: 'read', detail: 'tests/metrics.rs',
        state: 'done', grouped: true, startTime: 100, endTime: 200 }],
    })), { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmount();
    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).toContain('metrics.rs');
    expect(bytes).toContain('✔');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
    expect(bytes).not.toContain('\x1b[3J');
  });
});

describe('visible subtask checklist', () => {
  it('renders five task titles in their original order', () => {
    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const { unmount } = render(tree(baseState({
      phase: 'thinking',
      todos: [
        { content: 'Push changes', status: 'completed' },
        { content: 'Diagnose flaky test', status: 'in_progress' },
        { content: 'Fix root cause', status: 'pending' },
        { content: 'Harden test infrastructure', status: 'pending' },
        { content: 'Run full verification', status: 'pending' },
      ],
    })), { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmount();
    const bytes = Buffer.concat(chunks).toString('utf8');
    for (const title of ['Push changes', 'Diagnose flaky test', 'Fix root cause', 'Harden test infrastructure', 'Run full verification']) {
      expect(bytes).toContain(title);
    }
    expect(bytes.indexOf('Push changes')).toBeLessThan(bytes.indexOf('Diagnose flaky test'));
    expect(bytes).not.toContain(CLEAR_TERMINAL);
  });

  it('shows the active task with one available row and bounds large lists', () => {
    for (const height of [8, 20]) {
      const stdout = makeTtyStream('stdout');
      const stdin = makeTtyStream('stdin');
      const chunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      const state = baseState({ todos: Array.from({ length: 25 }, (_, i) => ({
        content: i === 24 ? 'Current task' : `Pending task ${i}`,
        status: i === 24 ? 'in_progress' as const : 'pending' as const,
      })) });
      const { unmount } = render(React.createElement(TuiHarness, { state, termHeight: height }), {
        stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
      });
      unmount();
      const bytes = Buffer.concat(chunks).toString('utf8');
      expect(bytes).toContain('Current task');
      expect(bytes).toContain('… +');
      expect(bytes).not.toContain(CLEAR_TERMINAL);
    }
  });
});

describe('subtask tree terminal layout', () => {
  it('nests current development items under S3 without a second flat checklist', () => {
    for (const height of [12, 40]) {
      const stdout = makeTtyStream('stdout');
      const stdin = makeTtyStream('stdin');
      const chunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      const state = baseState({
        taskListSource: 'todos',
        plan: [{ step: 'Stale separate plan', status: 'in_progress' }],
        todos: [
          { group: 'S1 Verify', content: 'Build and test', status: 'completed' },
          { group: 'S2 Coverage', content: 'HEAD and Range', status: 'completed' },
          { group: 'S3 Performance', content: 'Measure stat overhead', status: 'in_progress' },
          { group: 'S3 Performance', content: 'Commit benchmark', status: 'pending' },
        ],
      });
      const { unmount } = render(React.createElement(TuiHarness, { state, termHeight: height }), {
        stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true,
      });
      unmount();
      const bytes = Buffer.concat(chunks).toString('utf8');
      const plain = bytes.replace(/\x1b\[[?0-9;]*[A-Za-z]/g, '');
      expect(countOccurrences(plain, 'S3 Performance')).toBe(1);
      expect(plain).toContain('▾ S3 Performance');
      expect(plain).toContain('    ▶ 3. Measure stat overhead');
      expect(plain).toContain('    ☐ 4. Commit benchmark');
      expect(plain.indexOf('S3 Performance')).toBeLessThan(plain.indexOf('Measure stat overhead'));
      expect(plain).not.toContain('Stale separate plan');
      expect(plain).not.toContain('Build and test');
      expect(plain).not.toContain('todos:');
      expect(bytes).not.toContain(CLEAR_TERMINAL);
      expect(bytes).not.toContain('\x1b[3J');
    }
  });
});
