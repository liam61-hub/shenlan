import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, PROVIDER_PRESETS, resolveBaseUrl, resolveApiKey, hasProviderKey, hasAnyProviderKey, detectProvider, resolveModelProvider, detectProviderFromUrl, chatCompletionsUrl, normalizeBaseUrl, loadConfig } from '../config.js';
import type { ShenlanConfig } from '../config.js';

/** 路由相关测试需要干净的环境变量（防止宿主 shell 的 key 影响可用集判断） */
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'SHENLAN_API_KEY', 'OPENAI_API_KEY', 'GPT_API_KEY']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('DEFAULT_CONFIG', () => {
  it('has valid model config', () => {
    expect(DEFAULT_CONFIG.model.model).toBeDefined();
    expect(DEFAULT_CONFIG.model.maxTokens).toBeGreaterThan(0);
    // baseUrl 默认空：实际端点由 resolveBaseUrl 按模型 provider 解析
    expect(DEFAULT_CONFIG.model.baseUrl).toBe('');
  });

  it('has valid permissions', () => {
    expect(DEFAULT_CONFIG.permissions.mode).toBe('default');
    expect(DEFAULT_CONFIG.permissions.allow).toContain('read');
  });

  it('has arrays for skills and mcpServers', () => {
    expect(Array.isArray(DEFAULT_CONFIG.skills)).toBe(true);
    expect(Array.isArray(DEFAULT_CONFIG.mcpServers)).toBe(true);
  });

  it('has agent and context defaults for long-task guardrails', () => {
    expect(DEFAULT_CONFIG.agent?.maxSteps).toBe(80);
    expect(DEFAULT_CONFIG.context?.autoCompactTokenLimit).toBe(200_000);
    expect(DEFAULT_CONFIG.context?.keepRecentTurns).toBe(20);
    expect(DEFAULT_CONFIG.context?.toolOutputLimitChars).toBe(8000);
    // compactModel 默认空：跟随主模型 provider（deepseek → flash，qwen → plus）
    expect(DEFAULT_CONFIG.context?.compactModel).toBe('');
  });

  it('has a separate balance precheck config', () => {
    expect(DEFAULT_CONFIG.balanceCheck).toEqual({ enabled: true, lowBalanceWarnThreshold: 1 });
    expect('costGuardrails' in DEFAULT_CONFIG).toBe(false);
  });
});

describe('resolveBaseUrl — 三级优先级', () => {
  const base = (overrides: Partial<ShenlanConfig> = {}): ShenlanConfig => ({
    ...DEFAULT_CONFIG,
    ...overrides,
  });

  it('内置默认：deepseek → api.deepseek.com', () => {
    expect(resolveBaseUrl(base(), 'deepseek-v4-flash')).toBe('https://api.deepseek.com');
  });

  it('内置默认：qwen → dashscope compatible-mode', () => {
    expect(resolveBaseUrl(base(), 'qwen-plus')).toBe('https://dashscope.aliyuncs.com/compatible-mode');
  });

  it('内置默认：openai → api.openai.com', () => {
    expect(resolveBaseUrl(base(), 'gpt-5.4')).toBe('https://api.openai.com');
  });

  it('未知 provider 无 baseUrl → 抛错且文案含 provider 与 baseUrl 引导', () => {
    expect(() => resolveBaseUrl(base(), 'llama-3.1-70b')).toThrow(/provider "llama"/);
    expect(() => resolveBaseUrl(base(), 'llama-3.1-70b')).toThrow(/base URL|model\.baseUrl|providerBaseUrls/);
  });

  it('未知 provider + 显式 model.baseUrl（未知网关）→ 尊重不抛错', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://llama.example.com' } });
    expect(resolveBaseUrl(config, 'llama-3.1-70b')).toBe('https://llama.example.com');
  });

  it('未知 provider + providerBaseUrls 显式 → 原样返回（不抛错）', () => {
    const config = base({ providerBaseUrls: { llama: 'https://llama.example.com' } });
    expect(resolveBaseUrl(config, 'llama-3.1-70b')).toBe('https://llama.example.com');
  });

  it('providerBaseUrls 显式覆盖优先于内置默认', () => {
    const config = base({ providerBaseUrls: { qwen: 'https://qwen.example.com' } });
    expect(resolveBaseUrl(config, 'qwen-plus')).toBe('https://qwen.example.com');
  });

  it('显式 model.baseUrl 与模型 provider 一致时尊重', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://my.deepseek.gw' } });
    expect(resolveBaseUrl(config, 'deepseek-v4-pro')).toBe('https://my.deepseek.gw');
  });

  it('未知网关（one-api 类）显式 baseUrl 尊重', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://oneapi.example.com/v1' } });
    // 尊重未知网关配置，但剥离末尾 /v1（客户端统一拼 /v1/chat/completions）
    expect(resolveBaseUrl(config, 'qwen-plus')).toBe('https://oneapi.example.com');
  });

  it('显式 baseUrl 属于其他已知 provider 时不尊重，回落内置默认', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://api.deepseek.com' } });
    expect(resolveBaseUrl(config, 'qwen-plus')).toBe('https://dashscope.aliyuncs.com/compatible-mode');
  });

  it('兼容遗留 /anthropic 后缀：归一化到根路径', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://api.deepseek.com/anthropic' } });
    expect(resolveBaseUrl(config, 'deepseek-v4-flash')).toBe('https://api.deepseek.com');
  });

  it('DashScope Anthropic 协议端点 → compatible-mode', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' } });
    expect(resolveBaseUrl(config, 'qwen-plus')).toBe('https://dashscope.aliyuncs.com/compatible-mode');
  });

  it('DashScope 国际版 Anthropic 端点 → compatible-mode', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic' } });
    expect(resolveBaseUrl(config, 'qwen-max')).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode');
  });

  it('显式 baseUrl 末尾 /v1 剥离（避免双重 /v1 拼接）', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, baseUrl: 'https://api.deepseek.com/v1' } });
    expect(resolveBaseUrl(config, 'deepseek-v4-flash')).toBe('https://api.deepseek.com');
  });
});

