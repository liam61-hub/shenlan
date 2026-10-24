import { describe, expect, it } from 'vitest';
import {
  buildFileChange,
  WRITE_PREVIEW_MAX_LINES,
  EDIT_PREVIEW_MAX_LINES,
} from '../file-change.js';

describe('buildFileChange — write 卡片', () => {
  it('执行前文件不存在 → add + 新内容预览', () => {
    const card = buildFileChange('write', {
      file_path: '/tmp/new.txt',
      content: 'line1\nline2',
    }, false);
    expect(card).toEqual({
      path: '/tmp/new.txt',
      kind: 'add',
      lines: ['line1', 'line2'],
      truncated: false,
    });
  });

  it('执行前文件已存在 → update', () => {
    const card = buildFileChange('write', {
      file_path: '/tmp/existing.txt',
      content: 'x',
    }, true);
    expect(card?.kind).toBe('update');
  });

  it('超过 60 行 → 前 60 行 + 截断标记行，truncated=true', () => {
    const content = Array.from({ length: WRITE_PREVIEW_MAX_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    const card = buildFileChange('write', { file_path: 'big.txt', content }, false);
    expect(card?.truncated).toBe(true);
    expect(card?.lines).toHaveLength(WRITE_PREVIEW_MAX_LINES + 1);
    expect(card?.lines[WRITE_PREVIEW_MAX_LINES]).toBe('… (5 more lines)');
  });

  it('恰好 60 行 → 不截断', () => {
    const content = Array.from({ length: WRITE_PREVIEW_MAX_LINES }, (_, i) => `line ${i}`).join('\n');
    const card = buildFileChange('write', { file_path: 'exact.txt', content }, false);
    expect(card?.truncated).toBe(false);
    expect(card?.lines).toHaveLength(WRITE_PREVIEW_MAX_LINES);
  });

  it('空内容 → 单空行预览，不截断', () => {
    const card = buildFileChange('write', { file_path: 'empty.txt', content: '' }, false);
    expect(card).toEqual({
      path: 'empty.txt',
      kind: 'add',
      lines: [''],
      truncated: false,
    });
  });
});

describe('buildFileChange — edit 卡片', () => {
  it('恒为 update，预览为 - old + new 块', () => {
    const card = buildFileChange('edit', {
      file_path: 'src/main.ts',
      old_string: '旧行1\n旧行2',
      new_string: '新行1',
    }, false);
    expect(card).toEqual({
      path: 'src/main.ts',
      kind: 'update',
      lines: ['- 旧行1', '- 旧行2', '+ 新行1'],
      truncated: false,
    });
  });

  it('-/+ 块合计超过 40 行 → 前 40 行 + 截断标记，truncated=true', () => {
    const oldStr = Array.from({ length: EDIT_PREVIEW_MAX_LINES }, (_, i) => `old ${i}`).join('\n');
    const newStr = Array.from({ length: 8 }, (_, i) => `new ${i}`).join('\n');
    const card = buildFileChange('edit', {
      file_path: 'a.ts',
      old_string: oldStr,
      new_string: newStr,
    }, true);
    expect(card?.truncated).toBe(true);
    expect(card?.lines).toHaveLength(EDIT_PREVIEW_MAX_LINES + 1);
    expect(card?.lines[EDIT_PREVIEW_MAX_LINES]).toBe('… (8 more lines)');
    expect(card?.lines.slice(0, EDIT_PREVIEW_MAX_LINES).every((l) => l.startsWith('- '))).toBe(true);
  });

  it('空 old/new → 各一条空标记行', () => {
    const card = buildFileChange('edit', {
      file_path: 'a.ts',
      old_string: '',
      new_string: '',
    }, true);
    expect(card?.lines).toEqual(['- ', '+ ']);
  });
});

describe('buildFileChange — 边界与降级', () => {
  it('缺 file_path → null', () => {
    expect(buildFileChange('write', { content: 'x' }, false)).toBeNull();
    expect(buildFileChange('edit', { old_string: 'a', new_string: 'b' }, true)).toBeNull();
    expect(buildFileChange('write', { file_path: '', content: 'x' }, false)).toBeNull();
  });

  it('非 write/edit 工具 → null', () => {
    expect(buildFileChange('read', { file_path: 'a.txt' }, false)).toBeNull();
    expect(buildFileChange('shell', { command: 'echo hi' }, false)).toBeNull();
    expect(buildFileChange('glob', { pattern: '**/*' }, false)).toBeNull();
  });
});
