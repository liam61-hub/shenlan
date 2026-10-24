import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTool } from './index.js';
import { getAvailableTools } from '../context.js';
import { globalMemoryDir, projectMemoryDir } from '../memory.js';
import type { ShenlanConfig } from '../config.js';

// 注册 memory_save 工具（模块副作用）
import './memory.js';

const baseConfig: ShenlanConfig = {
  model: { baseUrl: 'https://x', apiKey: '', model: 'm', maxTokens: 1 },
  permissions: { mode: 'bypassPermissions', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
};

describe('memory_save 工具', () => {
  let tmp: string;
  let cwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-tool-memory-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  const tool = getTool('memory_save');

  it('已注册 memory_save', () => {
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('memory_save');
  });

  it('写主题文件 + MEMORY.md 索引并返回路径与总数', async () => {
    const res = await tool!.execute({
      name: 'use-pnpm',
      description: 'Use pnpm for installs',
      content: 'Always install deps with pnpm.',
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(join(projectMemoryDir(cwd), 'use-pnpm.md'));
    expect(res.content).toContain('1 memories total');

    const file = readFileSync(join(projectMemoryDir(cwd), 'use-pnpm.md'), 'utf-8');
    expect(file).toContain('name: use-pnpm');
    expect(file).toContain('description: Use pnpm for installs');
    expect(file).toContain('Always install deps with pnpm.');

    const index = readFileSync(join(projectMemoryDir(cwd), 'MEMORY.md'), 'utf-8');
    expect(index).toContain('- [use-pnpm](use-pnpm.md) — Use pnpm for installs');
  });

  it('scope=global 写入全局记忆目录', async () => {
    await tool!.execute({
      name: 'global-pref',
      description: 'Always pnpm',
      content: 'Cross-project preference.',
      scope: 'global',
    });
    expect(existsSync(join(globalMemoryDir(), 'global-pref.md'))).toBe(true);
    expect(existsSync(join(projectMemoryDir(cwd), 'global-pref.md'))).toBe(false);
  });

  it('同名覆盖更新内容，索引不重复', async () => {
    await tool!.execute({ name: 'a', description: 'd1', content: 'v1' });
    const res = await tool!.execute({ name: 'a', description: 'd2', content: 'v2' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('1 memories total');
    expect(readFileSync(join(projectMemoryDir(cwd), 'a.md'), 'utf-8')).toContain('v2');
    const index = readFileSync(join(projectMemoryDir(cwd), 'MEMORY.md'), 'utf-8');
    expect(index.match(/\[a\]/g)).toHaveLength(1);
  });

  it('非法 name（路径穿越）拒绝且不写文件', async () => {
    const res = await tool!.execute({ name: '../evil', description: 'd', content: 'c' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Invalid memory name');
    expect(existsSync(join(projectMemoryDir(cwd), '..', 'evil.md'))).toBe(false);
  });

  it('非法 scope 拒绝', async () => {
    const res = await tool!.execute({ name: 'a', description: 'd', content: 'c', scope: 'foo' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Invalid scope');
  });

  it('description 为空拒绝', async () => {
    const res = await tool!.execute({ name: 'a', description: '  ', content: 'c' });
    expect(res.isError).toBe(true);
  });

  it('content 超过 6000 字符截断', async () => {
    const res = await tool!.execute({
      name: 'long',
      description: 'd',
      content: 'x'.repeat(7000),
    });
    expect(res.isError).toBeFalsy();
    const file = readFileSync(join(projectMemoryDir(cwd), 'long.md'), 'utf-8');
    expect(file).toContain('...(truncated)');
    // front-matter 外的正文 ≈ 6000 + 截断标记
    const body = file.slice(file.indexOf('---\n\n') + 5);
    expect(body.length).toBeLessThanOrEqual(6000 + 40);
  });

  it('mode=append 保留原内容并在其后追加', async () => {
    await tool!.execute({ name: 'a', description: 'd1', content: 'old body' });
    const res = await tool!.execute({
      name: 'a',
      description: 'd2',
      content: 'new fact',
      mode: 'append',
    });
    expect(res.isError).toBeFalsy();
    const file = readFileSync(join(projectMemoryDir(cwd), 'a.md'), 'utf-8');
    expect(file).toContain('old body');
    expect(file).toContain('new fact');
    expect(file.indexOf('old body')).toBeLessThan(file.indexOf('new fact'));
    // 索引不重复
    const index = readFileSync(join(projectMemoryDir(cwd), 'MEMORY.md'), 'utf-8');
    expect(index.match(/\[a\]/g)).toHaveLength(1);
  });

  it('mode=append 无既有文件时等同新建', async () => {
    const res = await tool!.execute({
      name: 'fresh',
      description: 'd',
      content: 'body',
      mode: 'append',
    });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(projectMemoryDir(cwd), 'fresh.md'), 'utf-8')).toContain('body');
  });

  it('mode=append 合并后在 6000 处重新截断（CONTENT_MAX 在追加之后执行）', async () => {
    await tool!.execute({ name: 'long', description: 'd', content: 'y'.repeat(5000) });
    await tool!.execute({
      name: 'long',
      description: 'd',
      content: 'z'.repeat(2000),
      mode: 'append',
    });
    const file = readFileSync(join(projectMemoryDir(cwd), 'long.md'), 'utf-8');
    expect(file).toContain('...(truncated)');
    // 正文 = 6000 + 截断标记；追加内容被挤在 6000 之外
    const body = file.slice(file.indexOf('---\n\n') + 5);
    expect(body.length).toBeLessThanOrEqual(6000 + 40);
    expect(body.startsWith('y'.repeat(100))).toBe(true);
  });

  it('非法 mode 拒绝且不写文件', async () => {
    const res = await tool!.execute({ name: 'a', description: 'd', content: 'c', mode: 'merge' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Invalid mode');
    expect(existsSync(join(projectMemoryDir(cwd), 'a.md'))).toBe(false);
  });
});

describe('getAvailableTools 的 memory_save 过滤', () => {
  it('autoSave=true（默认）时包含 memory_save', () => {
    const tools = getAvailableTools(baseConfig);
    expect(tools.some((t) => t.name === 'memory_save')).toBe(true);
  });

  it('autoSave=false 时过滤掉 memory_save', () => {
    const tools = getAvailableTools({ ...baseConfig, memory: { autoSave: false } });
    expect(tools.some((t) => t.name === 'memory_save')).toBe(false);
  });

  it('config 缺省时默认开启', () => {
    const tools = getAvailableTools();
    expect(tools.some((t) => t.name === 'memory_save')).toBe(true);
  });
});
