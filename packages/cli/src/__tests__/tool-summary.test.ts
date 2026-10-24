import { describe, expect, it } from 'vitest';
import { formatToolSummary, TOOL_SUMMARY_MAX_WIDTH, truncateWidth } from '../tool-summary.js';
import { displayWidth } from '../markdown-utils.js';

describe('formatToolSummary', () => {
  it('glob 命中：N file(s) matched', () => {
    const content = '26 file(s) matched:\n  src/a.ts\n  src/b.ts';
    expect(formatToolSummary('glob', '**/*.ts', content, false))
      .toBe('glob "**/*.ts": 26 file(s) matched');
  });

  it('glob 未命中：no matches', () => {
    const content = 'No files matched pattern "**/*.vue"';
    expect(formatToolSummary('glob', '**/*.vue', content, false))
      .toBe('glob "**/*.vue": no matches');
  });

  it('glob 大输出 ref：解析 chars 与 refId', () => {
    const content = '[Ref:a05666a8] Tool glob **/*.ts output (12697 chars)';
    expect(formatToolSummary('glob', '**/*.ts', content, false))
      .toBe('glob "**/*.ts": 12697 chars → Ref:a05666a8');
  });

  it('search：统计输出行数', () => {
    const content = 'src/a.ts\nsrc/b.ts\nsrc/c.ts';
    expect(formatToolSummary('search', 'TODO', content, false))
      .toBe('search "TODO": 3 file(s) matched');
  });

  it('search 未命中：no matches', () => {
    expect(formatToolSummary('search', 'xyz', '(no matches)', false))
      .toBe('search "xyz": no matches');
  });

  it('read 全量读取：解析 (lines 1-N of N) 头，取路径 basename', () => {
    const content = '/Users/edy/work/code/shenlan/package.json (lines 1-103 of 103)\n  1\t{';
    expect(formatToolSummary('read', '/Users/edy/work/code/shenlan/package.json', content, false))
      .toBe('read package.json: 103 lines');
  });

  it('read 部分读取：显示实际行区间', () => {
    const content = 'foo.ts (lines 5-15 of 100)\n  5\t...';
    expect(formatToolSummary('read', 'foo.ts', content, false))
      .toBe('read foo.ts: lines 5-15 of 100');
  });

  it('read 大输出 ref：路径 basename + chars', () => {
    const content = '[Ref:abcd1234] Tool read /x/foo.ts output (9000 chars)';
    expect(formatToolSummary('read', '/x/foo.ts', content, false))
      .toBe('read foo.ts: 9000 chars → Ref:abcd1234');
  });

  it('write/edit：done', () => {
    expect(formatToolSummary('write', '/tmp/foo.txt', 'Successfully wrote 3 lines to /tmp/foo.txt', false))
      .toBe('write foo.txt: done');
    expect(formatToolSummary('edit', 'src/main.ts', 'Successfully edited src/main.ts', false))
      .toBe('edit main.ts: done');
  });

  it('shell：只取输出首行', () => {
    expect(formatToolSummary('shell', 'pwd', '/Users/edy/work/code/shenlan\n', false))
      .toBe('shell: /Users/edy/work/code/shenlan');
  });

  it('agent 成功：✓ [goal] + 摘要首行', () => {
    const s = formatToolSummary('agent', '分析 lecard 架构', '✓ [分析 lecard 架构]\n发现 3 个模块', false);
    expect(s).toMatch(/^agent: ✓ \[分析 lecard 架构\]/);
    expect(s).toContain('发现 3 个模块');
  });

  it('agent 失败：✗ [goal]', () => {
    const s = formatToolSummary('agent', 'xx', '✗ [任务]\n超时', false);
    expect(s).toMatch(/^agent: ✗ \[任务\]/);
  });

  it('错误：行首 ✖ + 错误全文', () => {
    expect(formatToolSummary('read', 'foo', 'Failed to read file: ENOENT', true))
      .toBe('✖ Failed to read file: ENOENT');
  });

  it('错误多行折叠为一行（全文保留）', () => {
    expect(formatToolSummary('shell', 'x', 'Command exited with code 1\nboom', true))
      .toBe('✖ Command exited with code 1 boom');
  });

  it('超长内容截断：显示宽度 ≤ 140 且末尾 …', () => {
    const long = 'x'.repeat(300);
    const s = formatToolSummary('shell', '', long, false);
    expect(displayWidth(s)).toBeLessThanOrEqual(TOOL_SUMMARY_MAX_WIDTH);
    expect(s.endsWith('…')).toBe(true);
  });

  it('CJK 宽字符按显示宽度截断', () => {
    const long = '测'.repeat(300);
    const s = formatToolSummary('shell', '', long, false);
    expect(displayWidth(s)).toBeLessThanOrEqual(TOOL_SUMMARY_MAX_WIDTH);
    expect(s.endsWith('…')).toBe(true);
  });

  it('未知工具回退：name + 首行', () => {
    expect(formatToolSummary('restore', '2026-08-01', 'restored 3 files', false))
      .toBe('restore 2026-08-01: restored 3 files');
  });
});

describe('truncateWidth', () => {
  it('未超宽时原样返回', () => {
    expect(truncateWidth('abc', 10)).toBe('abc');
  });

  it('超宽时按显示宽度截断', () => {
    const s = truncateWidth('一二三四五', 6);
    expect(displayWidth(s)).toBeLessThanOrEqual(6);
    expect(s.endsWith('…')).toBe(true);
  });
});
