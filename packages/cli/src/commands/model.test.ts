/**
 * /model 命令与有效模型查询测试
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRawConfig, globalConfigPath, loadConfig, resetPrices } from '@shenlan/core';
import type { ShenlanConfig } from '@shenlan/core';
import { modelCommand, getModel, buildModelOptions, initialModelSelection } from './model.js';
import {
  getEffectiveModel,
  enableAuto,
  setPolicy,
  resetSessionSticky,
  routeModelSticky,
  lockModel,
  initRoutingFromConfig,
  getPolicy,
  getLockedModel,
} from '../router.js';

// vitest 非 TTY：chalk.level=0 无色，输出可精确匹配
chalk.level = 0;

describe('getEffectiveModel — 实际生效模型（会话粘性优先，与 repl 调用一致）', () => {
  beforeEach(() => {
    enableAuto();
    setPolicy('cost-first');
    resetSessionSticky();
  });

  it('无粘性时返回默认模型', () => {
    expect(getEffectiveModel()).toBe('deepseek-v4-flash');
  });

  it('会话粘性路由结果优先', async () => {
    await routeModelSticky('权益卡逻辑介绍一下');
    expect(getEffectiveModel()).toBe('deepseek-v4-pro');
  });

  it('手动锁定模型后返回锁定值', () => {
    lockModel('deepseek-v4-pro');
    expect(getEffectiveModel()).toBe('deepseek-v4-pro');
  });
});

describe('modelCommand 无参输出', () => {
  beforeEach(() => {
    enableAuto();
    setPolicy('cost-first');
    resetSessionSticky();
  });

  it('auto 态：model: <生效模型> (auto · 策略)', () => {
    expect(modelCommand('')).toBe('model: deepseek-v4-flash (auto · cost-first)');
  });

  it('quality-first 策略展示对应策略', () => {
    setPolicy('quality-first');
    expect(modelCommand('')).toBe('model: deepseek-v4-flash (auto · quality-first)');
  });

  it('锁定态：model: <name> (locked)', () => {
    lockModel('deepseek-v4-pro');
    expect(modelCommand('')).toBe('model: deepseek-v4-pro (locked)');
  });

  it('带参会话粘性时展示实际路由模型', async () => {
    await routeModelSticky('帮我分析一下这个项目的架构');
    expect(modelCommand('')).toBe('model: deepseek-v4-pro (auto · cost-first)');
  });
});

describe('/model 持久化与启动恢复', () => {
  let tmp: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-model-'));
    process.env.SHENLAN_CONFIG_DIR = tmp;
    enableAuto();
    setPolicy('cost-first');
    resetSessionSticky();
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('/model <name> 锁定并落盘 routing.manual', () => {
    modelCommand('qwen-plus');
    expect(readRawConfig(globalConfigPath())?.routing).toEqual({
      policy: 'manual',
      lockedModel: 'qwen-plus',
    });
  });

  it('/model auto 写回 cost-first 并清空锁定（lockedModel: null）', () => {
    modelCommand('qwen-plus');
    modelCommand('auto');
    expect(readRawConfig(globalConfigPath())?.routing).toEqual({
      policy: 'cost-first',
      lockedModel: null,
    });
  });

  it('/model cost-first|quality-first 落盘对应策略', () => {
    modelCommand('quality-first');
    expect(readRawConfig(globalConfigPath())?.routing).toEqual({
      policy: 'quality-first',
      lockedModel: null,
    });
    modelCommand('cost-first');
    expect(readRawConfig(globalConfigPath())?.routing).toEqual({
      policy: 'cost-first',
      lockedModel: null,
    });
  });

  it('initRoutingFromConfig 重启恢复手动锁定', () => {
    modelCommand('qwen-plus');
    // 模拟重启：内存态全部重置后从配置恢复
    enableAuto();
    setPolicy('cost-first');
    resetSessionSticky();
    // 用临时 cwd 隔离：避免仓库 .shenlan/config.json 的 project 配置干扰
    const config = loadConfig(join(tmp, 'proj'));
    initRoutingFromConfig(config);
    expect(getPolicy()).toBe('manual');
    expect(getLockedModel()).toBe('qwen-plus');
    expect(getModel()).toBe('qwen-plus');
  });

  it('initRoutingFromConfig 无 routing 时让配置 model.model 生效（顺带修复既有割裂）', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-pro', maxTokens: 8192 },
      permissions: { mode: 'default', allow: ['read'], deny: [] },
      skills: [],
      mcpServers: [],
    }));
    const config = loadConfig(join(tmp, 'proj'));
    initRoutingFromConfig(config);
    expect(getPolicy()).toBe('cost-first');
    expect(getLockedModel()).toBeNull();
    expect(getModel()).toBe('deepseek-v4-pro');
  });
});

describe('buildModelOptions — /model 面板选项构建', () => {
  let tmp: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;
  // 本机/CI 环境可能预置 provider key 环境变量，干扰 available（hasProviderKey）
  // 判定——用例内一律隔离
  const realDeepseekKey = process.env.DEEPSEEK_API_KEY;
  const realQwenKey = process.env.QWEN_API_KEY;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-model-panel-'));
    process.env.SHENLAN_CONFIG_DIR = tmp;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.QWEN_API_KEY;
    enableAuto();
    setPolicy('cost-first');
    resetSessionSticky();
    resetPrices();
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    if (realDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realDeepseekKey;
    if (realQwenKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = realQwenKey;
    resetPrices();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const qwenConfig: ShenlanConfig = {
    model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
    providerKeys: { qwen: 'sk-qwen' },
    permissions: { mode: 'default', allow: ['read'], deny: [] },
    skills: [],
    mcpServers: [],
  };

  it('置顶 Default（自动路由）项，自动路由态下为 current', () => {
    const opts = buildModelOptions(qwenConfig);
    expect(opts[0]).toMatchObject({
      kind: 'auto',
      model: 'Default',
      available: true,
      current: true,
    });
    expect(opts[0].tag).toContain('自动路由');
  });

  it('按目录顺序列出模型：deepseek 在前，qwen-only key 时 deepseek 置灰、qwen 可用', () => {
    const opts = buildModelOptions(qwenConfig);
    const models = opts.filter(o => o.kind === 'model');
    expect(models[0]!.model).toBe('deepseek-v4-flash');
    expect(models[0]!.available).toBe(false);
    const qwen = models.find(m => m.model === 'qwen3.8-max')!;
    expect(qwen.available).toBe(true);
    expect(qwen.provider).toBe('qwen');
  });

  it('手动锁定后 ✔ 只在锁定行，Default 项不再 current', () => {
    lockModel('qwen3.8-max');
    resetSessionSticky();
    const opts = buildModelOptions(qwenConfig);
    expect(opts[0]!.current).toBe(false);
    const qwen = opts.find(m => m.kind === 'model' && m.model === 'qwen3.8-max')!;
    expect(qwen.current).toBe(true);
  });

  it('tag 与 priceText：内置价模型有价格段，无价格数据模型省略', () => {
    const opts = buildModelOptions({ ...qwenConfig, providerKeys: { deepseek: 'sk-ds', qwen: 'sk-qwen' } });
    const flash = opts.find(m => m.model === 'deepseek-v4-flash')!;
    expect(flash.priceText).toContain('¥');
    const qwenMax = opts.find(m => m.model === 'qwen3.8-max')!;
    expect(qwenMax.priceText).toBe('');
    expect(flash.tag.length).toBeGreaterThan(0);
  });

  it('锁定模型不在目录时追加为可用当前项', () => {
    lockModel('custom-model');
    resetSessionSticky();
    const opts = buildModelOptions(qwenConfig);
    const custom = opts.find(m => m.model === 'custom-model')!;
    expect(custom).toMatchObject({
      kind: 'model',
      available: true,
      current: true,
    });
  });

  it('initialModelSelection：当前项优先，其次首个可用项，兜底 0', () => {
    const base = {
      provider: 'x', group: 'x', contextWindow: 1, tag: '', priceText: '',
    };
    const noCurrent = [
      { kind: 'model' as const, model: 'a', available: false, current: false, ...base },
      { kind: 'model' as const, model: 'b', available: true, current: false, ...base },
    ];
    expect(initialModelSelection(noCurrent)).toBe(1);
    const withCurrent = noCurrent.map(m => m.model === 'b' ? { ...m, current: true } : m);
    expect(initialModelSelection(withCurrent)).toBe(1);
    const allUnavailable = noCurrent.map(m => ({ ...m, available: false }));
    expect(initialModelSelection(allUnavailable)).toBe(0);
  });

  it('分组标签：按来源端点分组——官方 deepseek / 百炼 / OpenAI 官方 三组（+ 自动路由）', () => {
    const opts = buildModelOptions({
      ...qwenConfig,
      providerKeys: { deepseek: 'sk-ds', bailian: 'sk-bailian', qwen: 'sk-qwen' },
    });
    expect(opts[0]!.group).toBe('自动路由');
    const ds = opts.find(m => m.model === 'deepseek-v4-pro')!;
    expect(ds.group).toBe('DeepSeek（官方 API）');
    const bailian = opts.find(m => m.model === 'deepseek-v4-pro-0813')!;
    expect(bailian.group).toBe('百炼 DashScope');
    const qwen = opts.find(m => m.model === 'qwen3.8-max')!;
    expect(qwen.group).toBe('百炼 DashScope');
    const openai = opts.find(m => m.model === 'gpt-5.4')!;
    expect(openai.group).toBe('OpenAI（官方 API）');
    // 同组连续：相邻两项 group 变化次数 = 组数 - 1（自动路由 / DeepSeek 官方 / 百炼 / OpenAI）
    const groupChanges = opts.slice(1).filter((o, i) => o.group !== opts[i]!.group).length;
    expect(groupChanges).toBe(3);
    // 组顺序：自动路由 → DeepSeek 官方 → 百炼 → OpenAI
    const firstIdx = (g: string) => opts.findIndex(o => o.group === g);
    expect(firstIdx('自动路由')).toBeLessThan(firstIdx('DeepSeek（官方 API）')!);
    expect(firstIdx('DeepSeek（官方 API）')!).toBeLessThan(firstIdx('百炼 DashScope')!);
    expect(firstIdx('百炼 DashScope')!).toBeLessThan(firstIdx('OpenAI（官方 API）')!);
  });

  it('锁定自定义模型归入 provider 首字母大写组', () => {
    lockModel('custom-model');
    resetSessionSticky();
    const opts = buildModelOptions(qwenConfig);
    const custom = opts.find(m => m.model === 'custom-model')!;
    expect(custom.group).toBe('Custom');
  });

  it('动态发现的目录外模型进入厂商分组但只标记为手动使用', () => {
    const opts = buildModelOptions({
      ...qwenConfig,
      providerKeys: { ...qwenConfig.providerKeys, zhipu: 'sk-zhipu' },
      providerModels: { zhipu: ['glm-new-runtime'] },
    });
    const dynamic = opts.find((m) => m.model === 'glm-new-runtime')!;
    expect(dynamic).toMatchObject({
      provider: 'zhipu',
      group: 'Zhipu',
      available: true,
      contextWindow: 0,
      tag: '动态发现 · 手动使用',
    });
  });
});
