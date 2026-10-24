import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  updateConfig,
  addMcpServerToConfig,
  removeMcpServerFromConfig,
  getMcpServerScopes,
  createDefaultConfigFile,
  ensureConfigSampleFiles,
  ensureProjectConfigFiles,
  readRawConfig,
  projectConfigPath,
  globalConfigPath,
} from '../config.js';

describe('config 写操作（作用域 + 原子写）', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-config-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('updateConfig 写项目作用域并保留其他字段', () => {
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      model: { baseUrl: 'https://x', apiKey: '', model: 'm', maxTokens: 1 },
      permissions: { mode: 'default', allow: ['read'], deny: [] },
      mcpServers: [],
    }));

    updateConfig({ mcpServers: [{ name: 'a', transport: 'stdio', command: 'node' }] }, { scope: 'project', cwd });

    const raw = JSON.parse(readFileSync(projectConfigPath(cwd), 'utf-8'));
    expect(raw.model.model).toBe('m'); // 其他字段保留
    expect(raw.permissions.allow).toEqual(['read']);
    expect(raw.mcpServers).toHaveLength(1);
  });

  it('updateConfig 数组为整体替换语义', () => {
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({ mcpServers: [{ name: 'a' }] }));
    updateConfig({ mcpServers: [] }, { scope: 'project', cwd });
    expect(JSON.parse(readFileSync(projectConfigPath(cwd), 'utf-8')).mcpServers).toEqual([]);
  });

  it('updateConfig 写全局作用域（SHENLAN_CONFIG_DIR 重定向）', () => {
    updateConfig({ skills: ['/custom/skills'] }, { scope: 'global' });
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.skills).toEqual(['/custom/skills']);
  });

  it('writeConfigFile 写入 0600（含密钥的配置文件不对外开放）', () => {
    updateConfig({ providerKeys: { deepseek: 'sk-secret' } }, { scope: 'global' });
    // Windows 无 POSIX 权限位（0600 尽力而为，AGENTS.md 平台约束）；仅 POSIX 平台断言
    if (process.platform !== 'win32') {
      const mode = statSync(globalConfigPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    updateConfig({ providerKeys: { deepseek: 'sk-secret' } }, { scope: 'project', cwd });
    if (process.platform !== 'win32') {
      const projectMode = statSync(projectConfigPath(cwd)).mode & 0o777;
      expect(projectMode).toBe(0o600);
    }
  });

  it('全局配置目录创建时用 0700', () => {
    const g = join(tmp, 'fresh-global');
    delete process.env.SHENLAN_CONFIG_DIR;
    process.env.SHENLAN_CONFIG_DIR = g;
    try {
      updateConfig({ providerKeys: { qwen: 'sk-q' } }, { scope: 'global' });
      if (process.platform !== 'win32') {
        const dirMode = statSync(g).mode & 0o777;
        expect(dirMode).toBe(0o700);
      }
    } finally {
      if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
      else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    }
  });

  it('createDefaultConfigFile 首次生成附带样例文件（config.sample.json/README.md/env.example，0600）', () => {
    const g = join(tmp, 'fresh-sample-global');
    delete process.env.SHENLAN_CONFIG_DIR;
    process.env.SHENLAN_CONFIG_DIR = g;
    try {
      createDefaultConfigFile(globalConfigPath());
      for (const name of ['config.json', 'config.sample.json', 'README.md', 'env.example']) {
        const p = join(g, name);
        expect(existsSync(p)).toBe(true);
        if (process.platform !== 'win32') {
          expect(statSync(p).mode & 0o777).toBe(0o600);
        }
      }
      if (process.platform !== 'win32') {
        expect(statSync(g).mode & 0o777).toBe(0o700);
      }
      const sample = JSON.parse(readFileSync(join(g, 'config.sample.json'), 'utf-8'));
      expect(sample.providerKeys).toHaveProperty('deepseek');
      expect(sample.costGuardrails.maxCostPerSession).toBe(5);
      expect(sample.agent.goalMaxSteps).toBe(300);
    } finally {
      if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
      else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    }
  });

  it('老用户升级补写：config.json 已存在、样例缺失 → ensureConfigSampleFiles 只补样例不碰 config.json', () => {
    const g = join(tmp, 'backfill-global');
    mkdirSync(g, { recursive: true });
    delete process.env.SHENLAN_CONFIG_DIR;
    process.env.SHENLAN_CONFIG_DIR = g;
    try {
      const cfg = join(g, 'config.json');
      writeFileSync(cfg, JSON.stringify({ customField: 'keep-me' }), 'utf-8');
      ensureConfigSampleFiles(cfg);

      expect(existsSync(join(g, 'config.sample.json'))).toBe(true);
      expect(existsSync(join(g, 'README.md'))).toBe(true);
      expect(existsSync(join(g, 'env.example'))).toBe(true);
      // config.json 原样保留
      expect(JSON.parse(readFileSync(cfg, 'utf-8'))).toEqual({ customField: 'keep-me' });
      // 再次调用幂等，不覆盖样例
      ensureConfigSampleFiles(cfg);
      expect(existsSync(join(g, 'config.sample.json'))).toBe(true);
    } finally {
      if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
      else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    }
  });

  it('ensureProjectConfigFiles 生成项目 config.json + 样例，且不覆盖已有项目配置', () => {
    const projCwd = join(tmp, 'new-proj');
    mkdirSync(projCwd, { recursive: true });
    ensureProjectConfigFiles(projCwd);

    const cfg = JSON.parse(readFileSync(projectConfigPath(projCwd), 'utf-8'));
    expect(cfg.model.model).toBe(''); // 项目默认 model 留空，沿用全局/默认
    expect(existsSync(join(projCwd, '.shenlan', 'config.sample.json'))).toBe(true);
    expect(existsSync(join(projCwd, '.shenlan', 'README.md'))).toBe(true);
    expect(existsSync(join(projCwd, '.shenlan', 'env.example'))).toBe(true);

    // 已存在项目配置：不覆盖
    writeFileSync(projectConfigPath(projCwd), JSON.stringify({ custom: true }), 'utf-8');
    ensureProjectConfigFiles(projCwd);
    expect(JSON.parse(readFileSync(projectConfigPath(projCwd), 'utf-8'))).toEqual({ custom: true });
  });

  it('readRawConfig 对损坏 JSON 抛错而非覆盖', () => {
    const f = join(cwd, '.shenlan', 'config.json');
    writeFileSync(f, '{broken');
    expect(() => readRawConfig(f)).toThrow(/无法解析/);
  });

  it('addMcpServerToConfig 新增并拒绝同作用域重名', () => {
    addMcpServerToConfig({ name: 'a', transport: 'stdio', command: 'node' }, 'project', cwd);
    expect(() => addMcpServerToConfig({ name: 'a', transport: 'http', url: 'http://x' }, 'project', cwd))
      .toThrow(/already exists/);
    const raw = JSON.parse(readFileSync(projectConfigPath(cwd), 'utf-8'));
    expect(raw.mcpServers).toHaveLength(1);
  });

  it('removeMcpServerFromConfig 删除并返回 removed 标志', () => {
    addMcpServerToConfig({ name: 'a', transport: 'stdio', command: 'node' }, 'project', cwd);
    const { removed } = removeMcpServerFromConfig('a', 'project', cwd);
    expect(removed).toBe(true);
    expect(JSON.parse(readFileSync(projectConfigPath(cwd), 'utf-8')).mcpServers).toHaveLength(0);
    expect(removeMcpServerFromConfig('a', 'project', cwd).removed).toBe(false);
  });

  it('getMcpServerScopes 项目覆盖全局', () => {
    const g = join(tmp, 'global');
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, 'config.json'), JSON.stringify({
      mcpServers: [{ name: 'shared', transport: 'stdio', command: 'g' }, { name: 'only-global', transport: 'stdio', command: 'g' }],
    }));
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      mcpServers: [{ name: 'shared', transport: 'stdio', command: 'p' }, { name: 'only-project', transport: 'stdio', command: 'p' }],
    }));
    const scopes = getMcpServerScopes(cwd);
    expect(scopes.get('shared')).toBe('project');
    expect(scopes.get('only-global')).toBe('global');
    expect(scopes.get('only-project')).toBe('project');
    expect(existsSync(join(g, 'config.json'))).toBe(true);
  });
});
