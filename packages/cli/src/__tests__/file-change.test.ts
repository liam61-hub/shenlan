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
      lines: [
        { text: 'line1', kind: 'add', oldLine: null, newLine: 1 },
        { text: 'line2', kind: 'add', oldLine: null, newLine: 2 },
      ],
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

  it('覆盖已有文件时只预览变化行，并分别标记删除、添加和原始行号', () => {
    const card = buildFileChange('write', {
      file_path: 'src/config.json',
      content: 'same\nadded\nkeep\nnew ending',
    }, true, 'same\nremoved\nkeep\nold ending');
    expect(card).toEqual({
      path: 'src/config.json',
      kind: 'update',
      lines: [
        { text: 'removed', kind: 'remove', oldLine: 2, newLine: null },
        { text: 'added', kind: 'add', oldLine: null, newLine: 2 },
        { text: 'old ending', kind: 'remove', oldLine: 4, newLine: null },
        { text: 'new ending', kind: 'add', oldLine: null, newLine: 4 },
      ],
      truncated: false,
    });
  });

  it('无法读取已有文件时不把整份新内容误显示为新增行', () => {
    const card = buildFileChange('write', {
      file_path: 'src/private.json', content: '{\n  "value": 2\n}',
    }, true);
    expect(card?.lines).toEqual([{
      text: 'Change preview unavailable (original file could not be read)',
      kind: 'notice', oldLine: null, newLine: null,
    }]);
  });

  it('超过 60 行 → 前 60 行 + 截断标记行，truncated=true', () => {
    const content = Array.from({ length: WRITE_PREVIEW_MAX_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    const card = buildFileChange('write', { file_path: 'big.txt', content }, false);
    expect(card?.truncated).toBe(true);
    expect(card?.lines).toHaveLength(WRITE_PREVIEW_MAX_LINES + 1);
    expect(card?.lines[WRITE_PREVIEW_MAX_LINES]).toEqual({ text: '… (5 more lines)', kind: 'truncated', oldLine: null, newLine: null });
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
      lines: [{ text: '', kind: 'add', oldLine: null, newLine: 1 }],
      truncated: false,
    });
  });
});

describe('buildFileChange — edit 卡片', () => {
  it('恒为 update；基于唯一匹配位置标记旧、新行号', () => {
    const card = buildFileChange('edit', {
      file_path: 'src/main.ts',
      old_string: '旧行1\n旧行2',
      new_string: '新行1',
    }, false, '前置\n旧行1\n旧行2\n后置');
    expect(card).toEqual({
      path: 'src/main.ts',
      kind: 'update',
      lines: [
        { text: '旧行1', kind: 'remove', oldLine: 2, newLine: null },
        { text: '旧行2', kind: 'remove', oldLine: 3, newLine: null },
        { text: '新行1', kind: 'add', oldLine: null, newLine: 2 },
      ],
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
    expect(card?.lines[EDIT_PREVIEW_MAX_LINES]).toEqual({ text: '… (8 more lines)', kind: 'truncated', oldLine: null, newLine: null });
    expect(card?.lines.slice(0, EDIT_PREVIEW_MAX_LINES).every((l) => l.kind === 'remove')).toBe(true);
  });

  it('空 old/new → 各一条空标记行', () => {
    const card = buildFileChange('edit', {
      file_path: 'a.ts',
      old_string: '',
      new_string: '',
    }, true);
    expect(card?.lines).toEqual([
      { text: '', kind: 'remove', oldLine: null, newLine: null },
      { text: '', kind: 'add', oldLine: null, newLine: null },
    ]);
  });

  it('重复或缺失原文时不猜行号', () => {
    const args = { file_path: 'a.ts', old_string: 'same', new_string: 'changed' };
    const repeated = buildFileChange('edit', args, true, 'same\nx\nsame');
    const missing = buildFileChange('edit', args, true);
    expect(repeated?.lines.map(line => [line.oldLine, line.newLine])).toEqual([[null, null], [null, null]]);
    expect(missing?.lines.map(line => [line.oldLine, line.newLine])).toEqual([[null, null], [null, null]]);
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
