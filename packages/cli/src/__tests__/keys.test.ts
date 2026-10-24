import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShenlanConfig } from '@shenlan/core';
import { globalConfigPath, projectConfigPath } from '@shenlan/core';
import {
  buildKeyProviders,
  saveProviderKey,
  saveCustomProvider,
  saveProviderModels,
  deleteProviderKey,
  deleteProviderBaseUrl,
  testConnectivity,
  providerDef,
  resolveModelChoice,
  maskKey,
} from '../keys.js';
import { DISCOVERED_MODEL_LIST_LIMIT } from '../providers.js';

const baseConfig: ShenlanConfig = {
  model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
};

describe('keys 模块 — /keys 面板共享逻辑', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;
  // 本机/CI 环境可能预置 provider key 环境变量（如 DEEPSEEK_API_KEY），
  // 会干扰 envSet/configured 判定——用例内一律隔离（web-search.test.ts 同款做法）
  const realDeepseekKey = process.env.DEEPSEEK_API_KEY;
  const realOpenaiKey = process.env.OPENAI_API_KEY;
  const realGptKey = process.env.GPT_API_KEY;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-keys-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    mkdirSync(join(tmp, 'global'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GPT_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    if (realDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realDeepseekKey;
    if (realOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realOpenaiKey;
    if (realGptKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = realGptKey;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('maskKey 只保留尾 4 位', () => {
    expect(maskKey('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('****3456');
  });

  it('buildKeyProviders：providerKeys 显示掩码，env 覆盖标记 [env]', () => {
    process.env.QWEN_API_KEY = 'sk-env-qwen-9999';
    try {
      const entries = buildKeyProviders({
        ...baseConfig,
        providerKeys: { deepseek: 'sk-ds-12345678' },
      });
      const ds = entries.find((e) => e.id === 'deepseek')!;
      expect(ds.configured).toBe(true);
      expect(ds.masked).toBe('****5678');
      expect(ds.envSet).toBe(false);
      const qwen = entries.find((e) => e.id === 'qwen')!;
      expect(qwen.configured).toBe(false);
      expect(qwen.envSet).toBe(true);
      expect(qwen.masked).toBe('****9999');
    } finally {
      delete process.env.QWEN_API_KEY;
    }
  });

  it('saveProviderKey 全局作用域写入 0600，且保留既有 provider 条目', () => {
    saveProviderKey('deepseek', 'sk-ds-new-1', 'global');
    saveProviderKey('qwen', 'sk-qwen-1', 'global');

    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.providerKeys).toEqual({ deepseek: 'sk-ds-new-1', qwen: 'sk-qwen-1' });
    // Windows 无 POSIX 权限位（0600 尽力而为，AGENTS.md 平台约束）；仅 POSIX 平台断言
    if (process.platform !== 'win32') {
      expect(statSync(globalConfigPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('saveProviderKey 项目作用域写入 cwd/.shenlan/config.json', () => {
    saveProviderKey('qwen', 'sk-proj-1', 'project', cwd);
    const raw = JSON.parse(readFileSync(projectConfigPath(cwd), 'utf-8'));
    expect(raw.providerKeys).toEqual({ qwen: 'sk-proj-1' });
  });

  it('deleteProviderKey 只删除指定 provider，保留其他字段', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      providerKeys: { deepseek: 'sk-a', qwen: 'sk-b' },
      skills: ['/custom'],
    }), 'utf-8');

    deleteProviderKey('deepseek', 'global');
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.providerKeys).toEqual({ qwen: 'sk-b' });
    expect(raw.skills).toEqual(['/custom']);
  });

  it('buildKeyProviders：含 OpenAI 行与 Custom 行；OPENAI_API_KEY env → [env] 掩码', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-8888';
    try {
      const entries = buildKeyProviders(baseConfig);
      const openai = entries.find((e) => e.id === 'openai')!;
      expect(openai).toBeDefined();
      expect(openai.configured).toBe(false);
      expect(openai.envSet).toBe(true);
      expect(openai.masked).toBe('****8888');
      const custom = entries.find((e) => e.id === 'custom')!;
      expect(custom).toBeDefined();
      expect(custom.configured).toBe(false);
      // custom 入口行在尾部
      expect(entries[entries.length - 1]!.id).toBe('custom');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('buildKeyProviders：配置派生的自定义行（llama）展示 baseUrl detail 与派生标记', () => {
    const entries = buildKeyProviders({
      ...baseConfig,
      providerKeys: { llama: 'sk-llama-12345678' },
      providerBaseUrls: { llama: 'https://llama.example.com' },
    });
    const llama = entries.find((e) => e.id === 'llama')!;
    expect(llama).toBeDefined();
    expect(llama.derived).toBe(true);
    expect(llama.masked).toBe('****5678');
    expect(llama.baseUrl).toBe('https://llama.example.com');
    expect(llama.envVar).toBe('LLAMA_API_KEY');
  });

  it('saveCustomProvider：全局作用域写入派生 providerKeys + providerBaseUrls（归一化）+ model.model，保留既有条目', () => {
    saveProviderKey('deepseek', 'sk-ds-existing', 'global');

    const r = saveCustomProvider(
      { baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-gw-1', model: 'llama-3.1-70b' },
      'global',
    );
    expect(r.provider).toBe('llama');

    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.providerKeys).toEqual({ deepseek: 'sk-ds-existing', llama: 'sk-gw-1' });
    // /v1 后缀归一化剥离（客户端统一拼 /v1/chat/completions）
    expect(raw.providerBaseUrls).toEqual({ llama: 'https://gw.example.com' });
    expect(raw.model.model).toBe('llama-3.1-70b');
  });

  it('saveCustomProvider：gpt-5.4 派生 openai；baseUrl 留空不写 providerBaseUrls', () => {
    const r = saveCustomProvider(
      { baseUrl: '', apiKey: 'sk-openai-1', model: 'gpt-5.4' },
      'global',
    );
    expect(r.provider).toBe('openai');

    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.providerKeys).toEqual({ openai: 'sk-openai-1' });
    expect(raw.providerBaseUrls).toBeUndefined();
    expect(raw.model.model).toBe('gpt-5.4');
  });

  it('saveProviderModels：按显式厂商保存、去重排序并保留既有配置', () => {
    saveProviderKey('deepseek', 'sk-ds', 'global');
    const r = saveProviderModels('my-gw', ['z-model', 'a-model', 'z-model', '  '], 'global');
    expect(r.count).toBe(2);
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.providerModels).toEqual({ 'my-gw': ['a-model', 'z-model'] });
    expect(raw.providerKeys.deepseek).toBe('sk-ds');
  });

  it('testConnectivity：解析 OpenAI 兼容 data[].id 模型清单并过滤异常项', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }, { id: 123 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const result = await testConnectivity(providerDef('deepseek')!, 'sk-test');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['model-b', 'model-a']);
  });

  it('deleteProviderBaseUrl 只删除指定 provider 的 baseUrl，保留其他字段', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({
      providerKeys: { llama: 'sk-gw-1' },
      providerBaseUrls: { llama: 'https://gw.example.com', qwen: 'https://qwen.example.com' },
      skills: ['/custom'],
    }), 'utf-8');

    deleteProviderBaseUrl('llama', 'global');
    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'));
    expect(raw.providerBaseUrls).toEqual({ qwen: 'https://qwen.example.com' });
    expect(raw.providerKeys).toEqual({ llama: 'sk-gw-1' });
    expect(raw.skills).toEqual(['/custom']);
  });

  describe('resolveModelChoice — 第 3 步序号/模型名解析', () => {
    it('有发现清单时纯数字按序号（1-based）命中', () => {
      expect(resolveModelChoice('2', ['a-model', 'b-model'])).toEqual({ model: 'b-model' });
      expect(resolveModelChoice('  1  ', ['a-model', 'b-model'])).toEqual({ model: 'a-model' });
    });

    it('序号越界报错（提示可改填模型名）', () => {
      expect(resolveModelChoice('3', ['a-model', 'b-model'])).toEqual({
        error: '序号超出范围（1-2），或直接输入模型名',
      });
      expect(resolveModelChoice('0', ['a-model'])).toEqual({
        error: '序号超出范围（1-1），或直接输入模型名',
      });
    });

    it('非数字输入一律当模型名（含清单外模型）', () => {
      expect(resolveModelChoice('llama-3.1-70b', ['a-model'])).toEqual({ model: 'llama-3.1-70b' });
      expect(resolveModelChoice('gpt-5.4', [])).toEqual({ model: 'gpt-5.4' });
    });

    it('无发现清单时纯数字当模型名（无序号可索引）', () => {
      expect(resolveModelChoice('123', [])).toEqual({ model: '123' });
    });

    it('空输入报错', () => {
      expect(resolveModelChoice('   ', ['a-model'])).toEqual({ error: '模型名不能为空' });
    });

    it('超过 DISCOVERED_MODEL_LIST_LIMIT 的项不可按序号选中（须填模型名）', () => {
      const many = Array.from({ length: DISCOVERED_MODEL_LIST_LIMIT + 1 }, (_, i) => `m-${i + 1}`);
      expect(resolveModelChoice(String(DISCOVERED_MODEL_LIST_LIMIT), many)).toEqual({
        model: `m-${DISCOVERED_MODEL_LIST_LIMIT}`,
      });
      expect(resolveModelChoice(String(DISCOVERED_MODEL_LIST_LIMIT + 1), many)).toEqual({
        error: `序号超出范围（1-${DISCOVERED_MODEL_LIST_LIMIT}），或直接输入模型名`,
      });
    });
  });
});
