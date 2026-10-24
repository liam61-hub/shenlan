/**
 * 文件变更卡片渲染测试（.test.ts 以纳入 vitest 默认 include；
 * MessageItem 渲染路径与 scrollback harness 一致）。
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { MessageItem } from '../components/MessageItem.js';
import { makeTtyStream } from './scrollback-harness.js';

/** 渲染 React 节点到纯文本（剥掉 ANSI 颜色码） */
function renderToText(node: React.ReactElement): string {
  const stdout = makeTtyStream('stdout');
  const stdin = makeTtyStream('stdin');
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const { unmount } = render(node, {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  unmount();
  return Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('MessageItem 文件变更卡片（write/edit 成功路径）', () => {
  it('带 fileChange 的工具项渲染 ✏️ Added <路径> + 预览行', () => {
    const text = renderToText(React.createElement(MessageItem, {
      role: 'tool',
      content: 'write hello.txt: done',
      fileChange: {
        path: 'src/hello.txt',
        kind: 'add',
        lines: ['#!/bin/sh', 'echo hi'],
        truncated: false,
      },
    }));
    expect(text).toContain('✏️ Added src/hello.txt');
    expect(text).toContain('#!/bin/sh');
    expect(text).toContain('echo hi');
    // 卡片替代旧单行摘要（↳ 不再出现）
    expect(text).not.toContain('↳');
  });

  it('edit 卡片渲染 ✏️ Updated + - / + 预览块', () => {
    const text = renderToText(React.createElement(MessageItem, {
      role: 'tool',
      content: 'edit main.ts: done',
      fileChange: {
        path: 'src/main.ts',
        kind: 'update',
        lines: ['- old line', '+ new line'],
        truncated: false,
      },
    }));
    expect(text).toContain('✏️ Updated src/main.ts');
    expect(text).toContain('- old line');
    expect(text).toContain('+ new line');
  });

  it('不带 fileChange 的工具项保持单行 ↳ 摘要（与现状一致）', () => {
    const text = renderToText(React.createElement(MessageItem, {
      role: 'tool',
      content: 'write foo.txt: done',
      toolError: false,
    }));
    expect(text).toContain('↳');
    expect(text).toContain('write foo.txt: done');
    expect(text).not.toContain('✏️');
  });

  it('预览行超宽按显示宽度截断补 …', () => {
    const long = 'x'.repeat(300);
    const text = renderToText(React.createElement(MessageItem, {
      role: 'tool',
      content: 'write long.txt: done',
      fileChange: {
        path: 'long.txt',
        kind: 'add',
        lines: [long],
        truncated: false,
      },
    }));
    // 截断后的行包含省略号且不再出现完整 300 字符
    expect(text).toContain('…');
    expect(text).not.toContain(long);
  });
});
