import { describe, it, expect } from 'vitest';
import { needsConfirmation, describePermissionMode } from '../permission.js';
import type { PermissionConfig } from '../config.js';

describe('needsConfirmation', () => {
  const baseCfg: PermissionConfig = { mode: 'default', allow: [], deny: [] };

  it('read tool auto-allowed in default mode', () => {
    expect(needsConfirmation('read', baseCfg)).toBe(false);
  });

  it('search tool auto-allowed in default mode', () => {
    expect(needsConfirmation('search', baseCfg)).toBe(false);
  });

  it('write tool needs confirmation in default mode', () => {
    expect(needsConfirmation('write', baseCfg)).toBe(true);
  });

  it('shell tool needs confirmation in default mode', () => {
    expect(needsConfirmation('shell', baseCfg)).toBe(true);
  });

  it('edit auto-allowed in acceptEdits mode', () => {
    const cfg: PermissionConfig = { mode: 'acceptEdits', allow: [], deny: [] };
    expect(needsConfirmation('edit', cfg)).toBe(false);
    expect(needsConfirmation('write', cfg)).toBe(false);
    expect(needsConfirmation('shell', cfg)).toBe(true);
  });

  it('everything allowed in bypassPermissions mode', () => {
    const cfg: PermissionConfig = { mode: 'bypassPermissions', allow: [], deny: [] };
    expect(needsConfirmation('shell', cfg)).toBe(false);
    expect(needsConfirmation('write', cfg)).toBe(false);
  });

  it('explicit allow overrides mode', () => {
    const cfg: PermissionConfig = { mode: 'default', allow: ['shell'], deny: [] };
    expect(needsConfirmation('shell', cfg)).toBe(false);
  });

  it('explicit deny overrides mode', () => {
    const cfg: PermissionConfig = { mode: 'bypassPermissions', allow: [], deny: ['write'] };
    expect(needsConfirmation('write', cfg)).toBe(true);
  });

  it('memory_save 恒自动允许（独立于权限三态与 deny 列表）', () => {
    expect(needsConfirmation('memory_save', baseCfg)).toBe(false);
    expect(needsConfirmation('memory_save', { ...baseCfg, mode: 'acceptEdits' })).toBe(false);
    expect(needsConfirmation('memory_save', { ...baseCfg, mode: 'bypassPermissions' })).toBe(false);
    expect(needsConfirmation('memory_save', { ...baseCfg, deny: ['memory_save'] })).toBe(false);
  });

  it('MCP 注解控制只读与破坏性审批，未知工具保守确认', () => {
    expect(needsConfirmation('mcp__srv__unknown', baseCfg)).toBe(true);
    expect(needsConfirmation('mcp__srv__read', baseCfg, { readOnlyHint: true })).toBe(false);
    expect(needsConfirmation('mcp__srv__write', baseCfg, { readOnlyHint: false })).toBe(true);
    expect(needsConfirmation('mcp__srv__destroy', { ...baseCfg, mode: 'bypassPermissions' }, { destructiveHint: true })).toBe(true);
  });

  it('未知内置工具和恢复操作需要确认，已知只读工具自动执行', () => {
    expect(needsConfirmation('restore', baseCfg)).toBe(true);
    expect(needsConfirmation('unknown_tool', baseCfg)).toBe(true);
    expect(needsConfirmation('glob', baseCfg)).toBe(false);
  });
});

describe('describePermissionMode', () => {
  it('returns correct labels', () => {
    expect(describePermissionMode('default')).toBe('标准（写操作需确认）');
    expect(describePermissionMode('acceptEdits')).toBe('允许编辑');
    expect(describePermissionMode('bypassPermissions')).toBe('全部允许');
  });
});
