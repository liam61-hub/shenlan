/**
 * MCP 管理 — /mcp 斜杠命令与 `shenlan mcp` CLI 子命令共享逻辑
 *
 * 对齐 Claude Code（会话内 /mcp 状态 + add/remove/refresh、作用域）与
 * Codex CLI（`codex mcp list/add/remove`、--json、env:VAR 引用）。
 */
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  refreshMcpServers,
  connectMcpServers,
  connectMcpServer,
  disconnectMcpServer,
  setMcpServerEnabled,
  disconnectAll,
  loadConfig,
  type McpServerStatus,
  type McpServerConfig,
  type ConfigScope,
} from '@shenlan/core';
import { parseShellArgs } from './slash-commands.js';

export interface McpAddSpec {
  name: string;
  scope: ConfigScope;
  cfg: McpServerConfig;
}

/** 作用域展示标签：项目级 / 用户级（McpServerStatus.scope 字段不变，仅展示层） */
export const MCP_SCOPE_LABELS: Record<ConfigScope, string> = {
  project: '项目级',
  global: '用户级',
};

export function mcpScopeLabel(scope: ConfigScope): string {
  return MCP_SCOPE_LABELS[scope] ?? scope;
}

function splitKV(token: string, flag: string): { key: string; value: string } {
  const idx = token.indexOf('=');
  if (idx <= 0) throw new Error(`${flag} expects KEY=VALUE, got "${token}"`);
  return { key: token.slice(0, idx), value: token.slice(idx + 1) };
}

/**
 * 解析 `mcp add` 参数（CLI argv 或斜杠命令切词结果）。
 *
 * 用法：
 *   add <name> [--scope project|global] [--env K=V]... -- <command> [args...]
 *   add <name> [--scope project|global] --url <url> [--headers K=V]...
 */
export function parseMcpAdd(tokens: string[]): McpAddSpec {
  const dash = tokens.indexOf('--');
  const pre = dash >= 0 ? tokens.slice(0, dash) : tokens;
  const commandArgs = dash >= 0 ? tokens.slice(dash + 1) : [];

  let name: string | undefined;
  let scope: ConfigScope = 'project';
  let url: string | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (let i = 0; i < pre.length; i++) {
    const t = pre[i];
    switch (t) {
      case '--scope': {
        const v = pre[++i];
        if (v !== 'project' && v !== 'global') throw new Error('--scope must be project or global');
        scope = v;
        break;
      }
      case '--url':
        url = pre[++i];
        if (!url) throw new Error('--url requires a value');
        break;
      case '--env': {
        const kv = splitKV(pre[++i] || '', '--env');
        env[kv.key] = kv.value;
        break;
      }
      case '--headers': {
        const kv = splitKV(pre[++i] || '', '--headers');
        headers[kv.key] = kv.value;
        break;
      }
      default:
        if (t.startsWith('-')) throw new Error(`Unknown option: ${t}`);
        if (name) throw new Error(`Unexpected argument: ${t}`);
        name = t;
    }
  }

  if (!name) throw new Error('Missing MCP server name (mcp add <name> ...)');

  let cfg: McpServerConfig;
  if (url) {
    cfg = { name, transport: 'http', url, headers };
  } else {
    if (commandArgs.length === 0) {
      throw new Error('Missing command after "--" (mcp add <name> -- <command> [args...])');
    }
    cfg = {
      name,
      transport: 'stdio',
      command: commandArgs[0],
      args: commandArgs.slice(1),
      env,
    };
  }
  return { name, scope, cfg };
}

/** 人类可读的 server 状态表（/mcp 与 shenlan mcp list 共用） */
export function formatMcpStatus(servers: McpServerStatus[]): string {
  if (servers.length === 0) return '  未配置 MCP servers（/mcp add <name> -- <command> 添加）';
  return servers.map(s => {
    const enabledTag = s.enabled ? '' : ' [disabled]';
    const status = s.connected ? `✓ connected (${s.toolCount} tools)` : s.error ? `✗ error` : '○ not connected';
    let line = `  ${s.name}  ${s.transport}  ${mcpScopeLabel(s.scope)}  ${status}${enabledTag}`;
    if (!s.connected && s.error) line += `: ${s.error}`;
    if (s.tools.length > 0) line += `\n    tools: ${s.tools.join(', ')}`;
    return line;
  }).join('\n');
}

