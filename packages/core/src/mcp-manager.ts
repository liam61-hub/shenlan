/**
 * MCP Manager — 管理多个 MCP 客户端，自动注册/注销工具
 *
 * 支持运行期热增删（add/remove）与全量重连（refresh），
 * 连接失败不阻塞启动但记录错误状态，供 /mcp 等界面展示。
 */
import { McpClient } from './mcp-client.js';
import { registerTool, unregisterTool } from './tools/index.js';
import type { McpServerConfig, McpToolDef } from './mcp-client.js';
import type { ToolResult } from './tools/index.js';
import {
  loadConfig,
  addMcpServerToConfig,
  removeMcpServerFromConfig,
  getMcpServerScopes,
  globalConfigPath,
  projectConfigPath,
  type ConfigScope,
} from './config.js';

/** 客户端最小接口（McpClient 已实现；测试可注入 mock） */
interface McpClientLike {
  readonly name: string;
  readonly connected: boolean;
  readonly tools: McpToolDef[];
  readonly capabilities: string[];
  connect(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close(): void;
}

/** 已连接的 MCP 客户端 */
const clients = new Map<string, McpClientLike>();
/** 工具名 → MCP client 映射 */
const toolToClient = new Map<string, McpClientLike>();
/** 连接错误状态（name → error message） */
const statuses = new Map<string, { error?: string }>();
/** 会话级启用状态（缺省 = 已启用；/mcp disable 后跳过连接并卸载工具，不落盘） */
const enabled = new Map<string, boolean>();
/** 最近一次成功发现到的工具名（断开后仍可展示，供 /mcp 面板） */
const knownTools = new Map<string, string[]>();
/** 最近一次 initialize 声明的 capabilities（断开后保留） */
const knownCaps = new Map<string, string[]>();

/** 客户端工厂（测试注入点；默认 new McpClient） */
let clientFactory: (cfg: McpServerConfig) => McpClientLike = (cfg) => new McpClient(cfg);

/** 测试注入：传 null 恢复默认工厂 */
export function __setMcpClientFactory(factory: ((cfg: McpServerConfig) => McpClientLike) | null): void {
  clientFactory = factory || ((cfg) => new McpClient(cfg));
}

/**
 * 注册一个 MCP 工具到核心工具注册表
 */
function registerMcpTool(name: string, def: McpToolDef, client: McpClientLike): void {
  const fullName = `mcp__${client.name}__${name}`;

  registerTool({
    name: fullName,
    description: `[MCP:${client.name}] ${def.description || name}`,
    annotations: def.annotations,
    inputSchema: (def.inputSchema || { type: 'object', properties: {} }) as {
      type: string;
      properties?: Record<string, { type: string; description?: string; enum?: string[] }>;
      required?: string[];
    },
    async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
      try {
        const result = await client.callTool(name, params, signal);
        const text = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text || '')
          .join('\n');
        return {
          content: text || '(empty)',
          isError: result.isError || false,
        };
      } catch (err) {
        return { content: `MCP tool error: ${(err as Error).message}`, isError: true };
      }
    },
  });

  toolToClient.set(fullName, client);
}

/** 断开单个 server：卸载其全部工具并关闭连接 */
function disconnectServer(name: string): void {
  const client = clients.get(name);
  if (!client) {
    statuses.delete(name);
    return;
  }
  for (const toolName of [...toolToClient.keys()]) {
    if (toolToClient.get(toolName) === client) {
      toolToClient.delete(toolName);
      unregisterTool(toolName);
    }
  }
  try { client.close(); } catch { /* ignore */ }
  clients.delete(name);
  statuses.delete(name);
}

/** 连接单个 server：成功注册工具，失败记录错误状态（不抛错） */
async function connectServer(cfg: McpServerConfig): Promise<void> {
  if (clients.has(cfg.name)) disconnectServer(cfg.name);
  const client = clientFactory(cfg);
  try {
    await client.connect();
    const tools = await client.listTools();
    clients.set(cfg.name, client);
    statuses.delete(cfg.name);
    knownTools.set(cfg.name, tools.map(t => t.name));
    knownCaps.set(cfg.name, client.capabilities);
    for (const tool of tools) {
      registerMcpTool(tool.name, tool, client);
    }
    if (process.env.SHENLAN_DEBUG === '1') {
      process.stderr.write(`[mcp] "${cfg.name}": ${tools.length} tools registered\n`);
    }
  } catch (err) {
    try { client.close(); } catch { /* ignore */ }
    statuses.set(cfg.name, { error: (err as Error).message });
    if (process.env.SHENLAN_DEBUG === '1') {
      process.stderr.write(`[mcp] "${cfg.name}" failed (${err instanceof Error ? err.name : typeof err})\n`);
    }
  }
}

/**
 * 连接到配置中的 MCP servers 并注册工具（失败不阻塞启动，错误记入状态）
 */
export async function connectMcpServers(servers: McpServerConfig[]): Promise<number> {
  for (const cfg of servers) {
    if (enabled.get(cfg.name) === false) continue; // 会话级 disable
    await connectServer(cfg);
  }
  return servers.filter(s => clients.has(s.name) && clients.get(s.name)!.connected).length;
}

