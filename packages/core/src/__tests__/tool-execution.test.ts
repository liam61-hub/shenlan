import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeToolCall } from '../tools/execute.js';
import { registerTool, unregisterTool } from '../tools/index.js';

describe('executeToolCall', () => {
  const toolName = 'execution_boundary_test_tool';
  let cwd: string;
  const execute = vi.fn(async (args: Record<string, unknown>) => ({ content: `received ${String(args.value)}` }));

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shenlan-tool-execution-'));
    execute.mockClear();
    registerTool({
      name: toolName,
      description: 'Test tool for the shared execution boundary.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      execute,
    });
  });

  afterEach(() => {
    unregisterTool(toolName);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('blocks invalid runtime arguments before calling the tool', async () => {
    const result = await executeToolCall(toolName, { value: 7 }, {
      permissions: { mode: 'bypassPermissions', allow: [], deny: [] }, cwd,
    });

    expect(result).toMatchObject({ status: 'blocked', isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces explicit deny even in bypass mode and records a minimal audit summary', async () => {
    const result = await executeToolCall(toolName, { value: 'private input' }, {
      permissions: { mode: 'bypassPermissions', allow: [toolName], deny: [toolName] }, cwd,
    });

    expect(result.status).toBe('blocked');
    expect(execute).not.toHaveBeenCalled();
    const audit = JSON.parse(readFileSync(join(cwd, '.shenlan', 'audit.jsonl'), 'utf8').trim()) as { result: string; args: string };
    expect(audit.result).toBe('blocked');
    expect(audit.args).toBe('{"argumentCount":1}');
    expect(audit.args).not.toContain('private input');
  });

  it('blocks needs_confirmation when no approval handler is available', async () => {
    const result = await executeToolCall(toolName, { value: 'safe' }, {
      permissions: { mode: 'default', allow: [], deny: [] }, cwd,
    });

    expect(result.status).toBe('blocked');
    expect(result.content).toContain('no approval handler');
    expect(execute).not.toHaveBeenCalled();
  });

  it('records denial when the approval handler refuses the action', async () => {
    const result = await executeToolCall(toolName, { value: 'safe' }, {
      permissions: { mode: 'default', allow: [], deny: [] },
      cwd,
      approve: async () => false,
    });

    expect(result.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(join(cwd, '.shenlan', 'audit.jsonl'), 'utf8')).toContain('"result":"denied"');
  });

  it('executes only after approval and records the allowed action', async () => {
    const approve = vi.fn(async () => true);
    const result = await executeToolCall(toolName, { value: 'approved' }, {
      permissions: { mode: 'default', allow: [], deny: [] }, cwd, approve,
    });

    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName, decision: 'needs_confirmation' }));
    expect(result).toMatchObject({ status: 'executed', content: 'received approved', isError: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(readFileSync(join(cwd, '.shenlan', 'audit.jsonl'), 'utf8')).toContain('"result":"allowed"');
  });

  it('lets additional restrictions deny an otherwise allowed action', async () => {
    const result = await executeToolCall(toolName, { value: 'safe' }, {
      permissions: { mode: 'bypassPermissions', allow: [], deny: [] },
      cwd,
      additionalDecision: () => 'deny',
    });

    expect(result.status).toBe('blocked');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeToolCall(toolName, { value: 'safe' }, {
      permissions: { mode: 'bypassPermissions', allow: [], deny: [] }, cwd, signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });
});
