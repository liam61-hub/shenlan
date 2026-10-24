/**
 * 高危命令检测（提取后供 shell 执行内拦截与 repl 预检共用）
 */
import { describe, it, expect } from 'vitest';
import { isHighRiskCommand, HIGH_RISK_PATTERNS } from '../tools/shell.js';

describe('isHighRiskCommand — 高危命令检测', () => {
  it('rm -rf / git push --force / chmod 777 / dd 写设备命中', () => {
    expect(isHighRiskCommand('rm -rf node_modules')).toBeTruthy();
    expect(isHighRiskCommand('rm -fr /tmp/x')).toBeTruthy();
    expect(isHighRiskCommand('git push --force origin main')).toBeTruthy();
    expect(isHighRiskCommand('git reset --hard HEAD~1')).toBeTruthy();
    expect(isHighRiskCommand('chmod -R 777 /var/www')).toBeTruthy();
    expect(isHighRiskCommand('dd if=/dev/zero of=/dev/sda')).toBeTruthy();
  });

  it('普通命令不命中', () => {
    expect(isHighRiskCommand('git status')).toBeNull();
    expect(isHighRiskCommand('git diff')).toBeNull();
    expect(isHighRiskCommand('npm run build')).toBeNull();
    expect(isHighRiskCommand('ls -la')).toBeNull();
  });

  it('命中时返回 pattern 源文本供提示', () => {
    const hit = isHighRiskCommand('rm -rf /tmp/x');
    expect(hit).toBeTruthy();
    expect(HIGH_RISK_PATTERNS).toContain(hit);
  });

  it('空命令不命中', () => {
    expect(isHighRiskCommand('')).toBeNull();
  });
});
