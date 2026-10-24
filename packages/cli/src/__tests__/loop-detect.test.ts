import { describe, it, expect } from 'vitest';
import {
  computeToolSig,
  RepeatTracker,
  OutcomeTracker,
  LOOP_REPEAT_THRESHOLD,
} from '../loop-detect.js';

describe('computeToolSig', () => {
  it('read：同文件不同 offset/limit 签名不同，完全相同才相同', () => {
    const base = { file_path: '/a.txt', offset: 1, limit: 100 };
    const same = { file_path: '/a.txt', offset: 1, limit: 100 };
    expect(computeToolSig('read', JSON.stringify(base))).toBe(
      computeToolSig('read', JSON.stringify(same)),
    );
    expect(computeToolSig('read', JSON.stringify(base))).not.toBe(
      computeToolSig('read', JSON.stringify({ ...base, offset: 101 })),
    );
    expect(computeToolSig('read', JSON.stringify(base))).not.toBe(
      computeToolSig('read', JSON.stringify({ ...base, limit: 50 })),
    );
    expect(computeToolSig('read', JSON.stringify(base))).not.toBe(
      computeToolSig('read', JSON.stringify({ ...base, file_path: '/b.txt' })),
    );
  });

  it('edit：不同 old/new 签名不同', () => {
    const base = { file_path: '/a.ts', old_string: 'foo', new_string: 'bar' };
    expect(computeToolSig('edit', JSON.stringify(base))).toBe(
      computeToolSig('edit', JSON.stringify({ ...base })),
    );
    expect(computeToolSig('edit', JSON.stringify(base))).not.toBe(
      computeToolSig('edit', JSON.stringify({ ...base, old_string: 'fo' })),
    );
    expect(computeToolSig('edit', JSON.stringify(base))).not.toBe(
      computeToolSig('edit', JSON.stringify({ ...base, new_string: 'baz' })),
    );
  });

  it('shell：空白差异与 timeout 差异不影响签名', () => {
    expect(
      computeToolSig('shell', JSON.stringify({ command: '  ls   -la ', timeout: 30000 })),
    ).toBe(
      computeToolSig('shell', JSON.stringify({ command: 'ls -la', timeout: 60000 })),
    );
    expect(computeToolSig('shell', JSON.stringify({ command: 'ls -la' }))).not.toBe(
      computeToolSig('shell', JSON.stringify({ command: 'ls -lb' })),
    );
  });

  it('search：忽略 output_mode，path + pattern 参与签名', () => {
    expect(
      computeToolSig('search', JSON.stringify({ pattern: 'foo', path: 'src', output_mode: 'content' })),
    ).toBe(
      computeToolSig('search', JSON.stringify({ pattern: 'foo', path: 'src', output_mode: 'count' })),
    );
    expect(computeToolSig('search', JSON.stringify({ pattern: 'foo', path: 'src' }))).not.toBe(
      computeToolSig('search', JSON.stringify({ pattern: 'bar', path: 'src' })),
    );
  });

  it('write：内容参与签名', () => {
    const base = { file_path: '/a.txt', content: 'hello' };
    expect(computeToolSig('write', JSON.stringify(base))).toBe(
      computeToolSig('write', JSON.stringify({ ...base })),
    );
    expect(computeToolSig('write', JSON.stringify(base))).not.toBe(
      computeToolSig('write', JSON.stringify({ ...base, content: 'world' })),
    );
  });

  it('未知工具与 MCP 工具按排序 JSON 稳定签名', () => {
    const a = { z: 1, a: [1, 2], b: { y: 2, x: 1 } };
    const b = { b: { x: 1, y: 2 }, a: [1, 2], z: 1 };
    expect(computeToolSig('mcp__foo', JSON.stringify(a))).toBe(
      computeToolSig('mcp__foo', JSON.stringify(b)),
    );
    // 工具名参与签名
    expect(computeToolSig('mcp__foo', JSON.stringify(a))).not.toBe(
      computeToolSig('mcp__bar', JSON.stringify(a)),
    );
    // 参数不同 → 签名不同
    expect(computeToolSig('mcp__foo', JSON.stringify(a))).not.toBe(
      computeToolSig('mcp__foo', JSON.stringify({ ...a, z: 2 })),
    );
  });

  it('非法 JSON 回退为原始字符串 trim 后 md5，稳定', () => {
    expect(computeToolSig('read', '  {oops')).toBe(computeToolSig('read', '{oops'));
    expect(computeToolSig('read', 'bad json')).not.toBe(computeToolSig('read', 'bad json2'));
  });

  it('LOOP_REPEAT_THRESHOLD 保持 5', () => {
    expect(LOOP_REPEAT_THRESHOLD).toBe(5);
  });
});

describe('RepeatTracker', () => {
  it('连续轮次续接、跨轮中断重置、同轮多次递增', () => {
    const t = new RepeatTracker();
    const a = 'sig-a';
    const b = 'sig-b';

    expect(t.track(a, 0)).toBe(1); // 首见
    expect(t.track(a, 0)).toBe(2); // 同轮递增
    expect(t.track(a, 1)).toBe(3); // 相邻轮续接
    expect(t.track(b, 2)).toBe(1); // 新签名
    expect(t.track(a, 3)).toBe(1); // a 上轮是 1，轮 3 ≠ 2 → 中断重置
    expect(t.track(a, 3)).toBe(2); // 同轮递增
    expect(t.track(a, 4)).toBe(3); // 相邻轮续接
  });
});

describe('OutcomeTracker', () => {
  it('首次 false、内容不变 false、内容变化 true、成败翻转 true', () => {
    const o = new OutcomeTracker();
    const s = 'sig';

    expect(o.changed(s, true, 'same')).toBe(false); // 首见
    expect(o.changed(s, true, 'same')).toBe(false); // 无变化
    expect(o.changed(s, true, 'different')).toBe(true); // 内容变化
    expect(o.changed(s, false, 'different')).toBe(true); // 成败翻转
    expect(o.changed(s, false, 'different')).toBe(false); // 无变化
  });
});
