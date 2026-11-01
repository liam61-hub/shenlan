/**
 * 调试日志 — 写入 .shenlan/debug-YYYY-MM-DD.log，保留最近 7 天
 *
 * 仅在 SHENLAN_DEBUG=1 时显式启用；日志保留最近 7 天。
 */
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeLogMetadata, sanitizeLogSection } from './log-sanitizer.js';

const DEBUG_ENABLED = process.env.SHENLAN_DEBUG === '1';
const MAX_DAYS = 7;
const MAX_LOG_BYTES = 256 * 1024;

function getLogDir(): string {
  const dir = join(process.env.SHENLAN_DEBUG_LOG_DIR || process.cwd(), '.shenlan');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch { /* keep diagnostics best-effort */ }
  }
  return dir;
}

function getLogPath(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(getLogDir(), `debug-${date}.log`);
}

function appendBoundedLog(text: string): void {
  const path = getLogPath();
  const data = Buffer.from(text, 'utf-8');
  const fd = openSync(path, 'a', 0o600);
  try {
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    if (fstatSync(fd).size + data.byteLength > MAX_LOG_BYTES) return;
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
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
    appendBoundedLog(`\n=== shenlan started [${now}] ===\n`);
  } catch { /* silent */ }
})();

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

export function debugLog(section: string, data: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  try {
    const lines: string[] = [];
    lines.push(`\n=== ${sanitizeLogSection(section)} [${timestamp()}] ===`);
    for (const [key, value] of Object.entries(sanitizeLogMetadata(data))) {
      lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    appendBoundedLog(lines.join('\n') + '\n');
  } catch {
    // 静默失败，不影响主流程
  }
}
