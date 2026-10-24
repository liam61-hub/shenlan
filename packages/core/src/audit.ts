/**
 * 动作级审计事件（§11）— 项目 .shenlan/audit.jsonl 追加式记录
 *
 * 每条事件：时间、工具、脱敏后的参数摘要、命中规则、结果三态
 * （allowed / denied / blocked）。auditEnabled=false 时跳过普通事件，
 * high-risk 类恒记录（高危动作审计不可关闭）。
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskSensitive } from './security.js';

/** 审计事件（落盘结构） */
export interface AuditEvent {
  /** epoch 毫秒 */
  time: number;
  tool: string;
  /** 脱敏后的参数摘要（JSON 序列化，截断 200 字符） */
  args: string;
  /** 命中规则：plan-mode / high-risk / confirm / pitfall / session-deny 等 */
  rule: string;
  /** 结果三态：allowed（放行执行）/ denied（用户拒绝）/ blocked（策略拦截） */
  result: 'allowed' | 'denied' | 'blocked';
}

/** 审计日志路径（项目级，不落全局） */
export function auditLogPath(cwd: string): string {
  return join(cwd, '.shenlan', 'audit.jsonl');
}

/**
 * 追加一条审计事件。
 * enabled=false 时普通事件跳过；rule='high-risk' 恒记录（§11 不可关闭）。
 * args 传参数对象：内部 JSON 序列化 + maskSensitive 脱敏 + 截断 200 字符。
 */
export function recordAuditEvent(
  ev: Omit<AuditEvent, 'time' | 'args'> & { args: Record<string, unknown> },
  cwd: string,
  enabled: boolean,
): void {
  if (!enabled && ev.rule !== 'high-risk') return;
  const dir = join(cwd, '.shenlan');
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    time: Date.now(),
    tool: ev.tool,
    args: maskSensitive(JSON.stringify(ev.args)).slice(0, 200),
    rule: ev.rule,
    result: ev.result,
  });
  appendFileSync(auditLogPath(cwd), line + '\n', 'utf-8');
}

/** 读取最近 limit 条事件（时间正序返回，即最新在末尾）；无文件返回空数组 */
export function readAuditEvents(cwd: string, limit = 20): AuditEvent[] {
  const p = auditLogPath(cwd);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
  const events: AuditEvent[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch { /* 跳过损坏行 */ }
  }
  return events;
}
