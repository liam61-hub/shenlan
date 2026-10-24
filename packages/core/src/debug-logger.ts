/**
 * 调试日志 — 写入 .shenlan/debug-YYYY-MM-DD.log，保留最近 7 天
 *
 * 仅在 SHENLAN_DEBUG=0 环境变量时关闭（默认开启）
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEBUG_ENABLED = process.env.SHENLAN_DEBUG !== '0';
const MAX_DAYS = 7;

function getLogDir(): string {
  const dir = join(process.cwd(), '.shenlan');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getLogPath(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(getLogDir(), `debug-${date}.log`);
}

function cleanupOldLogs(): void {
  try {
    const dir = getLogDir();
    const cutoff = Date.now() - MAX_DAYS * 24 * 3600 * 1000;
    for (const entry of readdirSync(dir)) {
      const match = entry.match(/^debug-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match) continue;
      try {
        const stat = statSync(join(dir, entry));
        if (stat.mtimeMs < cutoff) unlinkSync(join(dir, entry));
      } catch { /* skip */ }
    }
  } catch { /* silent */ }
}

// 启动时写入一条，证明日志系统工作
(function startupLog() {
  if (!DEBUG_ENABLED) return;
  try {
    cleanupOldLogs();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
    appendFileSync(getLogPath(), `\n=== shenlan started [${now}] ===\ncwd: ${process.cwd()}\nargv: ${process.argv.slice(2).join(' ') || '(none)'}\n`, 'utf-8');
  } catch { /* silent */ }
})();

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

export function debugLog(section: string, data: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  try {
    const lines: string[] = [];
    lines.push(`\n=== ${section} [${timestamp()}] ===`);
    for (const [key, value] of Object.entries(data)) {
      const val = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      // Truncate very long values
      const truncated = val.length > 3000 ? val.slice(0, 3000) + '\n... (truncated)' : val;
      lines.push(`${key}: ${truncated}`);
    }
    appendFileSync(getLogPath(), lines.join('\n') + '\n', 'utf-8');
  } catch {
    // 静默失败，不影响主流程
  }
}
