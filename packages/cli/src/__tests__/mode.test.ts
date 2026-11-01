/**
 * Plan Mode 只读命令白名单 + 敏感命令 deny 测试
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ShenlanConfig } from '@shenlan/core';
import { isPlanShellBlocked, isPlanBlocked, setMode, cycleMode } from '../mode.js';

const baseConfig: ShenlanConfig = {
  model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
};

const cfg = {
  ...baseConfig,
  planMode: { readonlyCommands: ['git status', 'git diff', 'git rev-parse', 'node --version', 'ls'] },
};

describe('isPlanShellBlocked — plan 态 shell 白名单', () => {
  afterEach(() => { setMode('default'); });

  it('非 plan 态一律放行（返回 null）', () => {
    setMode('default');
    expect(isPlanShellBlocked('npm install x', cfg)).toBeNull();
    expect(isPlanShellBlocked('rm -rf /', cfg)).toBeNull();
  });

  it('白名单命令前缀匹配放行', () => {
    setMode('plan');
    expect(isPlanShellBlocked('git status', cfg)).toBeNull();
    expect(isPlanShellBlocked('git diff HEAD~1', cfg)).toBeNull();
    expect(isPlanShellBlocked('ls -la', cfg)).toBeNull();
    expect(isPlanShellBlocked('git rev-parse --show-toplevel', cfg)).toBeNull();
    expect(isPlanShellBlocked('node --version', cfg)).toBeNull();
  });

  it('拒绝通过只读白名单前缀串联其它 shell 操作', () => {
    setMode('plan');
    expect(isPlanShellBlocked('git status && echo unsafe', cfg)).toContain('compound');
    expect(isPlanShellBlocked('git status > result.txt', cfg)).toContain('compound');
  });

  it('未命中白名单的命令一律拒绝', () => {
    setMode('plan');
    const r = isPlanShellBlocked('npm install lodash', cfg);
    expect(r).toBeTruthy();
    expect(r).toContain('readonly');
  });

  it('敏感命令无条件 deny（env/printenv/密钥路径读取）', () => {
    setMode('plan');
    const r1 = isPlanShellBlocked('env | grep KEY', cfg);
    expect(r1).toContain('sensitive');
    const r2 = isPlanShellBlocked('cat ~/.ssh/id_rsa', cfg);
    expect(r2).toContain('sensitive');
    const r3 = isPlanShellBlocked('printenv DATABASE_URL', cfg);
    expect(r3).toContain('sensitive');
  });

  it('空命令在 plan 态拒绝', () => {
    setMode('plan');
    expect(isPlanShellBlocked('', cfg)).toBeTruthy();
  });
});

describe('isPlanBlocked — 工具级拦截', () => {
  afterEach(() => { setMode('default'); });

  it('plan 态拦截 write/edit/shell，放行 read', () => {
    setMode('plan');
    expect(isPlanBlocked('write')).toBe(true);
    expect(isPlanBlocked('edit')).toBe(true);
    expect(isPlanBlocked('shell')).toBe(true);
    expect(isPlanBlocked('read')).toBe(false);
  });

  it('非 plan 态不拦截', () => {
    setMode('default');
    expect(isPlanBlocked('write')).toBe(false);
    expect(isPlanBlocked('shell')).toBe(false);
  });
});

describe('cycleMode', () => {
  afterEach(() => { setMode('default'); });

  it('cycles through Plan before Bypass', () => {
    setMode('default');
    expect(cycleMode()).toBe('acceptEdits');
    expect(cycleMode()).toBe('plan');
    expect(cycleMode()).toBe('bypassPermissions');
    expect(cycleMode()).toBe('default');
  });
});
