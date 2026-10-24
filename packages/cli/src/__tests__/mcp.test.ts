import { describe, it, expect } from 'vitest';
import { parseMcpAdd, formatMcpStatus, mcpScopeLabel } from '../mcp.js';

describe('parseMcpAdd（shenlan mcp add / /mcp add 参数解析）', () => {
  it('stdio：-- 之后的第一个 token 是命令，其余是参数', () => {
    const spec = parseMcpAdd(['github', '--', 'npx', '-y', '@modelcontextprotocol/server-github']);
    expect(spec.name).toBe('github');
    expect(spec.scope).toBe('project');
    expect(spec.cfg).toEqual({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {},
    });
  });

  it('stdio：--env 与 --scope 解析', () => {
    const spec = parseMcpAdd(['db', '--scope', 'global', '--env', 'TOKEN=abc', '--', 'node', 'server.js']);
    expect(spec.scope).toBe('global');
    expect(spec.cfg.env).toEqual({ TOKEN: 'abc' });
    expect(spec.cfg.args).toEqual(['server.js']);
  });

  it('http：--url 与 --headers 解析', () => {
    const spec = parseMcpAdd(['remote', '--url', 'https://mcp.example.com', '--headers', 'Authorization=env:Bearer']);
    expect(spec.cfg).toEqual({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'env:Bearer' },
    });
  });

  it('缺少 name / 缺少命令 / 未知选项时报错', () => {
    expect(() => parseMcpAdd([])).toThrow(/Missing MCP server name/);
    expect(() => parseMcpAdd(['x', '--'])).toThrow(/Missing command/);
    expect(() => parseMcpAdd(['x', '--bogus', 'v'])).toThrow(/Unknown option/);
    expect(() => parseMcpAdd(['--scope', 'bogus', 'x', '--', 'cmd'])).toThrow(/--scope must be/);
    expect(() => parseMcpAdd(['--env', 'NOEQUALS', 'x', '--', 'cmd'])).toThrow(/KEY=VALUE/);
  });
});

describe('formatMcpStatus（作用域中文标签）', () => {
  it('scope 展示为 项目级 / 用户级', () => {
    expect(mcpScopeLabel('project')).toBe('项目级');
    expect(mcpScopeLabel('global')).toBe('用户级');

    const servers = [
      {
        name: 'proj-srv',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        scope: 'project',
        configFile: '/proj/.shenlan/mcp.json',
        enabled: true,
        connected: false,
        toolCount: 0,
        tools: [],
        capabilities: [],
      },
      {
        name: 'global-srv',
        transport: 'http',
        url: 'https://mcp.example.com',
        scope: 'global',
        configFile: '/home/u/.config/shenlan/mcp.json',
        enabled: true,
        connected: true,
        toolCount: 2,
        tools: ['a', 'b'],
        capabilities: [],
      },
    ];
    const out = formatMcpStatus(servers as never);
    expect(out).toContain('proj-srv  stdio  项目级');
    expect(out).toContain('global-srv  http  用户级');
    expect(out).not.toContain(' project ');
    expect(out).not.toContain(' global ');
  });
});