describe('loadConfig — 旧项目默认模板不覆盖全局模型配置', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-loadconfig-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    mkdirSync(join(tmp, 'global'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('全局 qwen + 旧自动生成模板项目配置 → 全局模型生效（不被 deepseek 覆盖）', () => {
    writeFileSync(join(tmp, 'global', 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: 'sk-qwen', model: 'qwen3.8-max', maxTokens: 8192 },
    }));
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      model: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
      permissions: { mode: 'default', allow: ['read'], deny: [] },
      skills: [],
      mcpServers: [],
    }));
    const config = loadConfig(cwd);
    expect(config.model.model).toBe('qwen3.8-max');
    expect(config.model.apiKey).toBe('sk-qwen');
  });

  it('项目显式自定义 model（非模板）仍覆盖全局', () => {
    writeFileSync(join(tmp, 'global', 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: 'sk-qwen', model: 'qwen3.8-max', maxTokens: 8192 },
    }));
    writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
      model: { baseUrl: 'https://my.gw', apiKey: 'sk-proj', model: 'qwen-plus', maxTokens: 4096 },
    }));
    const config = loadConfig(cwd);
    expect(config.model.model).toBe('qwen-plus');
    expect(config.model.baseUrl).toBe('https://my.gw');
    expect(config.model.apiKey).toBe('sk-proj');
  });
});

