import { describe, expect, it } from 'vitest';
import {
  buildConfirmTitle,
  buildConfirmDetail,
  buildConfirmOptions,
} from '../confirm-options.js';

describe('buildConfirmTitle（Codex CLI 样式标题）', () => {
  it('按类型返回对应标题', () => {
    expect(buildConfirmTitle('edit')).toBe('Would you like to make the following edits?');
    expect(buildConfirmTitle('command')).toBe('Would you like to run the following command?');
    expect(buildConfirmTitle('plan')).toBe('Implement this plan?');
  });
});

describe('buildConfirmDetail', () => {
  it('edit 列出文件路径', () => {
    const detail = buildConfirmDetail('edit', { paths: ['/tmp/a.txt', '/tmp/b.txt'] });
    expect(detail).toEqual(['/tmp/a.txt', '/tmp/b.txt']);
  });

  it('command 保留命令原文（超长换行截断）', () => {
    const detail = buildConfirmDetail('command', { command: 'ls -la' });
    expect(detail).toEqual(['ls -la']);

    const long = buildConfirmDetail('command', {
      command: 'rm -f /tmp/x && npm run build 2>&1 | tail -8 && npm test 2>&1 | tail -8',
    });
    expect(long.length).toBeGreaterThan(0);
    expect(long.join(' ')).toContain('npm run build');
  });

  it('未知类型返回空数组', () => {
    expect(buildConfirmDetail('plan', {})).toEqual([]);
  });
});

describe('buildConfirmOptions', () => {
  it('edit：Yes / 这些文件不再询问 / 说明原因', () => {
    const opts = buildConfirmOptions('edit', { paths: ['/tmp/a.txt'] });
    expect(opts.map(o => o.value)).toEqual(['allow', 'allow_paths', 'feedback']);
    expect(opts[0].key).toBe('y');
    expect(opts[1].key).toBe('a');
    expect(opts[2].key).toBe('esc');
    expect(opts[1].label).toContain('Allow this path');
  });

  it('command：Yes / 同类命令不再询问（含前缀）/ 说明原因', () => {
    const opts = buildConfirmOptions('command', { prefix: 'npm run build' });
    expect(opts.map(o => o.value)).toEqual(['allow', 'allow_prefix', 'feedback']);
    expect(opts[1].key).toBe('p');
    expect(opts[1].label).toContain('npm run build');
  });

  it('plan：三个实施选项', () => {
    const opts = buildConfirmOptions('plan');
    expect(opts.map(o => o.value)).toEqual(['allow', 'allow_clear', 'deny']);
    expect(opts[0].label).toBe('Yes, implement this plan');
    expect(opts[2].label).toBe('No, stay in Plan mode');
  });

  it('中文动作类型对应不同选项，破坏性工具无会话授权', () => {
    expect(buildConfirmTitle('create', 'zh-CN')).toContain('创建');
    expect(buildConfirmTitle('edit', 'zh-CN')).toContain('修改');
    expect(buildConfirmOptions('external', {}, 'zh-CN').map(o => o.value)).toEqual(['allow', 'allow_session', 'feedback']);
    expect(buildConfirmOptions('destructive', {}, 'zh-CN').map(o => o.value)).toEqual(['allow', 'feedback']);
    expect(buildConfirmOptions('plan', {}, 'zh-CN')[0].label).toBe('实施此计划');
  });
});
