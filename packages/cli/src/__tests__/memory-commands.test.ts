import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { getAvailableTools, registerAllTools } from '@shenlan/core';
import type { ShenlanConfig } from '@shenlan/core';
import { globalMemoryDir, projectMemoryDir } from '@shenlan/core';
import {
  setMemoryAutoSave,
  memoryAutoSave,
  listMemories,
  removeMemory,
  editMemory,
} from '../commands/memory.js';

// editMemory 用 OS 默认程序打开文件，测试中绝不能真 spawn —— 用 EventEmitter 替身
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);

function fakeSpawnSuccess(): void {
  mockedSpawn.mockImplementation(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('spawn'));
    return child as unknown as ReturnType<typeof spawn>;
  });
}

const baseConfig: ShenlanConfig = {
  model: { baseUrl: 'https://x', apiKey: '', model: 'm', maxTokens: 1 },
  permissions: { mode: 'default', allow: ['read'], deny: [] },
  skills: [],
  mcpServers: [],
};

function writeMemoryFile(dir: string, name: string, description: string, content = 'body'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n${content}`,
    'utf-8',
  );
}

describe('/memory 命令逻辑', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-cli-memory-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    mockedSpawn.mockReset();
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('setMemoryAutoSave 写回项目 config.json 且保留其他字段', () => {
    writeFileSync(
      join(cwd, '.shenlan', 'config.json'),
      JSON.stringify({
        model: { baseUrl: 'https://x', apiKey: '', model: 'm', maxTokens: 1 },
        permissions: { mode: 'default', allow: ['read'], deny: [] },
        skills: ['/custom/skills'],
        mcpServers: [{ name: 'a', transport: 'stdio', command: 'node' }],
      }),
      'utf-8',
    );

    setMemoryAutoSave(false, cwd);
    const raw = JSON.parse(readFileSync(join(cwd, '.shenlan', 'config.json'), 'utf-8'));
    expect(raw.memory).toEqual({ autoSave: false });
    expect(raw.model.model).toBe('m');
    expect(raw.permissions.allow).toEqual(['read']);
    expect(raw.skills).toEqual(['/custom/skills']);
    expect(raw.mcpServers).toHaveLength(1);

    setMemoryAutoSave(true, cwd);
    const raw2 = JSON.parse(readFileSync(join(cwd, '.shenlan', 'config.json'), 'utf-8'));
    expect(raw2.memory).toEqual({ autoSave: true });
    expect(raw2.model.model).toBe('m');
  });

  it('setMemoryAutoSave 在 config.json 不存在时创建（仅 memory 字段）', () => {
    const { file } = setMemoryAutoSave(false, cwd);
    expect(file).toBe(join(cwd, '.shenlan', 'config.json'));
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    expect(raw.memory).toEqual({ autoSave: false });
  });

  it('memoryAutoSave 缺省开启，false 时关闭', () => {
    expect(memoryAutoSave(baseConfig)).toBe(true);
    expect(memoryAutoSave({ ...baseConfig, memory: { autoSave: false } })).toBe(false);
  });

  it('listMemories 标记 project/global 来源，项目同名优先', () => {
    writeMemoryFile(projectMemoryDir(cwd), 'proj', 'project memory');
    writeMemoryFile(globalMemoryDir(), 'glob', 'global memory');
    writeMemoryFile(projectMemoryDir(cwd), 'dup', 'project dup');
    writeMemoryFile(globalMemoryDir(), 'dup', 'global dup');

    const entries = listMemories(cwd);
    expect(entries).toEqual([
      { name: 'dup', description: 'project dup', scope: 'project' },
      { name: 'glob', description: 'global memory', scope: 'global' },
      { name: 'proj', description: 'project memory', scope: 'project' },
    ]);
  });

  it('removeMemory 删除主题文件与索引行；找不到返回 null', () => {
    const dir = globalMemoryDir();
    writeMemoryFile(dir, 'glob', 'global memory');
    writeFileSync(
      join(dir, 'MEMORY.md'),
      '- [glob](glob.md) — global memory\n',
      'utf-8',
    );

    const r = removeMemory('glob', cwd);
    expect(r).toEqual({ file: join(dir, 'glob.md'), scope: 'global' });
    expect(existsSync(join(dir, 'glob.md'))).toBe(false);
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false);

    expect(removeMemory('missing', cwd)).toBeNull();
  });

  it('editMemory 项目同名记忆优先于全局，用默认程序打开项目文件', async () => {
    fakeSpawnSuccess();
    writeMemoryFile(projectMemoryDir(cwd), 'dup', 'project dup');
    writeMemoryFile(globalMemoryDir(), 'dup', 'global dup');

    const r = await editMemory('dup', cwd);
    expect(r.opened).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockedSpawn.mock.calls[0]!;
    expect(String(args)).toContain(join(projectMemoryDir(cwd), 'dup.md'));
    expect(String(args)).not.toContain(join(globalMemoryDir(), 'dup.md'));
  });

  it('editMemory 未知名返回清晰 not-found 且不 spawn', async () => {
    fakeSpawnSuccess();
    const r = await editMemory('missing', cwd);
    expect(r.opened).toBe(false);
    expect(r.message).toContain('未找到记忆 "missing"');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

describe('getAvailableTools 的 memory_save 过滤（CLI 视角）', () => {
  it('autoSave=false 时不含 memory_save，默认包含', async () => {
    await registerAllTools();
    const withSave = getAvailableTools({ ...baseConfig, memory: { autoSave: true } });
    expect(withSave.some((t) => t.name === 'memory_save')).toBe(true);
    const withoutSave = getAvailableTools({ ...baseConfig, memory: { autoSave: false } });
    expect(withoutSave.some((t) => t.name === 'memory_save')).toBe(false);
    expect(withoutSave.length).toBeLessThan(withSave.length);
  });
});
