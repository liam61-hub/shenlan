/**
 * .env 文件加载 — 项目 cwd/.env + 全局 ~/.shenlan/.env
 *
 * 只补充 process.env 中尚未设置的键（真实 shell 环境变量优先）。
 * 优先级：真实环境变量 > 项目 .env > 全局 .env > 配置文件。
 * 解析规则：跳过空行与 # 注释、容忍 export 前缀、剥离引号与 \r、
 * 忽略无 = 的行；损坏文件不抛错（debug 日志），绝不阻塞启动。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globalConfigPath } from './config.js';
import { debugLog } from './debug-logger.js';

/** 解析一行 KEY=VALUE 并写入环境（真实环境变量已存在时跳过） */
function applyLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const cleaned = trimmed.replace(/^export\s+/i, '');
  const eq = cleaned.indexOf('=');
  if (eq <= 0) return;
  const key = cleaned.slice(0, eq).trim();
  let value = cleaned.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!key) return;
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

/**
 * 加载 .env 文件（项目优先，全局兜底）。
 * 返回实际读取到的文件路径列表。
 */
export function loadDotEnvFiles(cwd = process.cwd()): string[] {
  const files = [
    join(cwd, '.env'),
    join(dirname(globalConfigPath()), '.env'),
  ];
  const loaded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const content = readFileSync(file, 'utf-8');
      for (const rawLine of content.split(/\r?\n/)) {
        applyLine(rawLine);
      }
      loaded.push(file);
    } catch (err) {
      debugLog('dotenv read failed', { file, error: String(err) });
    }
  }
  return loaded;
}