describe('hasProviderKey — 排除 model.apiKey 兜底', () => {
  const base = (overrides: Partial<ShenlanConfig> = {}): ShenlanConfig => ({
    ...DEFAULT_CONFIG,
    ...overrides,
  });

  it('仅 model.apiKey 时不判为可用（避免所有 provider 全被误判）', () => {
    const config = base({ model: { ...DEFAULT_CONFIG.model, apiKey: 'sk-fallback' } });
    expect(hasProviderKey(config, 'deepseek')).toBe(false);
    expect(hasProviderKey(config, 'qwen')).toBe(false);
  });

  it('providerKeys 命中即判可用', () => {
    expect(hasProviderKey(base({ providerKeys: { deepseek: 'sk-ds' } }), 'deepseek')).toBe(true);
    expect(hasProviderKey(base({ providerKeys: { qwen: 'sk-qwen' } }), 'qwen')).toBe(true);
    expect(hasProviderKey(base({ providerKeys: { qwen: 'sk-qwen' } }), 'deepseek')).toBe(false);
  });

  it('环境变量 <PROVIDER>_API_KEY 命中即判可用', () => {
    process.env.QWEN_API_KEY = 'sk-env';
    try {
      expect(hasProviderKey(base(), 'qwen')).toBe(true);
      expect(hasProviderKey(base(), 'deepseek')).toBe(false);
    } finally {
      delete process.env.QWEN_API_KEY;
    }
  });

  it('OPENAI_API_KEY 环境变量 → openai 判可用（别名探测生效）', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    try {
      expect(hasProviderKey(base(), 'openai')).toBe(true);
      expect(hasProviderKey(base(), 'qwen')).toBe(false);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('GPT_API_KEY 历史别名 → openai 判可用', () => {
    process.env.GPT_API_KEY = 'sk-gpt-legacy';
    try {
      expect(hasProviderKey(base(), 'openai')).toBe(true);
    } finally {
      delete process.env.GPT_API_KEY;
    }
  });
});

describe('loadConfig 归一化 — model.apiKey 归入 providerKeys（仅内存）', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-normalize-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    mkdirSync(join(tmp, 'global'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('旧 model.apiKey（deepseek 模型）→ providerKeys.deepseek 补齐，/model 可用集可识别', () => {
    writeFileSync(join(tmp, 'global', 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: 'sk-legacy', model: 'deepseek-v4-flash', maxTokens: 8192 },
    }));
    const config = loadConfig(cwd);
    expect(config.providerKeys?.deepseek).toBe('sk-legacy');
    expect(hasProviderKey(config, 'deepseek')).toBe(true);
  });

  it('不改写磁盘：原始配置文件仍保留 model.apiKey 且无 providerKeys', () => {
    writeFileSync(join(tmp, 'global', 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: 'sk-legacy', model: 'deepseek-v4-flash', maxTokens: 8192 },
    }));
    loadConfig(cwd);
    const raw = JSON.parse(readFileSync(join(tmp, 'global', 'config.json'), 'utf-8'));
    expect(raw.model.apiKey).toBe('sk-legacy');
    expect(raw.providerKeys).toBeUndefined();
  });

  it('显式 providerKeys 已配置时不覆盖', () => {
    writeFileSync(join(tmp, 'global', 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: 'sk-legacy', model: 'deepseek-v4-flash', maxTokens: 8192 },
      providerKeys: { deepseek: 'sk-correct' },
    }));
    const config = loadConfig(cwd);
    expect(config.providerKeys?.deepseek).toBe('sk-correct');
  });

  it('环境变量已设置时归一化跳过（env 优先级不变）', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    try {
      writeFileSync(join(tmp, 'global', 'config.json'), JSON.stringify({
        model: { baseUrl: '', apiKey: 'sk-legacy', model: 'deepseek-v4-flash', maxTokens: 8192 },
      }));
      const config = loadConfig(cwd);
      // env 优先：resolveApiKey 返回 env key
      expect(resolveApiKey(config, 'deepseek')).toBe('sk-env');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
});

