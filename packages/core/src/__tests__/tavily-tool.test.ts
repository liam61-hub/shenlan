/**
 * tavily_search 可配置工具 — 条件注册、key 统一解析、执行路径测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerAllTools,
  getTool,
  resolveApiKey,
  DEFAULT_CONFIG,
} from '../index.js';

const realEnv = {
  SHENLAN_CONFIG_DIR: process.env.SHENLAN_CONFIG_DIR,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
};

/** 带 tavily 开关的配置对象（默认关闭 + 可覆盖） */
function configWith(enabled: boolean): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, tavily: { enabled } };
}

describe('tavily_search 条件注册', () => {
  it('tavily.enabled 缺省/关闭时不注册', async () => {
    await registerAllTools(configWith(false));
    expect(getTool('tavily_search')).toBeUndefined();
  });

  it('tavily.enabled=true 时注册（默认关闭的孤儿模块接线）', async () => {
    await registerAllTools(configWith(true));
    const tool = getTool('tavily_search');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('tavily_search');
  });

  it('web_search 仍已注册（统一入口不受影响）', async () => {
    expect(getTool('web_search')).toBeDefined();
  });
});

describe('resolveApiKey — tavily 统一 key 解析', () => {
  const base = { ...DEFAULT_CONFIG };

  beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
  });

  it('环境变量 TAVILY_API_KEY 优先于 providerKeys.tavily', () => {
    process.env.TAVILY_API_KEY = 'env-key';
    const config = { ...base, providerKeys: { tavily: 'cfg-key' } };
    expect(resolveApiKey(config, 'tavily')).toBe('env-key');
  });

  it('无环境变量时读取 providerKeys.tavily', () => {
    const config = { ...base, providerKeys: { tavily: 'cfg-key' } };
    expect(resolveApiKey(config, 'tavily')).toBe('cfg-key');
  });

  it('model.apiKey 兜底不误用于 tavily（provider 错配保护）', () => {
    const config = { ...base, model: { ...base.model, apiKey: 'sk-model-key' } };
    expect(resolveApiKey(config, 'tavily')).toBe('');
  });
});

describe('tavily_search execute', () => {
  let tmp: string;
  let fetchMock: MockInstance;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-tavily-'));
    process.env.SHENLAN_CONFIG_DIR = tmp;
    delete process.env.TAVILY_API_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(realEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('开启但无 key：返回明确错误提示（两种配置途径）', async () => {
    await registerAllTools(configWith(true));
    const tool = getTool('tavily_search')!;
    const result = await tool.execute({ query: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('TAVILY_API_KEY');
    expect(result.content).toContain('providerKeys.tavily');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('providerKeys.tavily 配置 key 时正常搜索（写入 api_key）', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      ...DEFAULT_CONFIG,
      providerKeys: { tavily: 'tvly-cfg-key-1234' },
    }, null, 2), 'utf-8');
    await registerAllTools(configWith(true));
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: 'T1', url: 'https://t1.example', content: 'hello', score: 0.9 }] }),
    });
    const tool = getTool('tavily_search')!;
    const result = await tool.execute({ query: 'test' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('1. **T1**');
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.api_key).toBe('tvly-cfg-key-1234');
    expect(body.query).toBe('test');
  });

  it('环境变量 key 优先于配置 key', async () => {
    process.env.TAVILY_API_KEY = 'tvly-env-key';
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      ...DEFAULT_CONFIG,
      providerKeys: { tavily: 'tvly-cfg-key-1234' },
    }, null, 2), 'utf-8');
    await registerAllTools(configWith(true));
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    const tool = getTool('tavily_search')!;
    await tool.execute({ query: 'test' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.api_key).toBe('tvly-env-key');
  });

  it('API 非 2xx：返回错误不抛异常', async () => {
    process.env.TAVILY_API_KEY = 'tvly-env-key';
    await registerAllTools(configWith(true));
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const tool = getTool('tavily_search')!;
    const result = await tool.execute({ query: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('401');
  });
});
