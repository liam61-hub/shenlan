/**
 * /config 命令测试 — get/set/unset/无参展示/敏感掩码/scope 落盘
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRawConfig, globalConfigPath, projectConfigPath, loadConfig } from '@shenlan/core';
import {
  configCommand,
  completeConfigKey,
  buildConfigRows,
  configPanelSet,
  configPanelUnset,
  reloadConfigInPlace,
} from './config.js';

// vitest 非 TTY：chalk.level=0 无色，输出可精确匹配
chalk.level = 0;

describe('/config 命令', () => {
  let tmp: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-config-'));
    process.env.SHENLAN_CONFIG_DIR = tmp;
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    delete process.env.SHENLAN_MODEL;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('无参展示当前生效配置（含各键与描述，敏感键掩码）', () => {
    const out = configCommand('', join(tmp, 'proj'));
    expect(out).toContain('balanceCheck.enabled: true');
    expect(out).toContain('context.autoCompactTokenLimit: 200000');
    expect(out).toContain('tavily.enabled: false');
    expect(out).toContain('default');
  });

  it('无参展示时 providerKeys 动态列出且掩码', () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: '', model: '' },
      providerKeys: { deepseek: 'sk-1234567890' },
    }));
    const out = configCommand('', cwd);
    expect(out).toContain('providerKeys.deepseek: sk-1****7890');
  });

  it('无参展示时 model.baseUrl 与 confirmPhrase 掩码（不出现明文端点/短语）', () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      model: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: '' },
      actionSafety: { confirmPhrase: 'super-secret-phrase' },
    }));
    const out = configCommand('', cwd);
    expect(out).not.toContain('https://api.deepseek.com/v1');
    expect(out).not.toContain('super-secret-phrase');
    expect(out).toContain('model.baseUrl:');
  });

  it('无参展示时 providerBaseUrls 动态列出且掩码', () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: '', model: '' },
      providerBaseUrls: { qwen: 'https://dashscope.aliyuncs.com/v1' },
    }));
    const out = configCommand('', cwd);
    expect(out).not.toContain('https://dashscope.aliyuncs.com/v1');
    expect(out).toContain('providerBaseUrls.qwen:');
  });

  it('set providerBaseUrls.<provider> 生效且回显掩码', () => {
    const cwd = join(tmp, 'proj');
    const out = configCommand('set providerBaseUrls.qwen https://dashscope.aliyuncs.com/v1', cwd);
    expect(out).not.toContain('https://dashscope.aliyuncs.com/v1');
    expect(readRawConfig(projectConfigPath(cwd))?.providerBaseUrls).toMatchObject({
      qwen: 'https://dashscope.aliyuncs.com/v1',
    });
  });

  it('无参展示包含环境变量区：未设置显示 —，已设置掩码/原样', () => {
    delete process.env.SHENLAN_MODEL;
    process.env.SHENLAN_API_KEY = 'sk-env-12345678';
    process.env.SHENLAN_DEBUG = '1';
    const out = configCommand('', join(tmp, 'proj'));
    expect(out).toContain('SHENLAN_MODEL: —');
    expect(out).toContain('SHENLAN_API_KEY: sk-e****5678');
    expect(out).not.toContain('sk-env-12345678');
    expect(out).toContain('SHENLAN_DEBUG: 1');
    expect(out).toContain('SHENLAN_CONFIG_DIR:');
    expect(out).toContain('(unset)');
    delete process.env.SHENLAN_API_KEY;
    delete process.env.SHENLAN_DEBUG;
  });

  it('无参展示环境变量区枚举已设置的 <PROVIDER>_API_KEY（掩码）', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key-12345678';
    const out = configCommand('', join(tmp, 'proj'));
    expect(out).toContain('DEEPSEEK_API_KEY: ds-k****5678');
    expect(out).not.toContain('ds-key-12345678');
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('未设置键显示 — 而非 undefined', () => {
    const out = configCommand('get routing.lockedModel', join(tmp, 'proj'));
    expect(out).toContain('routing.lockedModel: —');
    expect(out).not.toContain('undefined');
  });

  it('get 显示值与来源（默认）', () => {
    const out = configCommand('get balanceCheck.lowBalanceWarnThreshold', join(tmp, 'proj'));
    expect(out).toContain('balanceCheck.lowBalanceWarnThreshold: 1');
    expect(out).toContain('default');
  });

  it('get 环境变量来源标注 env', () => {
    process.env.SHENLAN_MODEL = 'deepseek-v4-pro';
    const out = configCommand('get model.model', join(tmp, 'proj'));
    expect(out).toContain('model.model: deepseek-v4-pro');
    expect(out).toContain('env');
  });

  it('get 项目配置来源标注 project', () => {
    const cwd = join(tmp, 'proj');
    configCommand('set memory.autoSave false', cwd);
    const out = configCommand('get memory.autoSave', cwd);
    expect(out).toContain('memory.autoSave: false');
    expect(out).toContain('project');
  });

  it('get 未知键报错', () => {
    const out = configCommand('get nope.unknown', join(tmp, 'proj'));
    expect(out).toContain('Unknown config key');
  });

  it('set 数字：写项目配置且类型为 number', () => {
    const cwd = join(tmp, 'proj');
    const out = configCommand('set balanceCheck.lowBalanceWarnThreshold 10', cwd);
    expect(out).toContain('Project');
    expect(readRawConfig(projectConfigPath(cwd))?.balanceCheck).toMatchObject({ lowBalanceWarnThreshold: 10 });
  });

  it('set 布尔：false 正确写入', () => {
    const cwd = join(tmp, 'proj');
    configCommand('set balanceCheck.enabled false', cwd);
    expect(readRawConfig(projectConfigPath(cwd))?.balanceCheck).toMatchObject({ enabled: false });
  });

  it('set 类型错误：布尔键给非布尔值', () => {
    const out = configCommand('set balanceCheck.enabled yes', join(tmp, 'proj'));
    expect(out).toContain('boolean');
  });

  it('set 取值错误：allowedValues 之外', () => {
    const out = configCommand('set routing.policy random', join(tmp, 'proj'));
    expect(out).toContain('cost-first');
  });

  it('set 未知键报错且不落盘', () => {
    const cwd = join(tmp, 'proj');
    const out = configCommand('set nope.x 1', cwd);
    expect(out).toContain('未知配置项');
    expect(readRawConfig(projectConfigPath(cwd))).toBeNull();
  });

  it('set --global 写全局配置', () => {
    const cwd = join(tmp, 'proj');
    configCommand('set context.keepRecentTurns 30 --global', cwd);
    expect(readRawConfig(globalConfigPath())?.context).toMatchObject({ keepRecentTurns: 30 });
    expect(readRawConfig(projectConfigPath(cwd))).toBeNull();
  });

  it('set 敏感键回显掩码', () => {
    const out = configCommand('set providerKeys.tavily tvly-abcdef123456', join(tmp, 'proj'));
    expect(out).toContain('tvly****3456');
    expect(out).not.toContain('tvly-abcdef123456');
  });

  it('unset 删除项目配置键（恢复默认）', () => {
    const cwd = join(tmp, 'proj');
    configCommand('set balanceCheck.lowBalanceWarnThreshold 10', cwd);
    const out = configCommand('unset balanceCheck.lowBalanceWarnThreshold', cwd);
    expect(out).toContain('removed');
    expect(readRawConfig(projectConfigPath(cwd))?.balanceCheck).toBeUndefined();
    expect(loadConfig(cwd).balanceCheck?.lowBalanceWarnThreshold).toBe(1);
  });

  it('unset 未设置的键提示未设置', () => {
    const out = configCommand('unset balanceCheck.lowBalanceWarnThreshold', join(tmp, 'proj'));
    expect(out).toContain('not set');
  });
});

describe('buildConfigRows / configPanelSet / configPanelUnset / reloadConfigInPlace（交互面板数据层）', () => {
  let tmp: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-config-panel-'));
    process.env.SHENLAN_CONFIG_DIR = tmp;
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    delete process.env.SHENLAN_MODEL;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('buildConfigRows 覆盖 schema 全量 + 动态 provider 行，敏感值掩码', () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      model: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: '' },
      providerKeys: { deepseek: 'sk-1234567890' },
      providerBaseUrls: { qwen: 'https://dashscope.example.com/v1' },
    }));
    const rows = buildConfigRows(loadConfig(cwd), cwd);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(rows.length).toBeGreaterThan(30);
    expect(byKey.get('balanceCheck.enabled')?.kind).toBe('boolean');
    expect(byKey.get('permissions.mode')?.kind).toBe('enum');
    expect(byKey.get('permissions.mode')?.allowedValues).toEqual(['default', 'acceptEdits', 'bypassPermissions']);
    expect(byKey.get('agent.maxSteps')?.kind).toBe('number');
    expect(byKey.get('actionSafety.protectedPaths')?.kind).toBe('array');
    expect(byKey.get('model.baseUrl')?.secret).toBe(true);
    expect(byKey.get('model.baseUrl')?.display).not.toContain('https://api.deepseek.com');
    expect(byKey.get('model.baseUrl')?.source).toBe('project');
    expect(byKey.get('providerKeys.deepseek')?.display).toBe('sk-1****7890');
    expect(byKey.get('providerKeys.deepseek')?.raw).toBe('sk-1234567890');
    expect(byKey.get('providerBaseUrls.qwen')?.secret).toBe(true);
  });

  it('configPanelSet 校验并写盘（项目/全局），非法值拒绝', () => {
    const cwd = join(tmp, 'proj');
    expect(configPanelSet('agent.maxSteps', '150', 'project', cwd).ok).toBe(true);
    expect(readRawConfig(projectConfigPath(cwd))?.agent).toMatchObject({ maxSteps: 150 });
    const bad = configPanelSet('agent.maxSteps', 'abc', 'project', cwd);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('number');
    expect(configPanelSet('balanceCheck.enabled', 'false', 'global', cwd).ok).toBe(true);
    expect(readRawConfig(globalConfigPath())?.balanceCheck).toMatchObject({ enabled: false });
  });

  it('configPanelUnset 删除键并 prune 空父对象；未设置返回 null', () => {
    const cwd = join(tmp, 'proj');
    configPanelSet('balanceCheck.lowBalanceWarnThreshold', '10', 'project', cwd);
    expect(configPanelUnset('balanceCheck.lowBalanceWarnThreshold', 'project', cwd)).toBe('balanceCheck.lowBalanceWarnThreshold');
    expect(readRawConfig(projectConfigPath(cwd))?.balanceCheck).toBeUndefined();
    expect(configPanelUnset('balanceCheck.lowBalanceWarnThreshold', 'project', cwd)).toBeNull();
  });

  it('reloadConfigInPlace 保持同一引用并刷新为最新盘上值', () => {
    const cwd = join(tmp, 'proj');
    const config = loadConfig(cwd);
    expect(config.agent?.maxSteps).toBe(80);
    configPanelSet('agent.maxSteps', '150', 'project', cwd);
    reloadConfigInPlace(config, cwd);
    expect(config.agent?.maxSteps).toBe(150);
    configPanelUnset('agent.maxSteps', 'project', cwd);
    reloadConfigInPlace(config, cwd);
    expect(config.agent?.maxSteps).toBe(80);
  });

  it('language 默认英文：文本清单与面板行描述为英文', () => {
    const cwd = join(tmp, 'proj');
    const out = configCommand('', cwd);
    expect(out).toContain('UI language (en / zh-CN)');
    expect(out).not.toContain('界面语言');
    const rows = buildConfigRows(loadConfig(cwd), cwd);
    expect(rows.find((r) => r.key === 'language')?.description).toBe('UI language (en / zh-CN)');
    expect(rows.find((r) => r.key === 'agent.maxSteps')?.description).toBe('Headless agent run max steps');
  });

  it('language=zh-CN 时切换为中文描述', () => {
    const cwd = join(tmp, 'proj');
    configPanelSet('language', 'zh-CN', 'global', cwd);
    const out = configCommand('', cwd);
    expect(out).toContain('界面语言（en / zh-CN）');
    const rows = buildConfigRows(loadConfig(cwd), cwd);
    expect(rows.find((r) => r.key === 'language')?.description).toBe('界面语言（en / zh-CN）');
    expect(rows.find((r) => r.key === 'agent.maxSteps')?.description).toBe('无界面单次 Agent 运行步数上限');
  });

  it('language 非法取值被校验拒绝', () => {
    const cwd = join(tmp, 'proj');
    const r = configPanelSet('language', 'fr', 'project', cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('en');
  });
});

describe('completeConfigKey — /config 键路径 Tab 补全', () => {
  it('前缀多匹配补全到最长公共前缀', () => {
    expect(completeConfigKey('/config get cost')).toBeNull();
    expect(completeConfigKey('/config set balanceCheck.low')).toBe('/config set balanceCheck.lowBalanceWarnThreshold');
  });

  it('唯一匹配直接补全完整键', () => {
    expect(completeConfigKey('/config get tavily.')).toBe('/config get tavily.enabled');
  });

  it('公共前缀等于输入时返回 null（避免死循环补全）', () => {
    expect(completeConfigKey('/config get balanceCheck.lowBalanceWarnThreshold')).toBe('/config get balanceCheck.lowBalanceWarnThreshold');
  });

  it('无匹配返回 null', () => {
    expect(completeConfigKey('/config get nope')).toBeNull();
  });

  it('非 /config 命令输入返回 null', () => {
    expect(completeConfigKey('/model cost')).toBeNull();
  });
});
