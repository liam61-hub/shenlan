import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnvFiles } from '../dotenv.js';
import { globalConfigPath } from '../config.js';

const TRACKED_KEYS = [
  'DEEPSEEK_API_KEY',
  'QWEN_API_KEY',
  'SHENLAN_API_KEY',
  'SHENLAN_MODEL',
  'TAVILY_API_KEY',
  'TEST_DOTENV_KEY',
];

describe('loadDotEnvFiles — .env 加载', () => {
  let projectDir: string;
  let globalDir: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shenlan-dotenv-proj-'));
    globalDir = mkdtempSync(join(tmpdir(), 'shenlan-dotenv-global-'));
    process.env.SHENLAN_CONFIG_DIR = globalDir;
    for (const k of TRACKED_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of TRACKED_KEYS) delete process.env[k];
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(globalDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('解析 KEY=VALUE、注释、空行、export 前缀、引号与 CRLF', () => {
    writeFileSync(join(projectDir, '.env'), [
      '# 注释行',
      '',
      'DEEPSEEK_API_KEY=sk-project-123456',
      'export QWEN_API_KEY="sk-qwen-123456"',
      "SHENLAN_API_KEY='sk-shenlan-123456'",
      'TAVILY_API_KEY=sk-tavily-123456\r',
      'NO_EQUALS_IGNORED',
      '',
    ].join('\n'), 'utf-8');

    const loaded = loadDotEnvFiles(projectDir);
    expect(loaded).toEqual([join(projectDir, '.env')]);
    expect(process.env.DEEPSEEK_API_KEY).toBe('sk-project-123456');
    expect(process.env.QWEN_API_KEY).toBe('sk-qwen-123456');
    expect(process.env.SHENLAN_API_KEY).toBe('sk-shenlan-123456');
    expect(process.env.TAVILY_API_KEY).toBe('sk-tavily-123456');
    expect(process.env.NO_EQUALS_IGNORED).toBeUndefined();
  });

  it('真实环境变量优先：.env 不覆盖已设置的键', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-real-env-1';
    writeFileSync(join(projectDir, '.env'), 'DEEPSEEK_API_KEY=sk-dotenv-1\n', 'utf-8');
    loadDotEnvFiles(projectDir);
    expect(process.env.DEEPSEEK_API_KEY).toBe('sk-real-env-1');
  });

  it('项目 .env 优先于全局 .env', () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, '.env'), 'DEEPSEEK_API_KEY=sk-global-1\n', 'utf-8');
    writeFileSync(join(projectDir, '.env'), 'DEEPSEEK_API_KEY=sk-project-1\n', 'utf-8');

    const loaded = loadDotEnvFiles(projectDir);
    expect(loaded).toEqual([join(projectDir, '.env'), join(globalDir, '.env')]);
    expect(process.env.DEEPSEEK_API_KEY).toBe('sk-project-1');
  });

  it('只有全局 .env 时生效', () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, '.env'), 'QWEN_API_KEY=sk-global-qwen\n', 'utf-8');
    loadDotEnvFiles(projectDir);
    expect(process.env.QWEN_API_KEY).toBe('sk-global-qwen');
  });

  it('文件缺失 / 损坏行：不抛错、返回已加载路径', () => {
    writeFileSync(join(projectDir, '.env'), 'broken line without eq\nDEEPSEEK_API_KEY=sk-ok-1\n', 'utf-8');
    const loaded = loadDotEnvFiles(projectDir);
    expect(process.env.DEEPSEEK_API_KEY).toBe('sk-ok-1');
    expect(loaded).toHaveLength(1);

    // 无任何 .env 文件
    const empty = mkdtempSync(join(tmpdir(), 'shenlan-dotenv-empty-'));
    try {
      expect(loadDotEnvFiles(empty)).toEqual([]);
    } finally {
      try { rmSync(empty, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('SHENLAN_CONFIG_DIR 重定向全局 .env 路径', () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, '.env'), 'TEST_DOTENV_KEY=via-config-dir\n', 'utf-8');
    loadDotEnvFiles(projectDir);
    expect(process.env.TEST_DOTENV_KEY).toBe('via-config-dir');
    expect(globalConfigPath()).toBe(join(globalDir, 'config.json'));
  });
});
