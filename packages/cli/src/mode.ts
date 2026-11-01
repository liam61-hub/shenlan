/**
 * 模式管理 — 四态循环 + Plan Mode
 *
 * default → acceptEdits → plan → bypassPermissions → default
 */
import type { PermissionMode, ShenlanConfig } from '@shenlan/core';

/** plan 态无条件 deny 的敏感命令（防泄密；先于白名单判定） */
const SENSITIVE_COMMAND_PATTERNS: RegExp[] = [
  /^\s*env\b/i,                                   // env 变量导出
  /^\s*printenv\b/i,                              // printenv
  /^\s*set\b/i,                                   // shell set（Windows cmd 变量）
  /^\s*(cat|type|get-content)\b[^\r\n]*\.env\b/i, // 读取 .env
  /\.ssh\//i,                                     // ~/.ssh 路径读取
  /id_rsa|id_ed25519/i,                           // 私钥文件名
  /\.pem\b|\.key\b/i,                             // 证书/密钥文件
  /credentials|credential\.json/i,                // 凭据文件
];

/** 运行模式（扩展了权限三态 + plan） */
export type RunMode = PermissionMode | 'plan';

let currentMode: RunMode = 'default';

export function getMode(): RunMode {
  return currentMode;
}

export function setMode(mode: RunMode): void {
  currentMode = mode;
}

/** 四态循环切换 */
export function cycleMode(): RunMode {
  const order: RunMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
  const idx = order.indexOf(currentMode);
  currentMode = order[(idx + 1) % order.length];
  return currentMode;
}

/** 模式显示名 */
export function modeLabel(mode: RunMode): string {
  switch (mode) {
    case 'default': return 'NORMAL';
    case 'acceptEdits': return 'ACCEPT EDITS';
    case 'bypassPermissions': return 'BYPASS';
    case 'plan': return 'PLAN';
  }
}

/** plan 模式下是否阻止某操作 */
export function isPlanBlocked(toolName: string): boolean {
  if (currentMode !== 'plan') return false;
  // plan 态阻止所有写操作
  return ['write', 'edit', 'shell'].includes(toolName);
}

/**
 * plan 态 shell 命令级判定：返回 null = 放行（白名单命中），否则返回拦截原因。
 * 判定顺序：敏感命令无条件 deny → 白名单前缀匹配 → 未命中一律拒绝。
 */
export function isPlanShellBlocked(command: string, config: ShenlanConfig): string | null {
  if (currentMode !== 'plan') return null;

  const trimmed = command.trim();
  for (const pattern of SENSITIVE_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `sensitive command denied in plan mode: "${trimmed.slice(0, 80)}"`;
    }
  }

  // A read-only prefix must not authorize a chained command, redirection, or substitution.
  if (/[\r\n;&|<>`$()]/u.test(trimmed)) {
    return `compound shell syntax denied in plan mode: "${trimmed.slice(0, 80)}"`;
  }

  const whitelist = config.planMode?.readonlyCommands ?? [];
  for (const allowed of whitelist) {
    if (trimmed === allowed || trimmed.startsWith(allowed + ' ')) return null;
  }
  return `shell command not in planMode.readonlyCommands whitelist: "${trimmed.slice(0, 80)}" — read-only in plan mode`;
}
