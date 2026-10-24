import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink';
import chalk from 'chalk';
import { MessageItem, formatDivider, formatUserBlock, renderMarkdown } from '../components/MessageItem.js';
import { makeTtyStream } from './scrollback-harness.js';
import { displayWidth } from '../markdown-utils.js';
import { StreamingLine } from '../components/StreamingLine.js';

chalk.level = 1;

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
  return Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[?0-9;]*[A-Za-z]/g, '');
}

/** 渲染 React 节点并保留 ANSI/终端控制序列。 */
function renderToRaw(node: React.ReactElement): string {
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

describe('renderMarkdown（MessageItem 渲染器）', () => {
  it('单行 $$...$$ 公式块正常渲染（回归：曾因索引回退导致无限循环）', () => {
    const nodes = renderMarkdown('$$X = \\int_{-\\infty}^{\\infty} x(t) dt$$');
    expect(nodes.length).toBe(1);
  });

  it('多行 $$ 公式块正常渲染', () => {
    const nodes = renderMarkdown('$$\nx = 1\n$$');
    expect(nodes.length).toBe(1);
  });

  it('标题 + 表格 + 公式的完整消息可渲染', () => {
    const md = [
      '# 标题',
      '',
      '$$x = 1$$',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    const nodes = renderMarkdown(md);
    // 标题 1 + 空行 1 + 公式 1 + 空行 1 + 表格块 1 = 5
    expect(nodes.length).toBe(5);
  });

  it('长公式单元格折行成多行且行结构完整', () => {
    const md = [
      '| 定理 | 公式 | 意义 |',
      '|------|------|------|',
      '| 帕塞瓦尔定理 | $\\int_{-\\infty}^{\\infty} |f(t)|^2 dt = \\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty} |F(\\omega)|^2 d\\omega$ | 时域能量 = 频域能量 |',
    ].join('\n');
    const nodes = renderMarkdown(md);
    // 表格整体为 1 个 TableBlock 节点
    expect(nodes.length).toBe(1);
  });

  it('跨行行内代码 span 解析为代码而非原样反引号', () => {
    const md = [
      '`core/config/mod.r  ServerConfig.http2 字段 + 校验「启用 http2 须配置 tls」',
      '    s`',
    ].join('\n');
    const text = renderToText(<Box flexDirection="column">{renderMarkdown(md)}</Box>);
    expect(text).not.toContain('`');
    expect(text).toContain('core/config/mod.r');
    expect(text).toContain('ServerConfig.http2');
    expect(text).toContain('tls');
  });

  it('表格渲染为 Codex 风格（表头重线 + 行间轻线）而非盒子边框，列宽含 emoji 对齐', () => {
    const md = [
      '| 阶段 | 状态 |',
      '|------|------|',
      '| 初始化 | ⏳ 进行中 |',
      '| 收尾 | ⬛ 待办 |',
    ].join('\n');
    const text = renderToText(<Box flexDirection="column">{renderMarkdown(md)}</Box>);
    expect(text).toContain('━'); // 表头重分隔线
    expect(text).toContain('─'); // 行间轻分隔线
    expect(text).not.toContain('┌');
    expect(text).not.toContain('├');
    expect(text).not.toContain('└');
    expect(text).not.toContain('│');
    expect(text).not.toContain('| 阶段 | 状态 |');
    // 分隔线（含 emoji 列）与各行显示宽度一致（列对齐回归：曾因每格内边距不一致错位 1 列）
    const widths = text.split('\n')
      .filter(l => l.includes('━') || l.includes('─'))
      .map(l => displayWidth(l));
    expect(widths.every(w => w === widths[0])).toBe(true);
  });

  it('有序列表保留序号（回归：曾丢失数字）', () => {
    const text = renderToText(
      <Box flexDirection="column">{renderMarkdown('1. 第一步\n2. 第二步')}</Box>
    );
    expect(text).toContain('1. 第一步');
    expect(text).toContain('2. 第二步');
  });

  it('标题在上一行非空时前加 1 空行，空行时不重复加', () => {
    // 正文 + 标题 → 正文/空行/标题 3 个节点
    expect(renderMarkdown('正文\n# 标题').length).toBe(3);
    // 标题前已是空行 → 不额外加空行
    expect(renderMarkdown('正文\n\n# 标题').length).toBe(3);
    // 首行标题 → 不加空行
    expect(renderMarkdown('# 标题').length).toBe(1);
  });

  it('表格在上一行非空时前加 1 空行', () => {
    const md = '正文\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(renderMarkdown(md).length).toBe(3); // 正文 + 空行 + 表格块
    const mdWithBlank = '正文\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(renderMarkdown(mdWithBlank).length).toBe(3); // 正文 + 空行 + 表格块
  });
});

describe('formatUserBlock（用户消息青蓝圆点 + 加粗正文）', () => {
  it('时间分隔线保留一列，消息行不超过安全宽度', () => {
    // 满宽行会让终端自动换行、多出幻影行 → Ink 行计数错位（Windows/Wave 左移）
    expect(displayWidth(formatDivider(0, 100))).toBe(99);
    expect(displayWidth(formatUserBlock('问题', 100)[0]!)).toBeLessThanOrEqual(99);
  });

  it('按 termWidth 显示宽度安全切分 CJK', () => {
    const lines = formatUserBlock(`第一行\n${'中'.repeat(10)}`, 12);

    expect(lines.every(line => displayWidth(line) <= 11)).toBe(true);
    expect(lines.every(line => !line.includes('\u2800'))).toBe(true);
    expect(lines[0]?.startsWith('● 第一行')).toBe(true);
    expect(lines.slice(1).every(line => line.startsWith('  '))).toBe(true);
    const content = lines.map(line => line.trim()).join('');
    expect(content).toContain('第一行');
    expect(content).toContain('中'.repeat(10));
  });

  it('每个逻辑行最多保留 120 个 Unicode 字符', () => {
    const lines = formatUserBlock('😀'.repeat(121), 400);
    const body = lines.join('').replace(/^●\s*/, '').trim();
    expect(Array.from(body)).toHaveLength(120);
  });

  it('仅首行显示 cyan 圆点，正文加粗且不输出背景色或行尾填充', () => {
    const raw = renderToRaw(<MessageItem role="user" content="问题" termWidth={100} />);
    expect(raw).toContain('\x1b[36m●\x1b[39m');
    expect(raw).toContain('\x1b[1m 问题\x1b[22m');
    expect(raw).not.toContain('\x1b[100m');
    expect(raw).not.toContain('\u2800');
  });

  it('多行与自动折行只显示一个圆点，续行保持两个空格缩进', () => {
    const lines = formatUserBlock(`第一行\n${'中'.repeat(10)}`, 12);

    expect(lines.filter(line => line.startsWith('● '))).toHaveLength(1);
    expect(lines.slice(1).every(line => line.startsWith('  '))).toBe(true);
  });
});

describe('助手消息安全折行', () => {
  it('完成态 CJK 折行后每个视觉行都有竖线，且保留终端最后一列', () => {
    const text = renderToText(
      <MessageItem role="assistant" content={'中文'.repeat(12)} termWidth={20} />,
    );
    const lines = text.split('\n').filter(line => line.includes('中') || line.includes('文'));

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every(line => line.startsWith('  │ '))).toBe(true);
    expect(lines.every(line => displayWidth(line) <= 19)).toBe(true);
  });

  it('流式冻结行折行后延续竖线，不从窗口左侧或末列继续', () => {
    const text = renderToText(
      <StreamingLine text={`prefix-${'中'.repeat(12)}-suffix`} termWidth={20} />,
    );
    const lines = text.split('\n').filter(line => line.trim() !== '');

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every(line => line.startsWith('  │ '))).toBe(true);
    expect(lines.every(line => displayWidth(line) <= 19)).toBe(true);
  });
});
