/**
 * /audit 与 shenlan audit 的共享格式化逻辑测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAuditEvent } from '@shenlan/core';
import { formatAuditEvents, auditReport } from './audit.js';

describe('audit 命令共享逻辑', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shenlan-audit-cmd-'));
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('formatAuditEvents 格式化时间/工具/规则/结果/摘要', () => {
    recordAuditEvent({ tool: 'shell', args: { command: 'rm -rf x' }, rule: 'high-risk', result: 'blocked' }, cwd, true);
    const lines = formatAuditEvents(cwd, 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('shell');
    expect(lines[0]).toContain('high-risk');
    expect(lines[0]).toContain('blocked');
    expect(lines[0]).toContain('"command":"[REDACTED]"');
    expect(lines[0]).not.toContain('rm -rf x');
  });

  it('auditReport 无事件时给出空态说明', () => {
    expect(auditReport(cwd)).toContain('No audit events');
  });

  it('auditReport 含最近事件与总数', () => {
    for (let i = 0; i < 3; i++) {
      recordAuditEvent({ tool: 'write', args: { file_path: `f${i}.ts` }, rule: 'confirm', result: 'allowed' }, cwd, true);
    }
    const report = auditReport(cwd);
    expect(report).toContain('3');
    expect(report).toContain('write');
    expect(report).toContain('confirm');
  });
});