/** 会话内 /mcp 子命令处理（reply 用于回写系统消息） */
export async function runMcpSlashCommand(
  args: string,
  reply: (text: string) => void,
  cwd = process.cwd(),
): Promise<void> {
  const tokens = parseShellArgs(args.trim());
  const op = tokens[0]?.toLowerCase();
  const rest = tokens.slice(1);

  switch (op) {
    case 'list':
      reply(formatMcpStatus(listMcpServers(cwd)));
      return;
    case 'add': {
      const spec = parseMcpAdd(rest);
      const r = await addMcpServer(spec.cfg, spec.scope, cwd);
      if (r.connected) {
        reply(`  MCP server "${spec.name}" added to ${spec.scope} config and connected (${r.toolCount} tools)`);
      } else {
        reply(`  MCP server "${spec.name}" saved to ${spec.scope} config, but connection failed: ${r.error || 'unknown error'}`);
        reply('  可运行 /mcp refresh 重试');
      }
      return;
    }
    case 'remove': {
      let name: string | undefined;
      let scope: ConfigScope = 'project';
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--scope') {
          const v = rest[++i];
          if (v !== 'project' && v !== 'global') throw new Error('--scope must be project or global');
          scope = v;
        } else if (!name) {
          name = rest[i];
        } else {
          throw new Error(`Unexpected argument: ${rest[i]}`);
        }
      }
      if (!name) throw new Error('Missing MCP server name (mcp remove <name>)');
      const r = await removeMcpServer(name, scope, cwd);
      reply(`  MCP server "${name}" removed from ${scope} config`);
      return;
    }
    case 'refresh': {
      const r = await refreshMcpServers(cwd);
      const errs = r.errors.length
        ? `\n` + r.errors.map(e => `    ✗ ${e.name}: ${e.error}`).join('\n')
        : '';
      reply(`  MCP refresh: ${r.connected}/${r.total} connected${errs}`);
      return;
    }
    case 'enable': case 'disable': {
      let name: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--scope') { i++; continue; }
        if (!name) name = rest[i];
      }
      if (!name) throw new Error(`Missing MCP server name (mcp ${op} <name>)`);
      const r = await setMcpServerEnabled(name, op === 'enable', cwd);
      if (op === 'disable') {
        reply(`  MCP server "${name}" disabled for this session (config unchanged)`);
      } else {
        reply(r.connected
          ? `  MCP server "${name}" enabled and connected (${r.toolCount} tools)`
          : `  MCP server "${name}" enabled, but connection failed: ${r.error || 'unknown error'}`);
      }
      return;
    }
    case 'connect': {
      let name: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--scope') { i++; continue; }
        if (!name) name = rest[i];
      }
      if (!name) throw new Error('Missing MCP server name (mcp connect <name>)');
      const r = await connectMcpServer(name, cwd);
      reply(r.connected
        ? `  MCP server "${name}" connected (${r.toolCount} tools)`
        : `  MCP server "${name}" connect failed: ${r.error || 'unknown error'}`);
      return;
    }
    case 'disconnect': {
      let name: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--scope') { i++; continue; }
        if (!name) name = rest[i];
      }
      if (!name) throw new Error('Missing MCP server name (mcp disconnect <name>)');
      disconnectMcpServer(name);
      reply(`  MCP server "${name}" disconnected (config unchanged)`);
      return;
    }
    default:
      throw new Error('Usage: /mcp | /mcp list | /mcp add <name> [--scope global] -- <command> | /mcp remove <name> [--scope global] | /mcp enable|disable|connect|disconnect <name> | /mcp refresh');
  }
}

function printUsage(): void {
  console.error('Usage:');
  console.error('  shenlan mcp list [--json]');
  console.error('  shenlan mcp add <name> [--scope project|global] [--env K=V]... -- <command> [args...]');
  console.error('  shenlan mcp add <name> [--scope project|global] --url <url> [--headers K=V]...');
  console.error('  shenlan mcp remove <name> [--scope project|global]');
  console.error('  shenlan mcp enable|disable <name>       session-scoped enable/disable');
  console.error('  shenlan mcp connect|disconnect <name>   connect/disconnect one server');
  console.error('  shenlan mcp refresh');
}

