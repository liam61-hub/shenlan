/**
 * 动作级审计事件 — 记录/读取/脱敏/不可关闭语义
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAuditEvent, readAuditEvents, auditLogPath } from '../audit.js';

describe('动作级审计（.shenlan/audit.jsonl）', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shenlan-audit-'));
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('recordAuditEvent 追加 JSONL（时间/工具/参数摘要/命中规则/结果三态）', () => {
    recordAuditEvent({ tool: 'shell', args: { command: 'rm -rf x' }, rule: 'high-risk', result: 'blocked' }, cwd, true);
    recordAuditEvent({ tool: 'write', args: { file_path: 'a.ts' }, rule: 'confirm', result: 'allowed' }, cwd, true);
    const events = readAuditEvents(cwd);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tool: 'shell', rule: 'high-risk', result: 'blocked' });
    expect(events[0]!.time).toBeTypeOf('number');
    expect(events[1]).toMatchObject({ rule: 'confirm', result: 'allowed' });
  });

  it('参数摘要过 maskSensitive 脱敏（API key 不落盘明文）', () => {
    recordAuditEvent({
      tool: 'shell',
      args: { command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123" x' },
      rule: 'confirm',
      result: 'allowed',
    }, cwd, true);
    const [ev] = readAuditEvents(cwd);
    expect(ev!.args).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('auditEnabled=false 时不记录（高危类恒记录，不可关闭）', () => {
    recordAuditEvent({ tool: 'read', args: {}, rule: 'confirm', result: 'allowed' }, cwd, false);
    recordAuditEvent({ tool: 'shell', args: { command: 'rm -rf x' }, rule: 'high-risk', result: 'blocked' }, cwd, false);
    const events = readAuditEvents(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]!.rule).toBe('high-risk');
  });

  it('readAuditEvents 按 limit 返回最近 N 条（倒序）', () => {
    for (let i = 0; i < 5; i++) {
      recordAuditEvent({ tool: 'shell', args: { command: `cmd-${i}` }, rule: 'confirm', result: 'denied' }, cwd, true);
    }
    const events = readAuditEvents(cwd, 3);
    expect(events).toHaveLength(3);
    expect(events[2]!.args).toContain('cmd-4');
  });

  it('无审计文件时返回空数组', () => {
    expect(readAuditEvents(cwd)).toEqual([]);
    expect(auditLogPath(cwd)).toContain('.shenlan');
  });
});
