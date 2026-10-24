import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShenlanConfig } from '@shenlan/core';
import { resetPrices, getActiveModel } from '@shenlan/core';
import {
  routeModel,
  routeModelAsync,
  routeModelSticky,
  findFailoverTarget,
  resetSessionSticky,
  enableAuto,
  setPolicy,
  getModelContextWindow,
  lockModel,
  initRoutingFromConfig,
  getEffectiveModel,
  consumeRouteDegradedNotice,
} from '../router.js';

/** 路由测试需要干净的环境变量（防止宿主 shell 的 key 影响可用集判断） */
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

const baseConfig: ShenlanConfig = {
  model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
};

let tmpDir: string;
beforeEach(() => {
  // 重置到基准状态（含 configuredDefaultModel，防止跨用例污染）
  initRoutingFromConfig(baseConfig);
  resetSessionSticky();
  resetPrices();
  // 价格文件重定向到临时目录：内置价与路由测试隔离，避免真实 prices.json 干扰
  tmpDir = mkdtempSync(join(tmpdir(), 'shenlan-router-'));
  process.env.SHENLAN_CONFIG_DIR = tmpDir;
});
afterEach(() => {
  delete process.env.SHENLAN_CONFIG_DIR;
  resetPrices();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
const qwenOnlyConfig: ShenlanConfig = {
  ...baseConfig,
  providerKeys: { qwen: 'sk-qwen' },
};
const dualKeyConfig: ShenlanConfig = {
  ...baseConfig,
  providerKeys: { deepseek: 'sk-ds', qwen: 'sk-qwen' },
};

describe('routeModel — 中文项目类任务路由', () => {
  it('“权益卡逻辑介绍一下” → deepseek-v4-pro', () => {
    expect(routeModel('权益卡逻辑介绍一下')).toBe('deepseek-v4-pro');
  });

  it('“帮我分析一下这个项目的架构” → deepseek-v4-pro', () => {
    expect(routeModel('帮我分析一下这个项目的架构')).toBe('deepseek-v4-pro');
  });

  it('“介绍一下权益卡的设计方案” → deepseek-v4-pro', () => {
    expect(routeModel('介绍一下权益卡的设计方案')).toBe('deepseek-v4-pro');
  });

  it('普通闲聊 → deepseek-v4-flash', () => {
    expect(routeModel('今天天气怎么样')).toBe('deepseek-v4-flash');
    expect(routeModel('你好')).toBe('deepseek-v4-flash');
  });

  it('英文编码任务 → deepseek-v4-pro', () => {
    expect(routeModel('fix the bug in src/app.ts')).toBe('deepseek-v4-pro');
  });

  it('quality-first 策略 → 一律 pro', () => {
    setPolicy('quality-first');
    expect(routeModel('今天天气怎么样')).toBe('deepseek-v4-pro');
  });
});

describe('routeModel — 跨 provider 自动路由', () => {
  it('qwen-only：普通任务 → qwen-turbo（最便宜）', () => {
    expect(routeModel('今天天气怎么样', qwenOnlyConfig)).toBe('qwen-turbo');
    expect(routeModel('你好', qwenOnlyConfig)).toBe('qwen-turbo');
  });

  // A2 起：无内置价模型改按同档最高价估算（与有价模型同量纲），不再因 relativeCost(1–4)
  // 与价格和(12+) 量纲不同而被系统性优选。qwen tier4 组现在 qwen-max / qwen3.7-max /
  // qwen3.8-max / qwen3.8-2.4t-a95b 折算成本全为 12.0（估算来自 qwen-max），
  // 平局落目录序 → qwen-max；qwen-vl-max 虽更便宜但被"同档优先文本模型"规则降级。
  it('qwen-only：编码任务 → qwen-max（tier 最高、同档平局取目录序）', () => {
    expect(routeModel('帮我实现一个排序函数', qwenOnlyConfig)).toBe('qwen-max');
    expect(routeModel('fix the bug in src/app.ts', qwenOnlyConfig)).toBe('qwen-max');
  });

  it('qwen-only：长上下文/推理 → qwen-max', () => {
    expect(routeModel('帮我推导一下这个算法的复杂度', qwenOnlyConfig)).toBe('qwen-max');
  });

  it('无内置价模型不再因量纲错误被优选：qwen3.7-max 与 qwen-max 同价时不抢先', () => {
    // 修复前 qwen3.7-max 的 effectiveCost 是原始 relativeCost=4，稳赢 qwen-max 的 12.0
    expect(routeModel('帮我实现一个排序函数', qwenOnlyConfig)).not.toBe('qwen3.7-max');
    // 反向验证：把 qwen-max 官方价调高后，估算基准随之抬高，二者仍同价 → 仍取目录序
    writeFileSync(join(tmpDir, 'prices.json'), JSON.stringify({
      manual: { 'qwen-max': { inputPrice: 50, outputPrice: 50 } },
    }), 'utf-8');
    resetPrices();
    // qwen-max 100 vs 同档估算基准 max(qwen-max 100, qwen-vl-max 1.6/4.0) → 无价模型也 100
    expect(['qwen-max', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.8-2.4t-a95b'])
      .toContain(routeModel('帮我实现一个排序函数', qwenOnlyConfig));
  });

  it('视觉模型不因占位低价抢走纯文本编码任务（同档优先文本模型）', () => {
    // qwen-vl-max 折算 5.6 < qwen-max 12.0，但纯文本任务不应路由给视觉模型
    expect(routeModel('帮我实现一个排序函数', qwenOnlyConfig)).not.toBe('qwen-vl-max');
  });

  it('双 key：普通任务按生效价格选最便宜 → qwen-turbo（0.90 < flash 12.0）', () => {
    expect(routeModel('今天天气怎么样', dualKeyConfig)).toBe('qwen-turbo');
  });

  it('用户手动调价立即影响路由：qwen 全系调高 → 双 key 普通任务回退 flash', () => {
    writeFileSync(join(tmpDir, 'prices.json'), JSON.stringify({
      manual: {
        'qwen-turbo': { inputPrice: 100, outputPrice: 100 },
        'qwen-plus': { inputPrice: 100, outputPrice: 100 },
        'qwen-max': { inputPrice: 100, outputPrice: 100 },
        'qwen3.7-flash': { inputPrice: 100, outputPrice: 100 },
        'qwen3.7-plus': { inputPrice: 100, outputPrice: 100 },
        'qwen3.7-max': { inputPrice: 100, outputPrice: 100 },
        'qwen3.8-max': { inputPrice: 100, outputPrice: 100 },
        'qwen3.8-2.4t-a95b': { inputPrice: 100, outputPrice: 100 },
        'qwen-vl-max': { inputPrice: 100, outputPrice: 100 },
      },
    }), 'utf-8');
    resetPrices();
    expect(routeModel('今天天气怎么样', dualKeyConfig)).toBe('deepseek-v4-flash');
  });

  it('双 key：编码任务选 tier 最高 → qwen-max', () => {
    expect(routeModel('帮我重构这个模块', dualKeyConfig)).toBe('qwen-max');
  });

  it('deepseek-only：保持既有行为（flash / pro）', () => {
    const dsOnly = { ...baseConfig, providerKeys: { deepseek: 'sk-ds' } };
    expect(routeModel('今天天气怎么样', dsOnly)).toBe('deepseek-v4-flash');
    expect(routeModel('帮我实现一个排序函数', dsOnly)).toBe('deepseek-v4-pro');
  });

  it('quality-first：双 key 下选 tier 最高 → qwen-max', () => {
    setPolicy('quality-first');
    expect(routeModel('今天天气怎么样', dualKeyConfig)).toBe('qwen-max');
    expect(routeModel('今天天气怎么样', qwenOnlyConfig)).toBe('qwen-max');
  });

  it('manual 锁定：无视可用集，返回锁定模型', () => {
    lockModel('deepseek-v4-flash');
    expect(routeModel('帮我实现一个排序函数', qwenOnlyConfig)).toBe('deepseek-v4-flash');
  });

  it('manual 锁定 qwen3.8-max 返回锁定值', () => {
    lockModel('qwen3.8-max');
    expect(routeModel('帮我实现一个排序函数', qwenOnlyConfig)).toBe('qwen3.8-max');
  });
});

describe('routeModel — 仅配置 model.apiKey（无 providerKeys）时尊重配置的默认模型', () => {
  it('qwen 默认模型 + model.apiKey：普通/编码/推理任务都用配置模型，不再回退 deepseek', () => {
    const cfg = {
      ...baseConfig,
      model: { ...baseConfig.model, apiKey: 'sk-qwen', model: 'qwen3.8-max' },
    };
    expect(routeModel('今天天气怎么样', cfg)).toBe('qwen3.8-max');
    expect(routeModel('帮我实现一个排序函数', cfg)).toBe('qwen3.8-max');
    expect(routeModel('帮我推导一下这个算法的复杂度', cfg)).toBe('qwen3.8-max');
  });

  it('deepseek 默认模型 + model.apiKey：同样尊重配置模型，不自动升 pro', () => {
    const cfg = {
      ...baseConfig,
      model: { ...baseConfig.model, apiKey: 'sk-ds', model: 'deepseek-v4-pro' },
    };
    expect(routeModel('今天天气怎么样', cfg)).toBe('deepseek-v4-pro');
    expect(routeModel('帮我实现一个排序函数', cfg)).toBe('deepseek-v4-pro');
  });

  it('model.apiKey 为空时保持既有 deepseek 回退（无 key 场景不引入行为变化）', () => {
    const cfg = { ...baseConfig, model: { ...baseConfig.model, model: 'qwen3.8-max' } };
    expect(routeModel('今天天气怎么样', cfg)).toBe('deepseek-v4-flash');
    expect(routeModel('帮我实现一个排序函数', cfg)).toBe('deepseek-v4-pro');
  });

  it('quality-first + model.apiKey：使用配置模型', () => {
    setPolicy('quality-first');
    const cfg = {
      ...baseConfig,
      model: { ...baseConfig.model, apiKey: 'sk-qwen', model: 'qwen3.8-max' },
    };
    expect(routeModel('今天天气怎么样', cfg)).toBe('qwen3.8-max');
  });
});

describe('routeModel — openai 纳入目录后的自动路由', () => {
  it('仅 openai key：普通任务 → gpt-5.4-mini（最便宜），编码任务 → gpt-5.4（tier 最高）', () => {
    const cfg = { ...baseConfig, providerKeys: { openai: 'sk-openai' } };
    expect(routeModel('今天天气怎么样', cfg)).toBe('gpt-5.4-mini');
    expect(routeModel('帮我实现一个排序函数', cfg)).toBe('gpt-5.4');
  });

  it('OPENAI_API_KEY 环境变量 → 自动路由生效', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    try {
      expect(routeModel('今天天气怎么样', baseConfig)).toBe('gpt-5.4-mini');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('目录内模型但无可用 key → 保持 deepseek 回退', () => {
    const cfg = { ...baseConfig, model: { ...baseConfig.model, model: 'gpt-5.4' } };
    expect(routeModel('今天天气怎么样', cfg)).toBe('deepseek-v4-flash');
    expect(routeModel('帮我实现一个排序函数', cfg)).toBe('deepseek-v4-pro');
  });

  it('双 key（qwen + openai）：普通任务跨厂择优 → qwen-turbo（0.90 最便宜）', () => {
    const cfg = {
      ...baseConfig,
      providerKeys: { qwen: 'sk-qwen', openai: 'sk-openai' },
    };
    expect(routeModel('今天天气怎么样', cfg)).toBe('qwen-turbo');
    expect(routeModel('帮我实现一个排序函数', cfg)).toBe('qwen-max');
  });

  it('routeModelAsync 图片输入 → 视觉模型 gpt-5.4（modalities 含 image）', async () => {
    const cfg = { ...baseConfig, providerKeys: { openai: 'sk-openai' } };
    expect(await routeModelAsync('看下这张图 @./test.png', cfg)).toBe('gpt-5.4');
  });
});

describe('configuredDefaultModel — auto 基线跟随配置模型（/model auto 不回落硬编码 deepseek）', () => {
  it('initRoutingFromConfig 后 enableAuto/setPolicy 基线保持配置模型', () => {
    const cfg = { ...baseConfig, model: { ...baseConfig.model, model: 'qwen3.8-max' } };
    initRoutingFromConfig(cfg);
    expect(getEffectiveModel()).toBe('qwen3.8-max');
    enableAuto();
    expect(getEffectiveModel()).toBe('qwen3.8-max');
    setPolicy('quality-first');
    expect(getEffectiveModel()).toBe('qwen3.8-max');
    // 手动锁定仍优先，且不污染基线
    lockModel('deepseek-v4-pro');
    expect(getEffectiveModel()).toBe('deepseek-v4-pro');
  });
});

describe('routeModelSticky — 会话级模型粘性', () => {
  it('会话内沿用首个路由结果（pro 后追问不再切 flash）', async () => {
    expect(await routeModelSticky('权益卡逻辑介绍一下')).toBe('deepseek-v4-pro');
    expect(await routeModelSticky('那你看看这里怎么改')).toBe('deepseek-v4-pro');
  });

  it('重置粘性后重新路由', async () => {
    await routeModelSticky('权益卡逻辑介绍一下');
    resetSessionSticky();
    expect(await routeModelSticky('今天天气怎么样')).toBe('deepseek-v4-flash');
  });
});

describe('routeModelSticky — 中途发图单向升级视觉模型', () => {
  it('sticky 为文本模型 + 图片输入 + 仅 qwen key → 升级 qwen-vl-max 并同步活动模型', async () => {
    // 首轮无 key → sticky = deepseek-v4-pro（编码任务，文本模型）
    expect(await routeModelSticky('帮我实现一个排序函数')).toBe('deepseek-v4-pro');
    // 中途发图 → 升级视觉模型
    const upgraded = await routeModelSticky('看下这张图 @./test.png', qwenOnlyConfig);
    expect(upgraded).toBe('qwen-vl-max');
    expect(getActiveModel()).toBe('qwen-vl-max');
    expect(consumeRouteDegradedNotice()).toContain('已切换至视觉模型');
  });

  it('sticky 已是视觉模型 → 后续文本轮不回退', async () => {
    expect(await routeModelSticky('看下这张图 @./test.png', qwenOnlyConfig)).toBe('qwen-vl-max');
    expect(await routeModelSticky('继续帮我写代码')).toBe('qwen-vl-max');
    expect(await routeModelSticky('总结一下')).toBe('qwen-vl-max');
  });

  it('manual 锁定文本模型 → 图片输入不升级', async () => {
    lockModel('deepseek-v4-flash');
    expect(await routeModelSticky('帮我实现一个排序函数', qwenOnlyConfig)).toBe('deepseek-v4-flash');
    expect(await routeModelSticky('看下这张图 @./test.png', qwenOnlyConfig)).toBe('deepseek-v4-flash');
  });

  it('无视觉模型可用（仅 deepseek key）→ 保持 sticky 且产生降级提示', async () => {
    expect(await routeModelSticky('帮我实现一个排序函数')).toBe('deepseek-v4-pro');
    const deepseekOnly = { ...baseConfig, providerKeys: { deepseek: 'sk-ds' } };
    expect(await routeModelSticky('看下这张图 @./test.png', deepseekOnly)).toBe('deepseek-v4-pro');
    expect(consumeRouteDegradedNotice()).toContain('无可用视觉模型');
  });

  it('首次调用即图片输入 → 直接路由视觉模型（不先定文本）', async () => {
    expect(await routeModelSticky('看下这张图 @./test.png', qwenOnlyConfig)).toBe('qwen-vl-max');
    expect(getActiveModel()).toBe('qwen-vl-max');
  });
});

describe('setActiveModel — web_search 路由与生效模型同步', () => {
  it('initRoutingFromConfig manual 锁定 → 活动模型 = 锁定模型', () => {
    const cfg: ShenlanConfig = {
      ...baseConfig,
      model: { ...baseConfig.model, model: 'qwen3.8-max' },
      routing: { policy: 'manual', lockedModel: 'deepseek-v4-flash' },
    };
    initRoutingFromConfig(cfg);
    expect(getEffectiveModel()).toBe('deepseek-v4-flash');
    expect(getActiveModel()).toBe('deepseek-v4-flash');
  });

  it('initRoutingFromConfig 未锁定 → 活动模型 = 配置默认模型', () => {
    const cfg: ShenlanConfig = {
      ...baseConfig,
      model: { ...baseConfig.model, model: 'qwen3.8-max' },
    };
    initRoutingFromConfig(cfg);
    expect(getEffectiveModel()).toBe('qwen3.8-max');
    expect(getActiveModel()).toBe('qwen3.8-max');
  });

  it('lockModel → 活动模型跟随锁定模型', () => {
    lockModel('qwen3.8-max');
    expect(getEffectiveModel()).toBe('qwen3.8-max');
    expect(getActiveModel()).toBe('qwen3.8-max');
  });

  it('routeModelSticky → 活动模型 = 会话粘性模型', async () => {
    await routeModelSticky('权益卡逻辑介绍一下');
    expect(getEffectiveModel()).toBe('deepseek-v4-pro');
    expect(getActiveModel()).toBe('deepseek-v4-pro');
  });

  it('resetSessionSticky → 活动模型回到基准模型', () => {
    routeModelSticky('权益卡逻辑介绍一下');
    resetSessionSticky();
    expect(getActiveModel()).toBe('deepseek-v4-flash');
  });

  it('enableAuto → 活动模型 = 配置基线（qwen 配置不回落 deepseek）', () => {
    const cfg: ShenlanConfig = {
      ...baseConfig,
      model: { ...baseConfig.model, model: 'qwen3.8-max' },
    };
    initRoutingFromConfig(cfg);
    enableAuto();
    expect(getActiveModel()).toBe('qwen3.8-max');
  });

  it('setPolicy quality-first → 活动模型 = 配置基线', () => {
    const cfg: ShenlanConfig = {
      ...baseConfig,
      model: { ...baseConfig.model, model: 'qwen3.8-max' },
    };
    initRoutingFromConfig(cfg);
    setPolicy('quality-first');
    expect(getActiveModel()).toBe('qwen3.8-max');
  });
});

describe('getModelContextWindow', () => {
  it('返回目录中的上下文窗口', () => {
    expect(getModelContextWindow('deepseek-v4-pro')).toBe(1_000_000);
    expect(getModelContextWindow('deepseek-v4-flash')).toBe(1_000_000);
    expect(getModelContextWindow('qwen-turbo')).toBe(1_000_000);
    expect(getModelContextWindow('qwen-plus')).toBe(128_000);
    expect(getModelContextWindow('qwen-max')).toBe(128_000);
    expect(getModelContextWindow('qwen3.7-plus')).toBe(128_000);
    expect(getModelContextWindow('qwen3.8-max')).toBe(128_000);
  });

  it('未知模型按 100 万兜底', () => {
    expect(getModelContextWindow('unknown-model')).toBe(1_000_000);
  });
});

describe('findFailoverTarget — provider 故障转移备用模型', () => {
  // 注：同 tier 组内的最终选择按生效价格择优（成本感知路由是本特性），
  // 平局才落目录序——断言绑定「provider 切换 + tier 不降级」语义，
  // 不绑定价格敏感的平局裁决（宿主 prices.json 与并行 worker 环境可变）
  it('deepseek-v4-flash 失败 → qwen 系 tier1 组内模型（跨 provider 同档）', () => {
    const cfg = { ...baseConfig, providerKeys: { deepseek: 'sk-ds', qwen: 'sk-qwen' } };
    expect(['qwen-turbo', 'qwen3.7-flash']).toContain(findFailoverTarget('deepseek-v4-flash', cfg));
  });

  it('deepseek-v4-pro 失败 → qwen 系最高 tier（t4 组内模型，能力不降级）', () => {
    // 规则：同 tier 优先（无 t3 qwen）→ 最高 tier（t4 组）
    const cfg = { ...baseConfig, providerKeys: { deepseek: 'sk-ds', qwen: 'sk-qwen' } };
    expect(['qwen-max', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.8-2.4t-a95b'])
      .toContain(findFailoverTarget('deepseek-v4-pro', cfg));
  });

  it('备用 provider 无 key：返回 null（不切换）', () => {
    const cfg = { ...baseConfig, providerKeys: { deepseek: 'sk-ds' } };
    expect(findFailoverTarget('deepseek-v4-flash', cfg)).toBeNull();
  });

  it('qwen 失败 → deepseek 同档（turbo→flash、max→pro）', () => {
    const cfg = { ...baseConfig, providerKeys: { deepseek: 'sk-ds', qwen: 'sk-qwen' } };
    expect(findFailoverTarget('qwen-turbo', cfg)).toBe('deepseek-v4-flash');
    expect(findFailoverTarget('qwen3.8-max', cfg)).toBe('deepseek-v4-pro');
  });

  it('未知模型：返回 null', () => {
    const cfg = { ...baseConfig, providerKeys: { deepseek: 'sk-ds', qwen: 'sk-qwen' } };
    expect(findFailoverTarget('custom-model', cfg)).toBeNull();
  });
});
