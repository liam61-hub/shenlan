/**
 * 权限决策 — 三态模式 + 规则引擎
 *
 * 模式：
 *   - default: 写操作需确认，读操作自动允许
 *   - acceptEdits: 编辑操作自动允许，其他需确认
 *   - bypassPermissions: 全部自动允许
 */
import type { PermissionConfig, PermissionMode } from './config.js';

/** 高风险工具（需要始终确认的操作） */
const HIGH_RISK_TOOLS: Set<string> = new Set([
  // shell 中的危险命令在 execute 阶段拦截，这里只做工具级控制
]);

/** 读操作工具 */
const READ_TOOLS = new Set([
  'read', 'search', 'glob', 'web_search', 'tavily_search', 'web_fetch',
  'pitfall_search', 'ref_outline', 'ref_retrieve', 'view_image',
  'transcribe_media', 'shell_status', 'todo_write', 'update_plan',
]);

/** 写操作工具 */

/**
 * 判断是否需要用户确认
 *
 * @returns true = 需要确认，false = 自动允许
 */
export function needsConfirmation(
  toolName: string,
  config: PermissionConfig,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): boolean {
  // Auto Memory：模型自主保存记忆恒自动允许（对齐 Claude Code，
  // 不弹窗、独立于权限三态与 allow/deny 列表）
  if (toolName === 'memory_save') return false;

  // MCP annotations are advisory, but an unknown external tool must not execute
  // with default permissions without an explicit decision.
  if (toolName.startsWith('mcp__') && annotations?.destructiveHint) return true;

  // 明确允许
  if (config.allow.includes(toolName)) return false;
  // 明确拒绝
  if (config.deny.includes(toolName)) return true;

  const mode: PermissionMode = config.mode;

  switch (mode) {
    case 'bypassPermissions':
      // 全部允许，但高风险工具仍需确认
      return HIGH_RISK_TOOLS.has(toolName);

    case 'acceptEdits':
      // 编辑操作自动允许
      if (toolName === 'write' || toolName === 'edit') return false;
      if (READ_TOOLS.has(toolName) || annotations?.readOnlyHint) return false;
      // shell 仍需确认
      return true;

    case 'default':
    default:
      // 读操作自动允许，写操作需确认
      if (READ_TOOLS.has(toolName)) return false;
      if (annotations?.readOnlyHint) return false;
      return true;
  }
}

/**
 * 获取权限模式的可读描述
 */
export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'bypassPermissions':
      return '全部允许';
    case 'acceptEdits':
      return '允许编辑';
    case 'default':
      return '标准（写操作需确认）';
  }
}
