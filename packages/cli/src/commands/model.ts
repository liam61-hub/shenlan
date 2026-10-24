/**
 * /model 命令 — 切换或查看当前模型
 */
import chalk from 'chalk';
import type { RoutingConfig, ShenlanConfig } from '@shenlan/core';
import { updateConfig, debugLog, hasProviderKey, getPrice, resolveModelProvider } from '@shenlan/core';
import type { ModelOption } from '../context.js';
import {
  enableAuto, setPolicy, getPolicy, getLockedModel, getEffectiveModel,
  routingInfo, resetSessionSticky, lockModel, getCatalog, getModelContextWindow,
} from '../router.js';

/** 默认模型（自动路由时的基准模型，未手动锁定时生效） */
export const DEFAULT_MODEL = 'deepseek-v4-flash';

let currentModel: string = DEFAULT_MODEL;

export function setModel(model: string): void {
  currentModel = model;
}

export function getModel(): string {
  return currentModel;
}

/**
 * /model 面板分组标题：按「来源端点」分组（用户确认口径）——
 * 官方 deepseek API（api.deepseek.com，独立 key）一组；百炼 DashScope
 * （dashscope 端点 + 百炼 key）一组，qwen 全系与百炼托管的 deepseek 快照同组。
 */
const PROVIDER_GROUP_LABELS: Record<string, string> = {
  auto: '自动路由',
  deepseek: 'DeepSeek（官方 API）',
  bailian: '百炼 DashScope',
  qwen: '百炼 DashScope',
  openai: 'OpenAI（官方 API）',
};

function groupFor(provider: string): string {
  return PROVIDER_GROUP_LABELS[provider] ?? (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : '其他');
}

/** 定位标签：从目录能力字段推导（不做营销文案） */
function modelTag(thinking: boolean, tier: number): string {
  if (tier >= 4) return thinking ? '推理最强' : '最强';
  if (tier === 3) return '推理';
  if (tier === 2) return '均衡';
  return '快速';
}

/** 价格段：'¥x/¥y per Mtok'，查不到价格数据时返回 ''（面板省略该段） */
function priceTextFor(model: string): string {
  const p = getPrice(model);
  if (!p) return '';
  const fmt = (n: number) => `¥${Number(n.toFixed(2))}`;
  return `${fmt(p.inputPrice)}/${fmt(p.outputPrice)} per Mtok`;
}

/**
 * 构建 /model 面板选项（对齐 Codex CLI 样式）：
 * 置顶 Default（自动路由）项，随后按目录顺序列出全部模型；
 * 手动锁定态下 ✔ 只在锁定模型行，自动路由态下 ✔ 在 Default 行。
 */
export function buildModelOptions(config: ShenlanConfig): ModelOption[] {
  const manual = getPolicy() === 'manual';
  const locked = getLockedModel();
  const currentModel = manual ? (locked || getEffectiveModel()) : getEffectiveModel();

  const options: ModelOption[] = [
    {
      kind: 'auto',
      model: 'Default',
      provider: 'auto',
      group: '自动路由',
      contextWindow: 0,
      available: true,
      current: !manual,
      tag: `自动路由 · cost-first · 基线 ${getModel()}`,
      priceText: '',
    },
  ];

  for (const c of getCatalog()) {
    options.push({
      kind: 'model',
      model: c.model,
      provider: c.provider,
      group: groupFor(c.provider),
      contextWindow: c.contextWindow,
      available: hasProviderKey(config, c.provider),
      current: manual && c.model === currentModel,
      tag: modelTag(c.thinking, c.tier),
      priceText: priceTextFor(c.model),
    });
  }

  // 厂商接口动态发现的目录外模型：可手动选择，但不进入自动路由。
  for (const [provider, models] of Object.entries(config.providerModels ?? {})) {
    for (const model of models ?? []) {
      if (options.some((o) => o.model === model)) continue;
      options.push({
        kind: 'model',
        model,
        provider,
        group: groupFor(provider),
        contextWindow: 0,
        available: hasProviderKey(config, provider),
        current: manual && model === currentModel,
        tag: '动态发现 · 手动使用',
        priceText: '',
      });
    }
  }

  // 手动锁定的模型不在目录（自定义模型名）时追加为一项，保证选中态可见
  if (manual && locked && !options.some(o => o.model === locked)) {
    const provider = resolveModelProvider(config, locked);
    options.push({
      kind: 'model',
      model: locked,
      provider,
      group: groupFor(provider),
      contextWindow: getModelContextWindow(locked),
      available: true,
      current: true,
      tag: '自定义模型',
      priceText: priceTextFor(locked),
    });
  }
  return options;
}

/** 面板初始选中：当前项 → 首个可用项 → 0 */
export function initialModelSelection(models: ModelOption[]): number {
  const current = models.findIndex(m => m.current);
  if (current >= 0) return current;
  const available = models.findIndex(m => m.available);
  return available >= 0 ? available : 0;
}

/**
 * 把路由状态持久化到全局配置（~/.shenlan/config.json）。
 * 写失败不阻断切换（进程内已生效），记录调试日志即可。
 */
function persistRouting(routing: RoutingConfig): void {
  try {
    updateConfig({ routing }, { scope: 'global' });
  } catch (err) {
    debugLog('/model persistence failed', { routing, error: (err as Error).message });
  }
}

export function modelCommand(args: string): string {
  if (!args.trim()) {
    const locked = getLockedModel();
    const info = locked
      ? chalk.white(locked) + chalk.dim(' (locked)')
      : chalk.white(getEffectiveModel()) + chalk.dim(` (auto · ${routingInfo()})`);
    return chalk.dim('model: ') + info;
  }

  const val = args.trim();
  switch (val) {
    case 'auto':
      enableAuto();
      resetSessionSticky();
      persistRouting({ policy: 'cost-first', lockedModel: null });
      return chalk.dim('Routing: ') + chalk.green('auto (cost-first)');
    case 'cost-first':
      setPolicy('cost-first');
      resetSessionSticky();
      persistRouting({ policy: 'cost-first', lockedModel: null });
      return chalk.dim('Policy: ') + chalk.green('cost-first');
    case 'quality-first':
      setPolicy('quality-first');
      resetSessionSticky();
      persistRouting({ policy: 'quality-first', lockedModel: null });
      return chalk.dim('Policy: ') + chalk.green('quality-first');
    default:
      // 手动锁定指定模型（policy → manual，后续路由固定用它）
      lockModel(val);
      resetSessionSticky();
      persistRouting({ policy: 'manual', lockedModel: val });
      return chalk.dim('switched to: ') + chalk.white(currentModel) + chalk.dim(' (locked)');
  }
}
