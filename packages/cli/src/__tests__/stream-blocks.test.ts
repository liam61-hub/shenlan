import { describe, expect, it } from 'vitest';
import { ingestStreamLine, flushPendingBlock } from '../stream-blocks.js';
import type { FlushItem, PendingBlock } from '../stream-blocks.js';

/** 模拟逐行流式：累积 flush 条目与最终 pendingBlock */
function feed(lines: string[]): { pending: PendingBlock | null; out: FlushItem[] } {
  let pending: PendingBlock | null = null;
  const out: FlushItem[] = [];
  for (const line of lines) {
    const res = ingestStreamLine(line, pending);
    pending = res.pendingBlock;
    out.push(...res.flush);
  }
  return { pending, out };
}

describe('ingestStreamLine（流式块缓冲）', () => {
  it('完整表格：表头/分隔行/数据行缓冲，未打断前不冻结', () => {
    const { pending, out } = feed(['| 阶段 | 进度 |', '|---|---|', '| ⏳ | 进行中 |']);
    expect(out).toEqual([]);
    expect(pending).toEqual({
      kind: 'table',
      lines: ['| 阶段 | 进度 |', '|---|---|', '| ⏳ | 进行中 |'],
      confirmed: true,
    });
  });

  it('表格被非管道行打断：confirmed 的冻结为表格块，当前行按普通行处理', () => {
    const { pending, out } = feed([
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '正文',
    ]);
    expect(pending).toBeNull();
    expect(out).toEqual([
      { role: 'assistant-block', content: '| a | b |\n|---|---|\n| 1 | 2 |', blockKind: 'table' },
      { role: 'assistant-line', content: '正文' },
    ]);
  });

  it('无分隔行（未 confirmed）：打断时按普通行逐行冻结', () => {
    const { pending, out } = feed(['| a | b |', '| c | d |', '正文']);
    expect(pending).toBeNull();
    expect(out).toEqual([
      { role: 'assistant-line', content: '| a | b |' },
      { role: 'assistant-line', content: '| c | d |' },
      { role: 'assistant-line', content: '正文' },
    ]);
  });

  it('消息结束中断：confirmed 表格 → 表格块', () => {
    const { pending } = feed(['| a | b |', '|---|---|', '| 1 | 2 |']);
    expect(flushPendingBlock(pending)).toEqual([
      { role: 'assistant-block', content: '| a | b |\n|---|---|\n| 1 | 2 |', blockKind: 'table' },
    ]);
  });

  it('消息结束中断：未 confirmed 表格 → 普通行', () => {
    const { pending } = feed(['| a | b |', '| c | d |']);
    expect(flushPendingBlock(pending)).toEqual([
      { role: 'assistant-line', content: '| a | b |' },
      { role: 'assistant-line', content: '| c | d |' },
    ]);
  });

  it('跨行行内代码 span：未闭合时缓冲，闭合后整段冻结为一条 assistant-line', () => {
    const { pending, out } = feed([
      '`core/config/mod.r  ServerConfig.http2 字段 + 校验「启用 http2 须配置 tls」',
      '    s`',
      '正文',
    ]);
    expect(out).toEqual([
      {
        role: 'assistant-line',
        content:
          '`core/config/mod.r  ServerConfig.http2 字段 + 校验「启用 http2 须配置 tls」\n    s`',
      },
      { role: 'assistant-line', content: '正文' },
    ]);
    expect(pending).toBeNull();
  });

  it('跨行行内代码 span 未闭合到消息结束：缓冲保留，flush 时按普通行逐行冻结', () => {
    const { pending, out } = feed(['`code', '继续']);
    expect(out).toEqual([]);
    expect(pending).toEqual({ kind: 'inline', lines: ['`code', '继续'], confirmed: false });
    const flushed = flushPendingBlock(pending);
    expect(flushed).toEqual([
      { role: 'assistant-line', content: '`code' },
      { role: 'assistant-line', content: '继续' },
    ]);
  });

  it('公式闭合：$$ 开、内容、$$ 闭 → 整块冻结', () => {
    const { pending, out } = feed(['$$', 'x = 1', '$$']);
    expect(pending).toBeNull();
    expect(out).toEqual([
      { role: 'assistant-block', content: '$$\nx = 1\n$$', blockKind: 'math' },
    ]);
  });

  it('单行闭合公式 $$x = 1$$ → 立即整块冻结', () => {
    const { pending, out } = feed(['$$x = 1$$']);
    expect(pending).toBeNull();
    expect(out).toEqual([
      { role: 'assistant-block', content: '$$x = 1$$', blockKind: 'math' },
    ]);
  });

  it('公式未闭合：消息结束时也按公式块输出', () => {
    const { pending, out } = feed(['$$', 'x = 1']);
    expect(out).toEqual([]);
    expect(flushPendingBlock(pending)).toEqual([
      { role: 'assistant-block', content: '$$\nx = 1', blockKind: 'math' },
    ]);
  });

  it('表格打断后紧跟公式块：先冻结表格块，再开始公式缓冲', () => {
    const { pending, out } = feed(['| a | b |', '|---|---|', '| 1 | 2 |', '$$', 'x = 1']);
    expect(out).toEqual([
      { role: 'assistant-block', content: '| a | b |\n|---|---|\n| 1 | 2 |', blockKind: 'table' },
    ]);
    expect(pending).toEqual({ kind: 'math', lines: ['$$', 'x = 1'], confirmed: false });
  });

  it('普通行不缓冲：直接冻结', () => {
    const { pending, out } = feed(['hello', 'world']);
    expect(pending).toBeNull();
    expect(out).toEqual([
      { role: 'assistant-line', content: 'hello' },
      { role: 'assistant-line', content: 'world' },
    ]);
  });

  it('代码块：```lang 开、内容入缓冲、``` 闭 → 整块冻结（围栏行不输出）', () => {
    const { pending, out } = feed(['```yaml', 'listen:', '  addr: "1"', '```']);
    expect(out).toEqual([
      { role: 'assistant-block', content: 'listen:\n  addr: "1"', blockKind: 'code', lang: 'yaml' },
    ]);
    expect(pending).toBeNull();
  });

  it('代码块未闭合：消息结束时按代码块输出（带语言）', () => {
    const { pending } = feed(['```js', 'const x = 1', 'console.log(x)']);
    expect(pending).toEqual({
      kind: 'code',
      lines: ['const x = 1', 'console.log(x)'],
      confirmed: true,
      lang: 'js',
    });
    expect(flushPendingBlock(pending)).toEqual([
      { role: 'assistant-block', content: 'const x = 1\nconsole.log(x)', blockKind: 'code', lang: 'js' },
    ]);
  });

  it('空代码块（只有开围栏）不输出', () => {
    const { pending, out } = feed(['```', '```']);
    expect(out).toEqual([]);
    expect(pending).toBeNull();
  });

  it('表格被打断后紧跟代码块：先冻结表格块，再开始代码块缓冲', () => {
    const { pending, out } = feed(['| a | b |', '|---|---|', '| 1 | 2 |', '```go', 'package main']);
    expect(out).toEqual([
      { role: 'assistant-block', content: '| a | b |\n|---|---|\n| 1 | 2 |', blockKind: 'table' },
    ]);
    expect(pending).toEqual({
      kind: 'code',
      lines: ['package main'],
      confirmed: true,
      lang: 'go',
    });
  });
});