describe('hasAnyProviderKey', () => {
  it('无任何 key → false', () => {
    expect(hasAnyProviderKey({ ...DEFAULT_CONFIG })).toBe(false);
  });

  it('providerKeys 任一非空 → true', () => {
    expect(hasAnyProviderKey({ ...DEFAULT_CONFIG, providerKeys: { qwen: 'sk-q' } })).toBe(true);
    expect(hasAnyProviderKey({ ...DEFAULT_CONFIG, providerKeys: { deepseek: '' } })).toBe(false);
  });

  it('model.apiKey 单独存在 → false（归一化前视图；归一化发生在 loadConfig）', () => {
    expect(hasAnyProviderKey({ ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, apiKey: 'sk-x' } })).toBe(false);
  });

  it('环境变量 SHENLAN_API_KEY → true', () => {
    process.env.SHENLAN_API_KEY = 'sk-env';
    try {
      expect(hasAnyProviderKey({ ...DEFAULT_CONFIG })).toBe(true);
    } finally {
      delete process.env.SHENLAN_API_KEY;
    }
  });

  it('provider 环境变量（DEEPSEEK_API_KEY / QWEN_API_KEY）→ true（.env 加载后同样生效）', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    try {
      expect(hasAnyProviderKey({ ...DEFAULT_CONFIG })).toBe(true);
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
    process.env.QWEN_API_KEY = 'sk-env';
    try {
      expect(hasAnyProviderKey({ ...DEFAULT_CONFIG })).toBe(true);
    } finally {
      delete process.env.QWEN_API_KEY;
    }
  });

  it('OPENAI_API_KEY 环境变量 → true（只设 OpenAI key 的用户不再误判无 key）', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    try {
      expect(hasAnyProviderKey({ ...DEFAULT_CONFIG })).toBe(true);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('resolveApiKey — model.apiKey 兜底只在 key 属于目标 provider 时生效', () => {
  const base = (overrides: Partial<ShenlanConfig> = {}): ShenlanConfig => ({
    ...DEFAULT_CONFIG,
    ...overrides,
  });

  it('provider 匹配（qwen 模型 + dashscope baseUrl）→ 返回 model.apiKey', () => {
    const config = base({
      model: {
        ...DEFAULT_CONFIG.model,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
        apiKey: 'sk-qwen',
        model: 'qwen3.8-max',
      },
    });
    expect(resolveApiKey(config, 'qwen')).toBe('sk-qwen');
  });

  it('baseUrl 为空时按配置模型名推断 key 归属', () => {
    const config = base({
      model: { ...DEFAULT_CONFIG.model, apiKey: 'sk-ds', model: 'deepseek-v4-flash' },
    });
    expect(resolveApiKey(config, 'deepseek')).toBe('sk-ds');
    expect(resolveApiKey(config, 'qwen')).toBe('');
  });

  it('key 属于其他 provider 时不发送（防跨端点泄露）→ 返回空串', () => {
    const config = base({
      model: {
        ...DEFAULT_CONFIG.model,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
        apiKey: 'sk-qwen',
        model: 'qwen3.8-max',
      },
    });
    expect(resolveApiKey(config, 'deepseek')).toBe('');
  });

  it('未知网关 baseUrl 的 key 视为通用 key，任意 provider 可用', () => {
    const config = base({
      model: {
        ...DEFAULT_CONFIG.model,
        baseUrl: 'https://oneapi.example.com/v1',
        apiKey: 'sk-gw',
        model: 'deepseek-v4-flash',
      },
    });
    expect(resolveApiKey(config, 'deepseek')).toBe('sk-gw');
    expect(resolveApiKey(config, 'qwen')).toBe('sk-gw');
  });

  it('providerKeys 命中优先于 model.apiKey（不受匹配检查影响）', () => {
    const config = base({
      providerKeys: { deepseek: 'sk-ds' },
      model: { ...DEFAULT_CONFIG.model, apiKey: 'sk-qwen', model: 'qwen3.8-max' },
    });
    expect(resolveApiKey(config, 'deepseek')).toBe('sk-ds');
  });

  it('gpt-5.4 → provider openai → OPENAI_API_KEY 命中（环境变量别名主路径）', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    try {
      expect(detectProvider('gpt-5.4')).toBe('openai');
      expect(resolveApiKey(base(), 'openai')).toBe('sk-openai');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('GPT_API_KEY 历史别名仍命中（openai 兼容）', () => {
    process.env.GPT_API_KEY = 'sk-gpt-legacy';
    try {
      expect(resolveApiKey(base(), 'openai')).toBe('sk-gpt-legacy');
    } finally {
      delete process.env.GPT_API_KEY;
    }
  });

  it('别名优先级：OPENAI_API_KEY 先于 GPT_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.GPT_API_KEY = 'sk-gpt-legacy';
    try {
      expect(resolveApiKey(base(), 'openai')).toBe('sk-openai');
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.GPT_API_KEY;
    }
  });
});

describe('detectProviderFromUrl', () => {
  it('识别 deepseek / dashscope 域名', () => {
    expect(detectProviderFromUrl('https://api.deepseek.com')).toBe('deepseek');
    expect(detectProviderFromUrl('https://dashscope.aliyuncs.com/compatible-mode')).toBe('qwen');
    expect(detectProviderFromUrl('https://oneapi.example.com/v1')).toBe('');
  });

  it('识别 openai 域名（api.openai.com 显式端点归类）', () => {
    expect(detectProviderFromUrl('https://api.openai.com')).toBe('openai');
    expect(detectProviderFromUrl('https://api.openai.com/v1')).toBe('openai');
  });
});

describe('detectProvider', () => {
  it('百炼托管的 deepseek 快照 → bailian，官方 deepseek 系列不受影响', () => {
    expect(detectProvider('deepseek-v4-pro-0813')).toBe('bailian');
    expect(detectProvider('deepseek-v4-pro')).toBe('deepseek');
    expect(detectProvider('deepseek-v4-flash')).toBe('deepseek');
    expect(detectProvider('qwen3.8-max')).toBe('qwen');
  });

  it('OpenAI 官方系列 → openai（gpt-5.x 主线与 o1/o3/o4 遗留）', () => {
    expect(detectProvider('gpt-5.4')).toBe('openai');
    expect(detectProvider('gpt-5.4-mini')).toBe('openai');
    expect(detectProvider('o1-preview')).toBe('openai');
    expect(detectProvider('o3-mini')).toBe('openai');
  });

  it('未知模型保持分段兜底（llama-3.1-70b → llama）', () => {
    expect(detectProvider('llama-3.1-70b')).toBe('llama');
  });
});

describe('显式 provider 与动态模型归属', () => {
  const configWith = (patch: Partial<ShenlanConfig>): ShenlanConfig => ({
    ...DEFAULT_CONFIG,
    model: { ...DEFAULT_CONFIG.model },
    permissions: { ...DEFAULT_CONFIG.permissions },
    ...patch,
  });

  it('内置厂商表覆盖 7 家且 id 唯一', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      'deepseek', 'qwen', 'bailian', 'openai', 'doubao', 'zhipu', 'kimi',
    ]);
    expect(new Set(PROVIDER_PRESETS.map((p) => p.id)).size).toBe(PROVIDER_PRESETS.length);
  });

  it('providerModels 优先于模型名前缀推断，并驱动 endpoint/key 归属', () => {
    const config = configWith({
      providerKeys: { 'my-gw': 'sk-gw' },
      providerBaseUrls: { 'my-gw': 'https://gw.example.com' },
      providerModels: { 'my-gw': ['deepseek-compatible-alias'] },
    });
    expect(resolveModelProvider(config, 'deepseek-compatible-alias')).toBe('my-gw');
    expect(resolveBaseUrl(config, 'deepseek-compatible-alias')).toBe('https://gw.example.com');
    expect(resolveApiKey(config, resolveModelProvider(config, 'deepseek-compatible-alias'))).toBe('sk-gw');
  });

  it('同一模型映射到多个厂商时拒绝解析，防止跨厂商误发 key', () => {
    const config = configWith({ providerModels: { a: ['shared-model'], b: ['shared-model'] } });
    expect(() => resolveModelProvider(config, 'shared-model')).toThrow(/multiple providers/);
  });
});


/**
 * B1：doubao / zhipu / kimi 从「认领模型名但无端点」升级为内置 provider。
 * 此前 detectProvider 已替用户认领这些模型名，resolveBaseUrl 却直接抛错 ——
 * 最差的半支持状态。端点 2026-09-15 经三家官方文档核实。
 */
describe('resolveBaseUrl — doubao / zhipu / kimi 内置端点（B1）', () => {
  const base = (): ShenlanConfig => JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ShenlanConfig;

  it('三家无需 providerBaseUrls 即可解析端点', () => {
    expect(resolveBaseUrl(base(), 'doubao-seed-2-1-pro')).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(resolveBaseUrl(base(), 'skylark-pro')).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(resolveBaseUrl(base(), 'glm-4')).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(resolveBaseUrl(base(), 'moonshot-v1-8k')).toBe('https://api.moonshot.cn');
  });

  it('providerBaseUrls 仍可覆盖（海外账号：Moonshot .ai / BytePlus）', () => {
    const config = base();
    config.providerBaseUrls = { kimi: 'https://api.moonshot.ai' };
    expect(resolveBaseUrl(config, 'moonshot-v1-8k')).toBe('https://api.moonshot.ai');
  });

  it('仍不认识的 provider 依旧显式报错（保护 #3 行为），错误列出的内置 provider 含新三家', () => {
    expect(() => resolveBaseUrl(base(), 'llama-3.1-70b')).toThrow(/provider "llama"/);
    expect(() => resolveBaseUrl(base(), 'llama-3.1-70b')).toThrow(/doubao/);
    expect(() => resolveBaseUrl(base(), 'llama-3.1-70b')).toThrow(/zhipu/);
    expect(() => resolveBaseUrl(base(), 'llama-3.1-70b')).toThrow(/kimi/);
  });

  it('provider key 走 <PROVIDER>_API_KEY（三家 key 解析不因内置端点而变）', () => {
    for (const [provider, model, env] of [
      ['doubao', 'doubao-seed-2-1-pro', 'DOUBAO_API_KEY'],
      ['zhipu', 'glm-4', 'ZHIPU_API_KEY'],
      ['kimi', 'moonshot-v1-8k', 'KIMI_API_KEY'],
    ] as const) {
      expect(detectProvider(model)).toBe(provider);
      process.env[env] = 'sk-test';
      try {
        expect(hasProviderKey(base(), provider)).toBe(true);
        expect(resolveApiKey(base(), provider)).toBe('sk-test');
      } finally {
        delete process.env[env];
      }
    }
  });

  it('显式 model.baseUrl 指向三家域名时按所属 provider 校验（不再被当未知网关一律尊重）', () => {
    const config = base();
    config.model.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
    // 与模型 provider 一致 → 尊重
    expect(resolveBaseUrl(config, 'glm-4')).toBe('https://open.bigmodel.cn/api/paas/v4');
    // 与模型 provider 不一致 → 忽略，回内置表（否则 qwen 模型会被打到智谱端点）
    expect(resolveBaseUrl(config, 'qwen-plus')).toBe('https://dashscope.aliyuncs.com/compatible-mode');
  });
});

/**
 * chatCompletionsUrl：OpenAI 兼容端点的版本段不都是 v1 —— 方舟 /api/v3、
 * 智谱 /api/paas/v4。此前 provider.ts 硬拼 `/v1/chat/completions`，
 * 这两家的端点根本无法表达（拼出 /api/v3/v1/chat/completions）。
 */
describe('chatCompletionsUrl — 版本段感知拼接', () => {
  it('base 无版本段 → 补 /v1/chat/completions（既有行为不变）', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode'))
      .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.moonshot.cn')).toBe('https://api.moonshot.cn/v1/chat/completions');
  });

  it('base 自带版本段 → 只补 /chat/completions', () => {
    expect(chatCompletionsUrl('https://ark.cn-beijing.volces.com/api/v3'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    expect(chatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4'))
      .toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    // 用户手写带 /v1 的 base 也不再双写（normalizeBaseUrl 只剥显式配置，内置表不过它）
    expect(chatCompletionsUrl('https://api.moonshot.cn/v1')).toBe('https://api.moonshot.cn/v1/chat/completions');
  });

  it('容忍末尾斜杠（避免 //chat/completions）', () => {
    expect(chatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4/'))
      .toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(chatCompletionsUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('与 normalizeBaseUrl 组合后每个内置端点都拼出唯一一个 /chat/completions', () => {
    for (const url of [
      'https://api.deepseek.com',
      'https://dashscope.aliyuncs.com/compatible-mode',
      'https://api.openai.com',
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://api.moonshot.cn',
    ]) {
      const full = chatCompletionsUrl(normalizeBaseUrl(url));
      expect(full.match(/\/chat\/completions/g)).toHaveLength(1);
      expect(full).not.toMatch(/\/v\d+\/v\d+\//);
    }
  });
});

describe('detectProviderFromUrl — 三家新域名（B1）', () => {
  it('识别方舟 / 智谱 / Moonshot 域名', () => {
    expect(detectProviderFromUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe('doubao');
    expect(detectProviderFromUrl('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu');
    expect(detectProviderFromUrl('https://api.moonshot.cn')).toBe('kimi');
    expect(detectProviderFromUrl('https://api.moonshot.ai')).toBe('kimi');
  });

  it('自建网关仍返回空串（一律尊重显式配置）', () => {
    expect(detectProviderFromUrl('https://oneapi.example.com/v1')).toBe('');
  });
});

describe('loadConfig — legacy balance settings', () => {
  it('migrates old balance precheck fields while dropping the retired guardrail block', () => {
    const root = mkdtempSync(join(tmpdir(), 'shenlan-legacy-balance-'));
    const cwd = join(root, 'project');
    const previousConfigDir = process.env.SHENLAN_CONFIG_DIR;
    try {
      process.env.SHENLAN_CONFIG_DIR = join(root, 'global');
      mkdirSync(join(cwd, '.shenlan'), { recursive: true });
      writeFileSync(join(cwd, '.shenlan', 'config.json'), JSON.stringify({
        costGuardrails: { enabled: false, maxCostPerSession: 0, balanceCheckBeforeStart: false, lowBalanceWarnThreshold: 2.5 },
      }), 'utf-8');

      const config = loadConfig(cwd);
      expect(config.balanceCheck).toEqual({ enabled: false, lowBalanceWarnThreshold: 2.5 });
      expect('costGuardrails' in config).toBe(false);
    } finally {
      if (previousConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
      else process.env.SHENLAN_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
