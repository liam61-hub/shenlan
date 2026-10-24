import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShenlanConfig } from '../config.js';
import {
  parseDeepSeekPricing,
  qwenModelsUrl,
  syncPrices,
} from '../prices-sync.js';
import {
  getPrice,
  loadUserPrices,
  pricesFilePath,
  resetPrices,
} from '../pricing.js';

/** DeepSeek 官方定价页单表格结构（2026-08-25 抓取，含 rowspan；附带 NUL 字节模拟真实页面） */
const DEEPSEEK_FIXTURE = `\0<table>
<tr><td colspan="3" style="text-align:center">模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td><td>deepseek-v4-flash-vision-exp</td></tr>
<tr><td colspan="3">BASE URL (OpenAI 格式)</td><td colspan="3"><a href="https://api.deepseek.com" target="_blank">https://api.deepseek.com</a></td></tr>
<tr><td rowspan="6">价格<sup>(1)(2)</sup></td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.05元</td><td>0.15元</td><td>0.05元</td></tr>
<tr><td>高峰时段</td><td>0.10元</td><td>0.30元</td><td>0.10元</td></tr>
<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1.5元</td><td>4.5元</td><td>1.5元</td></tr>
<tr><td>高峰时段</td><td>3.0元</td><td>9.0元</td><td>3.0元</td></tr>
<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4.5元</td><td>13.5元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>9.0元</td><td>27.0元</td><td>9.0元</td></tr>
<tr><td colspan="3">并发限制<sup>(3)</sup></td><td>2500</td><td>500</td><td>2500</td></tr>
</table>`;

/** 百炼 GET /api/v1/models 响应（2026-08 官方文档结构） */
const QWEN_FIXTURE = {
  code: null,
  message: null,
  success: true,
  output: {
    total: 3,
    page_no: 1,
    page_size: 100,
    models: [
      {
        model: 'qwen-turbo',
        name: 'Qwen Turbo',
        prices: [{
          range_name: 'Default',
          prices: [
            { type: 'input_token', price: '0.9', price_unit: '每百万tokens', price_name: '输入' },
            { type: 'output_token', price: '1.8', price_unit: '每百万tokens', price_name: '输出' },
          ],
        }],
        model_info: { context_window: 1000000 },
      },
      {
        model: 'qwen-plus',
        name: 'Qwen Plus',
        prices: [{
          range_name: 'Default',
          prices: [
            { type: 'input_token', price: '0.8', price_unit: '每百万tokens', price_name: '输入' },
            { type: 'output_token', price: '2', price_unit: '每百万tokens', price_name: '输出' },
          ],
        }],
        model_info: { context_window: 131072 },
      },
      {
        model: 'qwen3-max',
        name: 'Qwen3 Max',
        prices: [{
          range_name: 'Default',
          prices: [
            { type: 'input_token', price: '2', price_unit: '每百万tokens', price_name: '输入' },
            { type: 'output_token', price: '8', price_unit: '每百万tokens', price_name: '输出' },
          ],
        }],
        model_info: { context_window: 131072 },
      },
    ],
  },
  request_id: 'test-request-id',
};

const baseConfig: ShenlanConfig = {
  model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
  providerKeys: { qwen: 'sk-test' },
};

let dir: string;
let savedQwenKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shenlan-sync-'));
  process.env.SHENLAN_CONFIG_DIR = dir;
  savedQwenKey = process.env.QWEN_API_KEY;
  delete process.env.QWEN_API_KEY;
  resetPrices();
});

afterEach(() => {
  delete process.env.SHENLAN_CONFIG_DIR;
  if (savedQwenKey === undefined) delete process.env.QWEN_API_KEY;
  else process.env.QWEN_API_KEY = savedQwenKey;
  resetPrices();
  vi.unstubAllGlobals();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseDeepSeekPricing — 官方定价页解析', () => {
  it('解析模型列 + 高峰/空闲 + 缓存命中（NUL 字节被清洗）', () => {
    const parsed = parseDeepSeekPricing(DEEPSEEK_FIXTURE);
    const flash = parsed['deepseek-v4-flash'];
    expect(flash.inputPrice).toBe(3.0);
    expect(flash.outputPrice).toBe(9.0);
    expect(flash.cacheReadPrice).toBe(0.10);
    expect(flash.offPeakInputPrice).toBe(1.5);
    expect(flash.offPeakOutputPrice).toBe(4.5);
    expect(flash.offPeakCacheReadPrice).toBe(0.05);

    const pro = parsed['deepseek-v4-pro'];
    expect(pro.inputPrice).toBe(9.0);
    expect(pro.outputPrice).toBe(27.0);
    expect(pro.cacheReadPrice).toBe(0.30);
    expect(pro.offPeakInputPrice).toBe(4.5);
    expect(pro.offPeakOutputPrice).toBe(13.5);
    expect(pro.offPeakCacheReadPrice).toBe(0.15);
  });

  it('结构损坏（无模型头行）→ 抛错', () => {
    expect(() => parseDeepSeekPricing('<html><body>no table</body></html>')).toThrow('model header row not found');
  });
});

