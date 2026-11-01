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

export type PermissionDecision = 'allow' | 'deny' | 'needs_confirmation';

/** 写操作工具 */

/**
 * 判断工具调用的权限结果
 *
 * @returns allow, deny, or needs_confirmation
 */
export function decidePermission(
  toolName: string,
  config: PermissionConfig,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): PermissionDecision {
  // Explicit deny is authoritative and cannot be bypassed by allow lists or mode.
  if (config.deny.includes(toolName)) return 'deny';

  // Auto Memory is automatically allowed unless explicitly denied above.
  if (toolName === 'memory_save') return 'allow';

  // MCP annotations are advisory, but an unknown external tool must not execute
  // with default permissions without an explicit decision.
  if (toolName.startsWith('mcp__') && annotations?.destructiveHint) return 'needs_confirmation';

  // 明确允许
  if (config.allow.includes(toolName)) return 'allow';

  const mode: PermissionMode = config.mode;

  switch (mode) {
    case 'bypassPermissions':
      // 全部允许，但高风险工具仍需确认
      return HIGH_RISK_TOOLS.has(toolName) ? 'needs_confirmation' : 'allow';

    case 'acceptEdits':
      // 编辑操作自动允许
      if (toolName === 'write' || toolName === 'edit') return 'allow';
      if (READ_TOOLS.has(toolName) || annotations?.readOnlyHint) return 'allow';
      // shell 仍需确认
      return 'needs_confirmation';

    case 'default':
    default:
      // 读操作自动允许，写操作需确认
      if (READ_TOOLS.has(toolName)) return 'allow';
      if (annotations?.readOnlyHint) return 'allow';
      return 'needs_confirmation';
  }
}

/** Backward-compatible prompt predicate; execution paths will migrate to decidePermission. */
export function needsConfirmation(
  toolName: string,
  config: PermissionConfig,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): boolean {
  return decidePermission(toolName, config, annotations) !== 'allow';
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
