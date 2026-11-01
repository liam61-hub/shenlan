import type { PermissionConfig } from '../config.js';
import { recordAuditEvent } from '../audit.js';
import { decidePermission, type PermissionDecision } from '../permission.js';
import { executeToolWithTimeout } from './timeout.js';
import { getTool } from './index.js';
import { validateToolArguments } from './schema-validation.js';

export interface ToolApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  decision: 'needs_confirmation';
}

export interface ToolExecutionOptions {
  permissions: PermissionConfig;
  cwd?: string;
  auditEnabled?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  approve?: (request: ToolApprovalRequest) => Promise<boolean>;
  additionalDecision?: (toolName: string, args: Record<string, unknown>) => PermissionDecision | Promise<PermissionDecision>;
}

export interface ToolExecutionResult {
  status: 'executed' | 'blocked' | 'denied' | 'cancelled' | 'failed';
  content: string;
  isError: boolean;
  images?: string[];
}

/** Shared policy and execution boundary for registered core tools. */
export async function executeToolCall(
  toolName: string,
  args: unknown,
  options: ToolExecutionOptions,
): Promise<ToolExecutionResult> {
  const cwd = options.cwd ?? process.cwd();
  const tool = getTool(toolName);
  if (!tool) {
    return finishWithoutExecution(toolName, args, options, 'blocked', 'Unknown tool', 'tool-lookup', 'blocked');
  }

  const validation = validateToolArguments(tool.inputSchema, args);
  if (!validation.valid) {
    return finishWithoutExecution(toolName, args, options, 'blocked', validation.error ?? 'Invalid tool arguments', 'argument-validation', 'blocked');
  }
  const validArgs = args as Record<string, unknown>;

  if (options.signal?.aborted) {
    return finishWithoutExecution(toolName, validArgs, options, 'cancelled', 'Tool execution cancelled', 'cancelled', 'blocked');
  }

  let decision = decidePermission(toolName, options.permissions, tool.annotations);
  let rule = decision === 'allow' ? 'permission' : decision === 'deny' ? 'permission-deny' : 'confirm';
  if (options.additionalDecision) {
    try {
      const extra = await options.additionalDecision(toolName, validArgs);
      decision = combineDecisions(decision, extra);
      if (extra === 'deny') rule = 'policy';
      else if (extra === 'needs_confirmation' && decision !== 'deny') rule = 'confirm';
    } catch {
      return finishWithoutExecution(toolName, validArgs, options, 'blocked', 'Tool blocked by policy evaluation error', 'policy-error', 'blocked');
    }
  }

  if (decision === 'deny') {
    return finishWithoutExecution(toolName, validArgs, options, 'blocked', 'Tool denied by policy', rule, 'blocked');
  }

  if (decision === 'needs_confirmation') {
    if (!options.approve) {
      return finishWithoutExecution(toolName, validArgs, options, 'blocked', 'Tool requires confirmation; no approval handler is available', 'confirm-required', 'blocked');
    }
    let approved = false;
    try {
      approved = await options.approve({ toolName, args: validArgs, decision: 'needs_confirmation' });
    } catch {
      return finishWithoutExecution(toolName, validArgs, options, 'blocked', 'Tool blocked because confirmation failed', 'confirm-error', 'blocked');
    }
    if (!approved) {
      return finishWithoutExecution(toolName, validArgs, options, 'denied', 'Permission denied', 'confirm', 'denied');
    }
    rule = 'confirm';
  }

  if (options.signal?.aborted) {
    return finishWithoutExecution(toolName, validArgs, options, 'cancelled', 'Tool execution cancelled', 'cancelled', 'blocked');
  }

  if (!writeAudit(toolName, validArgs, rule, 'allowed', cwd, options.auditEnabled ?? true)) {
    return { status: 'blocked', content: 'Tool blocked because the audit record could not be written', isError: true };
  }

  try {
    const result = await executeToolWithTimeout(tool, validArgs, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (options.signal?.aborted) {
      return { status: 'cancelled', content: result.content || 'Tool execution cancelled', isError: true };
    }
    return {
      status: result.isError ? 'failed' : 'executed',
      content: result.content,
      isError: !!result.isError,
      images: result.images,
    };
  } catch {
    return { status: options.signal?.aborted ? 'cancelled' : 'failed', content: options.signal?.aborted ? 'Tool execution cancelled' : 'Tool execution failed', isError: true };
  }
}

function combineDecisions(base: PermissionDecision, extra: PermissionDecision): PermissionDecision {
  if (base === 'deny' || extra === 'deny') return 'deny';
  if (base === 'needs_confirmation' || extra === 'needs_confirmation') return 'needs_confirmation';
  return 'allow';
}

function finishWithoutExecution(
  toolName: string,
  args: unknown,
  options: ToolExecutionOptions,
  status: ToolExecutionResult['status'],
  content: string,
  rule: string,
  auditResult: 'denied' | 'blocked',
): ToolExecutionResult {
  writeAudit(toolName, args, rule, auditResult, options.cwd ?? process.cwd(), options.auditEnabled ?? true);
  return { status, content, isError: true };
}

function writeAudit(
  toolName: string,
  args: unknown,
  rule: string,
  result: 'allowed' | 'denied' | 'blocked',
  cwd: string,
  enabled: boolean,
): boolean {
  try {
    const argumentCount = args !== null && typeof args === 'object' && !Array.isArray(args)
      ? Object.keys(args).length
      : 0;
    recordAuditEvent({ tool: toolName, args: { argumentCount }, rule, result }, cwd, enabled);
    return true;
  } catch {
    return false;
  }
}