/** CLI 入口：shenlan mcp ... */
export async function runMcpCommand(argv: string[]): Promise<number> {
  const op = argv[0]?.toLowerCase();
  const rest = argv.slice(1);

  switch (op) {
    case 'list': case undefined: {
      // 全新进程无启动连接：先探测一次，让状态/工具数准确
      const config = loadConfig();
      if (config.mcpServers?.length) await connectMcpServers(config.mcpServers);
      try {
        const servers = listMcpServers();
        if (argv.includes('--json')) {
          console.log(JSON.stringify(servers, null, 2));
        } else {
          console.log(formatMcpStatus(servers));
        }
        return 0;
      } finally {
        disconnectAll();
      }
    }
    case 'add': {
      try {
        const spec = parseMcpAdd(rest);
        const r = await addMcpServer(spec.cfg, spec.scope);
        if (r.connected) {
          console.log(`MCP server "${spec.name}" added to ${spec.scope} config and connected (${r.toolCount} tools)`);
          console.log(`Config: ${r.configFile}`);
        } else {
          console.error(`MCP server "${spec.name}" saved to ${spec.scope} config, but connection failed: ${r.error || 'unknown error'}`);
          console.error(`Config: ${r.configFile}`);
          console.error('Retry with: shenlan mcp refresh');
        }
        return 0;
      } catch (err) {
        console.error(String((err as Error).message));
        printUsage();
        return 1;
      } finally {
        disconnectAll();
      }
    }
    case 'remove': {
      try {
        let name: string | undefined;
        let scope: ConfigScope = 'project';
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--scope') {
            const v = rest[++i];
            if (v !== 'project' && v !== 'global') throw new Error('--scope must be project or global');
            scope = v;
          } else if (!name) {
            name = rest[i];
          } else {
            throw new Error(`Unexpected argument: ${rest[i]}`);
          }
        }
        if (!name) throw new Error('Missing MCP server name (mcp remove <name>)');
        const r = await removeMcpServer(name, scope);
        console.log(`MCP server "${name}" removed from ${scope} config (${r.configFile})`);
        return 0;
      } catch (err) {
        console.error(String((err as Error).message));
        printUsage();
        return 1;
      } finally {
        disconnectAll();
      }
    }
    case 'refresh': {
      try {
        const r = await refreshMcpServers();
        if (r.errors.length) {
          for (const e of r.errors) console.error(`✗ ${e.name}: ${e.error}`);
        }
        console.log(`MCP refresh: ${r.connected}/${r.total} connected`);
        return r.errors.length ? 1 : 0;
      } finally {
        disconnectAll();
      }
    }
    case 'enable': case 'disable': {
      try {
        const name = rest.find(t => !t.startsWith('--')) || rest[0];
        if (!name) throw new Error(`Missing MCP server name (mcp ${op} <name>)`);
        const r = await setMcpServerEnabled(name, op === 'enable');
        if (op === 'disable') {
          console.log(`MCP server "${name}" disabled for this session (config unchanged)`);
        } else if (r.connected) {
          console.log(`MCP server "${name}" enabled and connected (${r.toolCount} tools)`);
        } else {
          console.error(`MCP server "${name}" enabled, but connection failed: ${r.error || 'unknown error'}`);
          return 1;
        }
        return 0;
      } catch (err) {
        console.error(String((err as Error).message));
        printUsage();
        return 1;
      } finally {
        disconnectAll();
      }
    }
    case 'connect': {
      try {
        const name = rest.find(t => !t.startsWith('--')) || rest[0];
        if (!name) throw new Error('Missing MCP server name (mcp connect <name>)');
        const r = await connectMcpServer(name);
        if (r.connected) {
          console.log(`MCP server "${name}" connected (${r.toolCount} tools)`);
          return 0;
        }
        console.error(`MCP server "${name}" connect failed: ${r.error || 'unknown error'}`);
        return 1;
      } catch (err) {
        console.error(String((err as Error).message));
        printUsage();
        return 1;
      } finally {
        disconnectAll();
      }
    }
    case 'disconnect': {
      try {
        const name = rest.find(t => !t.startsWith('--')) || rest[0];
        if (!name) throw new Error('Missing MCP server name (mcp disconnect <name>)');
        disconnectMcpServer(name);
        console.log(`MCP server "${name}" disconnected (config unchanged)`);
        return 0;
      } catch (err) {
        console.error(String((err as Error).message));
        printUsage();
        return 1;
      } finally {
        disconnectAll();
      }
    }
    default:
      printUsage();
      return 2;
  }
}
