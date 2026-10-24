/**
 * /audit 与 shenlan audit 共享的格式化逻辑
 */
import { readAuditEvents } from '@shenlan/core';

/** 单条审计事件的展示行：时间 工具 规则 结果 参数摘要 */
export function formatAuditEvents(cwd: string, limit: number): string[] {
  return readAuditEvents(cwd, limit).map((e) => {
    const t = new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false });
    const tool = e.tool.padEnd(8);
    const rule = e.rule.padEnd(12);
    const result = e.result.padEnd(7);
    return `${t} ${tool} ${rule} ${result} ${e.args.slice(0, 60)}`;
  });
}

/** /audit 报告：最近 10 条 + 总数 */
export function auditReport(cwd: string): string {
  const total = readAuditEvents(cwd, Number.MAX_SAFE_INTEGER).length;
  if (total === 0) return '  No audit events';
  const lines = formatAuditEvents(cwd, 10);
  return `  动作审计（最近 ${lines.length} / 共 ${total}）\n` + lines.map(l => `  ${l}`).join('\n');
}

/** shenlan audit 子命令：打印最近 20 条，退出码 0 */
export async function runAuditCommand(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const lines = formatAuditEvents(cwd, 20);
  if (lines.length === 0) {
    console.log('No audit events');
    return 0;
  }
  for (const line of lines) console.log(`  ${line}`);
  return 0;
}
