import { describe, expect, it } from 'vitest';
import { splitStreaming, capLine } from '../streaming.js';
import { displayWidth } from '../markdown-utils.js';

describe('splitStreaming（流式整行/未完成 tail 拆分）', () => {
  it('无换行：全部是 tail', () => {
    expect(splitStreaming('hello')).toEqual({ completed: [], tail: 'hello' });
  });

  it('完整行 + 未完成 tail', () => {
    expect(splitStreaming('line1\nline2\npart')).toEqual({
      completed: ['line1', 'line2'],
      tail: 'part',
    });
  });

  it('以换行结尾：整行全部完成，tail 为空', () => {
    expect(splitStreaming('a\nb\n')).toEqual({ completed: ['a', 'b'], tail: '' });
  });

  it('连续换行保留空行（空行渲染为空白行）', () => {
    expect(splitStreaming('a\n\nb')).toEqual({ completed: ['a', ''], tail: 'b' });
  });

  it('跨 token 累积：tail 与前一个 action 的 tail 拼接', () => {
    const first = splitStreaming('hel');
    expect(first).toEqual({ completed: [], tail: 'hel' });
    const second = splitStreaming(first.tail + 'lo\nworld');
    expect(second).toEqual({ completed: ['hello'], tail: 'world' });
  });

  it('\r\n / \r 统一为 \n', () => {
    expect(splitStreaming('a\r\nb\rc')).toEqual({ completed: ['a', 'b'], tail: 'c' });
  });
});

describe('capLine（动态区单行截断）', () => {
  it('短文本原样返回', () => {
    expect(capLine('hello', 10)).toBe('hello');
  });

  it('超长文本截断并追加 …', () => {
    expect(capLine('hello world', 8)).toBe('hello w…');
  });

  it('CJK 按 2 格显示宽度截断，不按字符数', () => {
    expect(displayWidth('中文测试')).toBe(8);
    expect(capLine('中文测试', 6)).toBe('中文…');
    expect(capLine('中文', 4)).toBe('中文'); // 总宽 ≤ maxWidth 不截断
  });

  it('边界：maxWidth=1 / 0', () => {
    expect(capLine('abc', 1)).toBe('…');
    expect(capLine('abc', 0)).toBe('');
  });
});