describe('qwenModelsUrl — 官方端点推导', () => {
  it('未配置时用官方默认地址', () => {
    expect(qwenModelsUrl()).toBe('https://dashscope.aliyuncs.com/api/v1/models');
  });

  it('providerBaseUrls.qwen 归一化（compatible-mode / v1 后缀去除）', () => {
    const cfg = { ...baseConfig, providerBaseUrls: { qwen: 'https://dashscope.aliyuncs.com/compatible-mode' } };
    expect(qwenModelsUrl(cfg)).toBe('https://dashscope.aliyuncs.com/api/v1/models');
    const cfg2 = { ...baseConfig, providerBaseUrls: { qwen: 'https://dashscope.aliyuncs.com/v1' } };
    expect(qwenModelsUrl(cfg2)).toBe('https://dashscope.aliyuncs.com/api/v1/models');
  });
});

describe('syncPrices — DeepSeek', () => {
  it('官方新增模型（flash-vision-exp）→ added 写入 auto 分区（#9）', async () => {
    stubFetch(async () => new Response(DEEPSEEK_FIXTURE, { status: 200 }));
    const result = await syncPrices(['deepseek'], { config: baseConfig });
    expect(result.updated).toEqual([]);
    expect(result.added).toEqual(['deepseek-v4-flash-vision-exp']);
    expect(result.notFound).toEqual([]);
    expect(existsSync(pricesFilePath())).toBe(true);
    const back = JSON.parse(readFileSync(pricesFilePath(), 'utf-8'));
    const vision = back.auto['deepseek-v4-flash-vision-exp'];
    expect(vision.inputPrice).toBe(3.0);
    expect(vision.outputPrice).toBe(9.0);
    expect(vision.cacheReadPrice).toBe(0.10);
    expect(vision.source).toBe('deepseek official docs');
    // 生效价格立即可查（新模型不再永远无价）
    expect(getPrice('deepseek-v4-flash-vision-exp')!.inputPrice).toBe(3.0);
  });

  it('官方价变化 → 原子写入并读回验证（保留 manual 分区）', async () => {
    stubFetch(async () => new Response(DEEPSEEK_FIXTURE, { status: 200 }));
    writeFileSync(pricesFilePath(), JSON.stringify({
      manual: { 'deepseek-v4-pro': { inputPrice: 88 } },
      auto: {
        'deepseek-v4-flash': {
          inputPrice: 99, outputPrice: 99, cacheReadPrice: 9,
          effectiveDate: '2026-08', source: 'stale', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
    }), 'utf-8');

    const result = await syncPrices(['deepseek'], { config: baseConfig });
    expect(result.updated).toEqual(['deepseek-v4-flash']);
    expect(result.added).toEqual(['deepseek-v4-flash-vision-exp']);
    expect(result.skippedManual).toEqual(['deepseek-v4-pro']);
    expect(result.updatedSources?.['deepseek-v4-flash']).toBe('deepseek official docs');

    const back = JSON.parse(readFileSync(pricesFilePath(), 'utf-8'));
    // manual 分区原样保留
    expect(back.manual).toEqual({ 'deepseek-v4-pro': { inputPrice: 88 } });
    const flash = back.auto['deepseek-v4-flash'];
    expect(flash.inputPrice).toBe(3.0);
    expect(flash.outputPrice).toBe(9.0);
    expect(flash.cacheReadPrice).toBe(0.10);
    expect(flash.offPeakInputPrice).toBe(1.5);
    expect(flash.offPeakOutputPrice).toBe(4.5);
    expect(flash.offPeakCacheReadPrice).toBe(0.05);
    expect(flash.source).toBe('deepseek official docs');
    expect(flash.fetchedAt).toBeTruthy();
    // 新模型与已有模型同批落盘
    expect(back.auto['deepseek-v4-flash-vision-exp']).toBeTruthy();

    // 生效价格立即反映新数据
    expect(getPrice('deepseek-v4-flash')!.inputPrice).toBe(3.0);
    expect(getPrice('deepseek-v4-pro')!.inputPrice).toBe(88);
  });

  it('有 manual 条目的模型跳过；新模型仍新增写入（manual 分区保留）', async () => {
    stubFetch(async () => new Response(DEEPSEEK_FIXTURE, { status: 200 }));
    writeFileSync(pricesFilePath(), JSON.stringify({
      manual: { 'deepseek-v4-flash': { inputPrice: 5, outputPrice: 6, cacheReadPrice: 0.1 } },
    }), 'utf-8');

    const result = await syncPrices(['deepseek'], { config: baseConfig });
    expect(result.skippedManual).toEqual(['deepseek-v4-flash']);
    expect(result.updated).toEqual([]);
    expect(result.added).toEqual(['deepseek-v4-flash-vision-exp']);
    const back = JSON.parse(readFileSync(pricesFilePath(), 'utf-8'));
    expect(back.manual).toEqual({ 'deepseek-v4-flash': { inputPrice: 5, outputPrice: 6, cacheReadPrice: 0.1 } });
    expect(back.auto['deepseek-v4-flash-vision-exp']).toBeTruthy();
  });

  it('HTTP 失败 → 记录原因、保留现有价格', async () => {
    const original = JSON.stringify({
      auto: {
        'deepseek-v4-flash': {
          inputPrice: 99, outputPrice: 99, cacheReadPrice: 9,
          effectiveDate: '2026-08', source: 'stale', fetchedAt: '2026-08-01T00:00:00Z',
        },
      },
    });
    writeFileSync(pricesFilePath(), original, 'utf-8');
    stubFetch(async () => new Response('oops', { status: 500 }));

    const result = await syncPrices(['deepseek'], { config: baseConfig });
    expect(result.failed?.provider).toBe('deepseek');
    expect(result.failed?.reason).toContain('HTTP 500');
    expect(readFileSync(pricesFilePath(), 'utf-8')).toBe(original);
    expect(getPrice('deepseek-v4-flash')!.inputPrice).toBe(99);
  });
});

describe('syncPrices — qwen', () => {
  it('官方价格差异 → 写入；官方新模型 → added；目录模型官方未找到 → notFound 不猜测', async () => {
    stubFetch(async () => jsonResponse(QWEN_FIXTURE));
    const result = await syncPrices(['qwen'], { config: baseConfig });
    expect(result.updated).toEqual(['qwen-turbo']);
    // qwen3-max：官方返回但当前无记录 → 新增写入 auto
    expect(result.added).toEqual(['qwen3-max']);
    // 目录内官方未找到（官方只有 qwen3-max 无 qwen-max；vl-max 不在 fixture）
    expect(result.notFound).toEqual(expect.arrayContaining(['qwen-max', 'qwen-vl-max']));
    expect(result.notFound).not.toContain('qwen-plus');
    expect(result.notFound).not.toContain('qwen-turbo');
    expect(result.updatedSources?.['qwen-turbo']).toBe('qwen official API');

    const back = JSON.parse(readFileSync(pricesFilePath(), 'utf-8'));
    const turbo = back.auto['qwen-turbo'];
    expect(turbo.inputPrice).toBe(0.9);
    expect(turbo.outputPrice).toBe(1.8);
    expect(turbo.cacheReadPrice).toBe(0); // qwen API 无缓存价，保留原值
    expect(turbo.contextWindow).toBe(1000000);
    expect(turbo.source).toBe('qwen official API');
    // qwen-plus 与内置一致 → 不写入
    expect(back.auto['qwen-plus']).toBeUndefined();
    // 新模型 auto 条目带价可查
    const qwen3max = back.auto['qwen3-max'];
    expect(qwen3max.inputPrice).toBe(2);
    expect(qwen3max.outputPrice).toBe(8);
    expect(getPrice('qwen-turbo')!.contextWindow).toBe(1000000);
    expect(getPrice('qwen3-max')!.outputPrice).toBe(8);
  });

  it('qwen 未配置 key 时照常发起请求（无 Authorization 头）', async () => {
    let seenHeaders: Record<string, string> | undefined;
    stubFetch(async (_url, init) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return jsonResponse(QWEN_FIXTURE);
    });
    const cfg = { ...baseConfig, providerKeys: {} };
    const result = await syncPrices(['qwen'], { config: cfg });
    expect(result.failed).toBeUndefined();
    expect(seenHeaders?.Authorization).toBeUndefined();
  });

  it('API 返回错误体（InvalidApiKey）→ 失败不写文件', async () => {
    stubFetch(async () => jsonResponse({
      code: 'InvalidApiKey',
      message: 'No API-key provided.',
      request_id: 'x',
    }));
    const result = await syncPrices(['qwen'], { config: baseConfig });
    expect(result.failed?.provider).toBe('qwen');
    expect(result.failed?.reason).toContain('No API-key provided');
    expect(existsSync(pricesFilePath())).toBe(false);
  });

  it('无效 JSON → 失败不写文件', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }));
    const result = await syncPrices(['qwen'], { config: baseConfig });
    expect(result.failed?.provider).toBe('qwen');
    expect(result.failed?.reason).toContain('invalid JSON');
    expect(existsSync(pricesFilePath())).toBe(false);
  });
});

describe('syncPrices — 多 provider 独立', () => {
  it('qwen 失败不影响 deepseek 成功（新模型照常 added 写入）', async () => {
    stubFetch(async (url: string) => {
      if (url.includes('api/v1/models')) return new Response('not json', { status: 200 });
      return new Response(DEEPSEEK_FIXTURE, { status: 200 });
    });
    const result = await syncPrices(['qwen', 'deepseek'], { config: baseConfig });
    expect(result.failed?.provider).toBe('qwen');
    expect(result.updated).toEqual([]);
    expect(result.added).toEqual(['deepseek-v4-flash-vision-exp']);
    expect(loadUserPrices().warnings).toEqual([]);
    expect(existsSync(pricesFilePath())).toBe(true);
  });
});