/** MCP server 运行状态（/mcp 展示用） */
export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  /** stdio 启动命令（详情展示） */
  command?: string;
  /** stdio 启动参数（详情展示） */
  args?: string[];
  /** http 端点 URL（详情展示） */
  url?: string;
  scope: ConfigScope;
  /** 配置所在文件（/mcp 详情展示用） */
  configFile: string;
  /** 会话级启用状态（false = 用户 /mcp disable 暂时停用，不落盘） */
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  /** 最近一次成功发现到的工具名（断开后保留最后一次结果） */
  tools: string[];
  /** server 声明的 capabilities（tools/resources/prompts；断开后保留） */
  capabilities: string[];
  error?: string;
}

/** 列出所有已配置 server 的运行状态 */
export function listMcpServers(cwd?: string): McpServerStatus[] {
  const config = loadConfig(cwd);
  const scopes = getMcpServerScopes(cwd);
  return (config.mcpServers || []).map(cfg => {
    const client = clients.get(cfg.name);
    const scope = scopes.get(cfg.name) || 'project';
    return {
      name: cfg.name,
      transport: cfg.transport,
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      scope,
      configFile: scope === 'global' ? globalConfigPath() : projectConfigPath(cwd || process.cwd()),
      enabled: enabled.get(cfg.name) !== false,
      connected: !!client?.connected,
      toolCount: client?.tools.length ?? 0,
      tools: client?.tools.map(t => t.name) ?? knownTools.get(cfg.name) ?? [],
      capabilities: client?.capabilities ?? knownCaps.get(cfg.name) ?? [],
      error: statuses.get(cfg.name)?.error,
    };
  });
}

/**
 * 新增 MCP server：写入配置 + 立即连接注册工具。
 * 同作用域重名抛错；连接失败不抛错（配置已保存），通过返回值与状态展示错误。
 */
export async function addMcpServer(
  cfg: McpServerConfig,
  scope: ConfigScope,
  cwd?: string,
): Promise<{ configFile: string; connected: boolean; error?: string; toolCount: number }> {
  const { file } = addMcpServerToConfig(cfg, scope, cwd);
  await connectServer(cfg);
  const client = clients.get(cfg.name);
  return {
    configFile: file,
    connected: !!client?.connected,
    error: statuses.get(cfg.name)?.error,
    toolCount: client?.tools.length ?? 0,
  };
}

/** 删除 MCP server：从配置移除 + 断开连接 + 卸载工具；配置中不存在则抛错 */
export async function removeMcpServer(
  name: string,
  scope: ConfigScope,
  cwd?: string,
): Promise<{ configFile: string; removed: boolean }> {
  const { file, removed } = removeMcpServerFromConfig(name, scope, cwd);
  if (!removed) {
    throw new Error(`MCP server "${name}" not found in ${scope} config (${file})`);
  }
  disconnectServer(name);
  enabled.delete(name);
  knownTools.delete(name);
  knownCaps.delete(name);
  return { configFile: file, removed };
}

/**
 * 会话级启用/停用单个 server（对齐 Claude Code /mcp enable|disable，不落盘）。
 * 停用：断开连接并卸载工具；启用：重新连接（连接失败记录错误状态）。
 */
export async function setMcpServerEnabled(
  name: string,
  flag: boolean,
  cwd?: string,
): Promise<{ enabled: boolean; connected: boolean; error?: string; toolCount: number }> {
  if (!flag) {
    enabled.set(name, false);
    disconnectServer(name);
    return { enabled: false, connected: false, toolCount: 0 };
  }
  const cfg = loadConfig(cwd).mcpServers.find(s => s.name === name);
  if (!cfg) throw new Error(`MCP server "${name}" not found in config`);
  enabled.set(name, true);
  await connectServer(cfg);
  const client = clients.get(name);
  return {
    enabled: true,
    connected: !!client?.connected,
    error: statuses.get(name)?.error,
    toolCount: client?.tools.length ?? 0,
  };
}

/** 重连单个 server（断开后重新连接；同时视为启用） */
export async function connectMcpServer(
  name: string,
  cwd?: string,
): Promise<{ connected: boolean; error?: string; toolCount: number }> {
  const cfg = loadConfig(cwd).mcpServers.find(s => s.name === name);
  if (!cfg) throw new Error(`MCP server "${name}" not found in config`);
  enabled.set(name, true);
  await connectServer(cfg);
  const client = clients.get(name);
  return {
    connected: !!client?.connected,
    error: statuses.get(name)?.error,
    toolCount: client?.tools.length ?? 0,
  };
}

/** 断开单个 server（仅本次会话，配置保留；重新 connect / refresh 可恢复） */
export function disconnectMcpServer(name: string): void {
  disconnectServer(name);
}

/** 全量重连：断开全部已连接 server，按合并配置重新连接 */
export async function refreshMcpServers(
  cwd?: string,
): Promise<{ connected: number; total: number; errors: Array<{ name: string; error: string }> }> {
  disconnectAll();
  const config = loadConfig(cwd);
  const servers = config.mcpServers || [];
  for (const cfg of servers) {
    if (enabled.get(cfg.name) === false) continue; // 会话级 disable
    await connectServer(cfg);
  }
  const errors: Array<{ name: string; error: string }> = [];
  for (const cfg of servers) {
    const st = statuses.get(cfg.name);
    if (st?.error) errors.push({ name: cfg.name, error: st.error });
  }
  return {
    connected: servers.filter(s => clients.has(s.name) && clients.get(s.name)!.connected).length,
    total: servers.length,
    errors,
  };
}

/**
 * 断开所有 MCP 连接并卸载全部 MCP 工具
 */
export function disconnectAll(): void {
  for (const name of [...clients.keys()]) {
    disconnectServer(name);
  }
}
