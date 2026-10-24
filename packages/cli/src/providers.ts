/**
 * 共享 provider 定义 — --setup 向导与 /keys 面板共用
 *
 * 厂商与默认端点由 core 的 PROVIDER_PRESETS 单一事实源派生；
 * 模型目录只为旧配置/默认选择提供增强，不再决定厂商是否可配置。
 */
import { PROVIDER_PRESETS, catalogModelsByProvider, envVarForProvider } from '@shenlan/core';

export interface ProviderDef {
  id: string;
  name: string;
  models: Array<{ id: string; label: string }>;
  testUrl: string;
  envVar: string;
  /** 自定义 OpenAI 兼容网关入口：向导走 baseUrl → key → 模型名三步，面板走三步录入 */
  custom?: boolean;
}

/** 目录模型 → 向导单选列表（目录序） */
const modelsFor = (provider: string) =>
  catalogModelsByProvider(provider).map((c) => ({ id: c.model, label: c.model }));

const providerDefFromPreset = (preset: (typeof PROVIDER_PRESETS)[number]): ProviderDef => ({
    id: preset.id,
    name: preset.name,
    models: modelsFor(preset.id),
    testUrl: preset.modelsUrl,
    envVar: envVarForProvider(preset.id),
});

// 保留既有 1/2/3/4 序号兼容脚本与肌肉记忆；新增厂商追加在 Custom 之后。
const primaryIds = new Set(['deepseek', 'qwen', 'openai']);
export const PROVIDERS: ProviderDef[] = [
  ...PROVIDER_PRESETS.filter((p) => primaryIds.has(p.id)).map(providerDefFromPreset),
  {
    id: 'custom',
    name: 'Custom OpenAI-compatible',
    models: [],
    testUrl: '',
    envVar: '',
    custom: true,
  },
  ...PROVIDER_PRESETS.filter((p) => !primaryIds.has(p.id)).map(providerDefFromPreset),
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * 动态发现的模型清单展示/可选上限（厂商接口可能返回数百项）：
 * 向导与 /keys 面板共用，超出的部分只提示「+N more」，可直接输入模型名选择。
 */
export const DISCOVERED_MODEL_LIST_LIMIT = 30;
