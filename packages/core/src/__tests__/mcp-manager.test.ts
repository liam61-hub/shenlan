import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addMcpServer,
  removeMcpServer,
  refreshMcpServers,
  listMcpServers,
  disconnectAll,
  setMcpServerEnabled,
  connectMcpServer,
  disconnectMcpServer,
  __setMcpClientFactory,
} from '../mcp-manager.js';
import { getAllTools, unregisterTool } from '../tools/index.js';
import type { McpServerConfig, McpToolDef } from '../mcp-client.js';

/** 假 MCP 客户端：可注入失败 */
class FakeClient {
  name: string;
  connected = false;
  closed = false;
  failConnect = false;
  tools: McpToolDef[];
  capabilities: string[];

  constructor(cfg: McpServerConfig) {
    this.name = cfg.name;
    this.tools = [{ name: 'tool', description: 'fake tool', inputSchema: { type: 'object' }, annotations: { destructiveHint: true, idempotentHint: false } }];
    this.capabilities = ['tools'];
  }

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error(`boom: ${this.name}`);
    this.connected = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    return this.tools;
  }

  async callTool(): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    return { content: [{ type: 'text', text: 'ok' }] };
  }

  close(): void {
    this.connected = false;
    this.closed = true;
  }
}

function cleanupMcpTools(): void {
  for (const t of getAllTools()) {
    if (t.name.startsWith('mcp__')) unregisterTool(t.name);
  }
}

describe('mcp-manager 热管理', () => {
  let tmp: string;
  let cwd: string;
  let factory: (cfg: McpServerConfig) => FakeClient;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-mcp-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
    factory = (cfg) => {
      const c = new FakeClient(cfg);
      c.failConnect = cfg.name === 'bad';
      return c;
    };
    __setMcpClientFactory(factory);
    disconnectAll();
    cleanupMcpTools();
  });

  afterEach(() => {
    disconnectAll();
    cleanupMcpTools();
    __setMcpClientFactory(null);
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('addMcpServer 写配置、连接并注册工具', async () => {
    const r = await addMcpServer({ name: 'fake', transport: 'stdio', command: 'node' }, 'project', cwd);
    expect(r.connected).toBe(true);
    expect(r.toolCount).toBe(1);
    expect(r.error).toBeUndefined();

    const cfg = JSON.parse(readFileSync(join(cwd, '.shenlan', 'config.json'), 'utf-8'));
    expect(cfg.mcpServers).toHaveLength(1);
    expect(getAllTools().some(t => t.name === 'mcp__fake__tool')).toBe(true);
    expect(getAllTools().find(t => t.name === 'mcp__fake__tool')?.annotations).toEqual({ destructiveHint: true, idempotentHint: false });

    const status = listMcpServers(cwd);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ name: 'fake', transport: 'stdio', scope: 'project', connected: true, toolCount: 1 });
    expect(status[0].configFile).toBe(join(cwd, '.shenlan', 'config.json'));
    expect(status[0].capabilities).toEqual(['tools']);
  });

  it('同作用域重名 add 抛错且不重复注册', async () => {
    await addMcpServer({ name: 'fake', transport: 'stdio', command: 'node' }, 'project', cwd);
    await expect(addMcpServer({ name: 'fake', transport: 'stdio', command: 'node' }, 'project', cwd))
      .rejects.toThrow(/already exists/);
    expect(getAllTools().filter(t => t.name.startsWith('mcp__'))).toHaveLength(1);
  });

  it('removeMcpServer 删配置、断开并卸载工具', async () => {
    await addMcpServer({ name: 'fake', transport: 'stdio', command: 'node' }, 'project', cwd);
    await removeMcpServer('fake', 'project', cwd);
    expect(getAllTools().some(t => t.name === 'mcp__fake__tool')).toBe(false);
    expect(listMcpServers(cwd)).toHaveLength(0);
    await expect(removeMcpServer('fake', 'project', cwd)).rejects.toThrow(/not found/);
  });

  it('连接失败不抛错，状态记录错误', async () => {
    const r = await addMcpServer({ name: 'bad', transport: 'stdio', command: 'node' }, 'project', cwd);
    expect(r.connected).toBe(false);
    expect(r.error).toContain('boom');
    const status = listMcpServers(cwd);
    expect(status[0].connected).toBe(false);
    expect(status[0].error).toContain('boom');
    expect(getAllTools().some(t => t.name === 'mcp__bad__tool')).toBe(false);
  });

  it('refreshMcpServers 全量重连并汇总错误', async () => {
    await addMcpServer({ name: 'bad', transport: 'stdio', command: 'node' }, 'project', cwd);
    const r = await refreshMcpServers(cwd);
    expect(r.total).toBe(1);
    expect(r.connected).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].name).toBe('bad');
  });

  it('setMcpServerEnabled 停用断开并卸载，启用重连', async () => {
    await addMcpServer({ name: 'fake', transport: 'stdio', command: 'node' }, 'project', cwd);

    const off = await setMcpServerEnabled('fake', false, cwd);
    expect(off.enabled).toBe(false);
    expect(getAllTools().some(t => t.name === 'mcp__fake__tool')).toBe(false);
    let status = listMcpServers(cwd)[0];
    expect(status.enabled).toBe(false);
    expect(status.connected).toBe(false);
    // 断开后保留最近一次成功发现的工具名（/mcp 面板仍可展示）
    expect(status.tools).toEqual(['tool']);

    const on = await setMcpServerEnabled('fake', true, cwd);
    expect(on.connected).toBe(true);
    status = listMcpServers(cwd)[0];
    expect(status.enabled).toBe(true);
    expect(status.connected).toBe(true);
    expect(getAllTools().some(t => t.name === 'mcp__fake__tool')).toBe(true);
  });

  it('connectMcpServer / disconnectMcpServer 单 server 重连与断开', async () => {
    await addMcpServer({ name: 'fake', transport: 'stdio', command: 'node' }, 'project', cwd);
    disconnectMcpServer('fake');
    expect(listMcpServers(cwd)[0].connected).toBe(false);

    const r = await connectMcpServer('fake', cwd);
    expect(r.connected).toBe(true);
    expect(r.toolCount).toBe(1);
    expect(listMcpServers(cwd)[0].connected).toBe(true);
  });

  it('refresh 跳过会话级停用的 server', async () => {
    await addMcpServer({ name: 'fake', transport: 'stdio', command: 'node' }, 'project', cwd);
    await setMcpServerEnabled('fake', false, cwd);
    const r = await refreshMcpServers(cwd);
    expect(r.total).toBe(1);
    expect(r.connected).toBe(0);
    expect(listMcpServers(cwd)[0].enabled).toBe(false);
  });
});
