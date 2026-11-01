import { describe, expect, it } from 'vitest';
import { approvalLanguage, commandGrant, commandMatchesGrant, isAutoAllowedReadOnlyCommand } from '../approval-policy.js';

describe('approval policy', () => {
  it('uses the user task language and falls back for code-only input', () => {
    expect(approvalLanguage('请修改这个文件', 'en')).toBe('zh-CN');
    expect(approvalLanguage('Please edit this file', 'zh-CN')).toBe('en');
    expect(approvalLanguage('npm run build', 'zh-CN')).toBe('zh-CN');
  });

  it('never grants a command prefix for compound or appended commands', () => {
    const stable = commandGrant('git status --short');
    expect(stable.family).toBe(true);
    expect(commandMatchesGrant('git status --porcelain=v1', stable)).toBe(true);
    expect(commandMatchesGrant('git status --short && echo unsafe', stable)).toBe(false);

    const exact = commandGrant('echo okay');
    expect(exact.family).toBe(false);
    expect(commandMatchesGrant('echo okay; echo unsafe', exact)).toBe(false);
    expect(commandGrant('npm run build && echo unsafe').family).toBe(false);
  });

  it('auto-allows only the exact low-risk git status command', () => {
    expect(isAutoAllowedReadOnlyCommand('pwd')).toBe(true);
    expect(isAutoAllowedReadOnlyCommand('git status')).toBe(true);
    expect(isAutoAllowedReadOnlyCommand('git status --short')).toBe(true);
    expect(isAutoAllowedReadOnlyCommand('git status --porcelain --short')).toBe(false);
    expect(isAutoAllowedReadOnlyCommand('git status --porcelain -b --short')).toBe(true);
    expect(isAutoAllowedReadOnlyCommand(' git   status --porcelain -b --short ')).toBe(true);
    expect(isAutoAllowedReadOnlyCommand('git status --porcelain -b --short && echo unsafe')).toBe(false);
    expect(isAutoAllowedReadOnlyCommand('git clean -fd')).toBe(false);
  });
});
