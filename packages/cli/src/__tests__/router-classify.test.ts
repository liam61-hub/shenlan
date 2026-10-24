/**
 * LLM 任务分类路由 — flash 一次性分类替代关键词启发式（失败回退启发式）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShenlanConfig } from '@shenlan/core';

// 仅 mock chat（分类调用），其余 core 保持真实实现
vi.mock('@shenlan/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shenlan/core')>();
  return { ...actual, chat: vi.fn() };
});

import { chat, DEFAULT_CONFIG } from '@shenlan/core';
import {
  routeModelAsync,
  routeModelSticky,
  resetSessionSticky,
  enableAuto,
  consumeRouteDegradedNotice,
} from '../router.js';

function configWith(providerKeys: Record<string, string>): ShenlanConfig {
  return { ...DEFAULT_CONFIG, providerKeys };
}

describe('routeModelAsync — LLM 一次性任务分类', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableAuto();
    resetSessionSticky();
    setPolicyForTest();
  });

  function setPolicyForTest() {
    // routeModelAsync 走 cost-first（enableAuto 默认），无需额外设置
  }

  it('分类为 coding：按 tier 最高选模型（deepseek key 下选 pro）', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'coding' } }],
    });
    const model = await routeModelAsync('随便什么输入', configWith({ deepseek: 'sk-ds' }));
    expect(model).toBe('deepseek-v4-pro');
  });

  it('分类为 general：按 cost 最低选模型', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'general' } }],
    });
    const model = await routeModelAsync('你好', configWith({ deepseek: 'sk-ds' }));
    expect(model).toBe('deepseek-v4-flash');
  });

  it('分类调用失败：回退关键词启发式', async () => {
    vi.mocked(chat).mockRejectedValue(new Error('network down'));
    const model = await routeModelAsync('帮我修复一个 bug', configWith({ deepseek: 'sk-ds' }));
    expect(model).toBe('deepseek-v4-pro'); // 启发式 coding → tier 最高
  });

  it('分类输出非枚举值：回退启发式', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '闲聊模式' } }],
    });
    const model = await routeModelAsync('帮我实现一个排序函数', configWith({ deepseek: 'sk-ds' }));
    expect(model).toBe('deepseek-v4-pro');
  });

  it('无可用 key（config 未传）：不发起分类网络调用，走既有回退', async () => {
    const model = await routeModelAsync('今天天气怎么样', undefined);
    expect(model).toBe('deepseek-v4-flash');
    expect(vi.mocked(chat)).not.toHaveBeenCalled();
  });

  it('分类请求用 flash 模型与小 maxTokens，提示词含四个任务类型', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'general' } }],
    });
    await routeModelAsync('你好', configWith({ deepseek: 'sk-ds' }));
    const [cfg, messages] = vi.mocked(chat).mock.calls[0]!;
    expect(cfg.model).toBe('deepseek-v4-flash');
    expect(cfg.maxTokens).toBeLessThanOrEqual(32);
    const joined = JSON.stringify(messages);
    expect(joined).toContain('coding');
    expect(joined).toContain('deep_reasoning');
  });

  it('routeModelSticky 会话粘性走分类路径（async）', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'coding' } }],
    });
    const first = await routeModelSticky('任务一', configWith({ deepseek: 'sk-ds' }));
    const second = await routeModelSticky('任务二', configWith({ deepseek: 'sk-ds' }));
    expect(first).toBe('deepseek-v4-pro');
    expect(second).toBe(first);
    expect(vi.mocked(chat)).toHaveBeenCalledTimes(1); // 粘性：只分类一次
  });
});

describe('routeModelAsync — 输入模态检测（@图片 → 视觉模型）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableAuto();
    resetSessionSticky();
    consumeRouteDegradedNotice(); // 清残留
  });

  it('图片输入（@x.png）路由到视觉模型（qwen key 下选 qwen-vl-max）', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'general' } }],
    });
    const model = await routeModelAsync('看看这张图 @design.png', configWith({ qwen: 'sk-qwen' }));
    expect(model).toBe('qwen-vl-max');
    expect(consumeRouteDegradedNotice()).toBeNull();
  });

  it('图片输入但无视觉模型可用：降级文本模型路由 + degraded notice 只消费一次', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'general' } }],
    });
    const model = await routeModelAsync('看看 @p.png', configWith({ deepseek: 'sk-ds' }));
    expect(model).toBe('deepseek-v4-flash'); // 降级：文本模型 general → cost 最低
    const notice = consumeRouteDegradedNotice();
    expect(notice).toContain('视觉模型');
    expect(consumeRouteDegradedNotice()).toBeNull();
  });

  it('无图片输入不产生 degraded notice', async () => {
    vi.mocked(chat).mockResolvedValue({
      id: 'x', model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'general' } }],
    });
    await routeModelAsync('你好', configWith({ deepseek: 'sk-ds' }));
    expect(consumeRouteDegradedNotice()).toBeNull();
  });
});
