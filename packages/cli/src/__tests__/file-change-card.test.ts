/**
 * 文件变更卡片渲染测试（.test.ts 以纳入 vitest 默认 include；
 * MessageItem 渲染路径与 scrollback harness 一致）。
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { MessageItem } from '../components/MessageItem.js';
import { makeTtyStream } from './scrollback-harness.js';

/** Render React nodes to raw Ink output, including ANSI styles when enabled. */
function renderToAnsi(node: React.ReactElement): string {
  const stdout = makeTtyStream('stdout');
  const stdin = makeTtyStream('stdin');
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const { unmount } = render(node, {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  unmount();
  return Buffer.concat(chunks).toString('utf8');
}

function renderToText(node: React.ReactElement): string {
  return renderToAnsi(node).replace(/\x1b\[[0-9;]*m/g, '');
}

describe('MessageItem 文件变更卡片（write/edit 成功路径）', () => {
  it('新增文件显示工具动作、结果摘要和预览', () => {
    const text = renderToText(React.createElement(MessageItem, {
      role: 'tool',
      content: 'write hello.txt: done',
      fileChange: {
        path: 'src/hello.txt',
        kind: 'add',
        lines: [
          { text: '#!/bin/sh', kind: 'add', oldLine: null, newLine: 1 },
          { text: 'echo hi', kind: 'add', oldLine: null, newLine: 2 },
        ],
        truncated: false,
      },
    }));
    expect(text).toContain('Write(src/hello.txt)');
    expect(text).toContain('Wrote 2 lines');
    expect(text).toContain('#!/bin/sh');
    expect(text).toContain('echo hi');
    expect(text).toContain('1 + #!/bin/sh');
    expect(text).toContain('2 + echo hi');
    // 卡片替代旧单行摘要（↳ 不再出现）
    expect(text).not.toContain('↳');
  });

  it('更新文件显示工具动作、结果摘要和增删预览', () => {
    const element = React.createElement(MessageItem, {
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
    });
    const text = renderToText(element);
    expect(text).toContain('Update(src/main.ts)');
    expect(text).toContain('Updated 2 lines');
    expect(text).toContain('- old line');
    expect(text).toContain('+ new line');
    expect(text).toContain('7 - old line');
    expect(text).toContain('7 + new line');
    if (process.env.FORCE_COLOR) {
      const ansi = renderToAnsi(element);
      expect(ansi).toContain('\x1b[31m');
      expect(ansi).toContain('\x1b[32m');
    }
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
        lines: [{ text: long, kind: 'add', oldLine: null, newLine: 1 }],
        truncated: false,
      },
    }));
    // 截断后的行包含省略号且不再出现完整 300 字符
    expect(text).toContain('…');
    expect(text).not.toContain(long);
  });

  it('截断提示没有行号和变更颜色标记', () => {
    const text = renderToText(React.createElement(MessageItem, {
      role: 'tool', content: 'write many.txt: done',
      fileChange: {
        path: 'many.txt', kind: 'add', truncated: true,
        lines: [{ text: '… (3 more lines)', kind: 'truncated', oldLine: null, newLine: null }],
      },
    }));
    expect(text).toContain('… (3 more lines)');
    expect(text).not.toContain('+ …');
    expect(text).not.toContain('1 …');
  });

  it('不同位数的旧、新行号和双宽中文保持变更标记列对齐', () => {
    const text = renderToText(React.createElement(MessageItem, {
      role: 'tool', content: 'edit 中文.txt: done',
      fileChange: {
        path: '中文.txt', kind: 'update', truncated: false,
        lines: [
          { text: '旧内容', kind: 'remove', oldLine: 100, newLine: null },
          { text: '新内容', kind: 'add', oldLine: null, newLine: 98 },
        ],
      },
    }));
    const rows = text.split('\n');
    const removeRow = rows.find(row => row.includes('- 旧内容'))!;
    const addRow = rows.find(row => row.includes('+ 新内容'))!;
    expect(removeRow.indexOf('- 旧内容')).toBe(addRow.indexOf('+ 新内容'));
    expect(removeRow).toContain('100');
    expect(addRow).toContain('98');
  });
});
