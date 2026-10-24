/**
 * /keys 密钥管理面板 — 共享逻辑（条目构建 / 保存 / 删除 / 连通性测试）
 *
 * 密钥只显示掩码（尾 4 位）；Enter 进入输入模式（支持粘贴），
 * 保存后做连通性测试（失败仅黄色提示不阻塞）；Esc 取消。
 * Custom OpenAI-compatible 行走三步录入（baseUrl → key → 模型名，派生 provider）。
 * 底部显示当前作用域，g/p 切换全局/项目级（默认全局）。
 */
import type { ShenlanConfig } from '@shenlan/core';
import { updateConfig, readRawConfig, writeConfigFile, globalConfigPath, projectConfigPath, detectProvider, normalizeBaseUrl, envVarForProvider, providerEnvVars, type ConfigScope } from '@shenlan/core';
import { PROVIDERS, providerById, DISCOVERED_MODEL_LIST_LIMIT, type ProviderDef } from './providers.js';

export interface KeyProviderEntry {
  id: string;
  name: string;
  /** 掩码展示：尾 4 位 */
  masked: string;
  /** 配置文件中已有 key（providerKeys） */
  configured: boolean;
  /** 环境变量已设置（覆盖配置文件，显示提示） */
  envSet: boolean;
  envVar: string;
  /** 自定义派生行的 baseUrl（providerBaseUrls，展示与删除用） */
  baseUrl?: string;
  /** 配置派生的自定义行（不在 PROVIDERS 内，如 llama） */
  derived?: boolean;
}

export function maskKey(key: string): string {
  const s = key.trim();
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
}

/** 环境变量 key（SHENLAN_API_KEY 优先，其次 provider 规范名/别名） */
function envKeyFor(id: string): string {
  if (process.env.SHENLAN_API_KEY) return process.env.SHENLAN_API_KEY;
  for (const n of providerEnvVars(id)) {
    const v = process.env[n];
    if (v) return v;
  }
  return '';
}

/** 构建 /keys 面板条目：内置 provider 行 + 配置派生的自定义行 + custom 入口行 */
export function buildKeyProviders(config: ShenlanConfig): KeyProviderEntry[] {
  const entries: KeyProviderEntry[] = [];
  // 1. 内置 provider（deepseek/qwen/openai）行
  for (const p of PROVIDERS) {
    if (p.custom) continue;
    const configured = Boolean(config.providerKeys?.[p.id]);
    const envKey = envKeyFor(p.id);
    const envSet = Boolean(envKey);
    entries.push({
      id: p.id,
      name: p.name,
      masked: configured ? maskKey(config.providerKeys![p.id]!) : envSet ? maskKey(envKey) : '(未配置)',
      configured,
      envSet,
      envVar: p.envVar,
    });
  }
  // 2. 配置派生的自定义行（providerKeys/providerBaseUrls 中不在 PROVIDERS 的 id）
  const derivedIds = new Set<string>([
    ...Object.keys(config.providerKeys ?? {}),
    ...Object.keys(config.providerBaseUrls ?? {}),
  ]);
  for (const id of [...derivedIds].sort()) {
    if (PROVIDERS.some((p) => p.id === id)) continue;
    const key = config.providerKeys?.[id] ?? '';
    const baseUrl = config.providerBaseUrls?.[id] ?? '';
    const envKey = envKeyFor(id);
    entries.push({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      masked: key ? maskKey(key) : envKey ? maskKey(envKey) : '(未配置)',
      configured: Boolean(key),
      envSet: Boolean(envKey),
      envVar: envVarForProvider(id),
      baseUrl,
      derived: true,
    });
  }
  // 3. Custom OpenAI-compatible 入口行（尾部）
  const customDef = providerById('custom')!;
  entries.push({
    id: customDef.id,
    name: customDef.name,
    masked: '(未配置)',
    configured: false,
    envSet: false,
    envVar: '',
  });
  return entries;
}

/** 保存 provider key 到指定作用域（0600 原子写，保留其他字段） */
export function saveProviderKey(
  provider: string,
  apiKey: string,
  scope: ConfigScope,
  cwd = process.cwd(),
): { file: string } {
  const key = apiKey.trim();
  if (!key) throw new Error('API key 不能为空');
  const patch: Record<string, unknown> = {
    providerKeys: { [provider]: key },
  };
  const r = updateConfig(patch as unknown as Partial<ShenlanConfig>, { scope, cwd });
  return { file: r.file };
}

/**
 * 自定义 provider 三步录入落盘：provider 按模型名派生（detectProvider，如 gpt-5.4 → openai）；
 * baseUrl 归一化后写入 providerBaseUrls（留空不写，走内置默认端点）；默认模型同步更新。
 */
export function saveCustomProvider(
  input: { baseUrl: string; apiKey: string; model: string; provider?: string },
  scope: ConfigScope,
  cwd = process.cwd(),
): { provider: string; file: string } {
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  if (!apiKey) throw new Error('API key 不能为空');
  if (!model) throw new Error('模型名不能为空');
  const provider = input.provider?.trim() || detectProvider(model);
  const patch: Record<string, unknown> = {
    providerKeys: { [provider]: apiKey },
    model: { model },
  };
  const baseUrl = normalizeBaseUrl(input.baseUrl.trim());
  if (baseUrl) patch.providerBaseUrls = { [provider]: baseUrl };
  const r = updateConfig(patch as unknown as Partial<ShenlanConfig>, { scope, cwd });
  return { provider, file: r.file };
}

/** 保存厂商模型清单；去重、排序并限制异常响应规模。 */
export function saveProviderModels(
  provider: string,
  models: string[],
  scope: ConfigScope,
  cwd = process.cwd(),
): { file: string; count: number } {
  const normalized = [...new Set(models.map((m) => m.trim()).filter((m) => m && m.length <= 200))]
    .sort()
    .slice(0, 1000);
  const r = updateConfig({ providerModels: { [provider]: normalized } }, { scope, cwd });
  return { file: r.file, count: normalized.length };
}

/** 从指定作用域删除 provider key（providerKeys 置空串，不触碰其他字段） */
export function deleteProviderKey(
  provider: string,
  scope: ConfigScope,
  cwd = process.cwd(),
): { file: string } {
  const file = scope === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const raw = readRawConfig(file) || {};
  const keys = { ...((raw.providerKeys as Record<string, unknown>) || {}) };
  delete keys[provider];
  writeConfigFile(file, { ...raw, providerKeys: keys });
  return { file };
}

/** 从指定作用域删除 provider 的 baseUrl（自定义派生行删除时连带清理） */
export function deleteProviderBaseUrl(
  provider: string,
  scope: ConfigScope,
  cwd = process.cwd(),
): { file: string } {
  const file = scope === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const raw = readRawConfig(file) || {};
  const urls = { ...((raw.providerBaseUrls as Record<string, unknown>) || {}) };
  delete urls[provider];
  writeConfigFile(file, { ...raw, providerBaseUrls: urls });
  return { file };
}

/** /v1/models 连通性探测结果（失败仅提示，不阻塞保存） */
export interface ConnectivityResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** 成功且响应为 OpenAI 兼容 data[].id 时的模型清单 */
  models?: string[];
}

/** 连通性测试：GET <testUrl> with Bearer；baseUrl 提供时按归一化根路径拼 /v1/models；失败仅提示不阻塞 */
export async function testConnectivity(
  provider: ProviderDef,
  apiKey: string,
  baseUrl?: string,
): Promise<ConnectivityResult> {
  const target = baseUrl ? `${normalizeBaseUrl(baseUrl)}/v1/models` : provider.testUrl;
  if (!target) return { ok: false, error: 'no endpoint to verify (base URL required for unknown models)' };
  try {
    const resp = await fetch(target, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      let models: string[] | undefined;
      try {
        const body = await resp.json() as { data?: Array<{ id?: unknown }> };
        if (Array.isArray(body.data)) {
          models = [...new Set(body.data
            .map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
            .filter((id) => id.length > 0 && id.length <= 200))]
            .slice(0, 1000);
        }
      } catch { /* 部分兼容端点成功但不返回 JSON：仅视为连通，不阻塞 */ }
      return { ok: true, status: resp.status, models };
    }
    return { ok: false, status: resp.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** 第 3 步模型选择结果：命中模型名，或给出可读错误 */
export type ModelChoice = { model: string } | { error: string };

/**
 * 自定义 provider 第 3 步的模型解析（与向导的发现型单选同语义）：
 *  - 有发现清单且输入为纯数字 → 按序号（1-based，仅前 DISCOVERED_MODEL_LIST_LIMIT 项可选），越界报错；
 *  - 其余输入（含无清单时的纯数字）→ 一律当模型名，支持清单未覆盖/接口未返回的模型。
 */
export function resolveModelChoice(input: string, discovered: string[] = []): ModelChoice {
  const raw = input.trim();
  if (!raw) return { error: '模型名不能为空' };
  const shown = discovered.slice(0, DISCOVERED_MODEL_LIST_LIMIT);
  if (shown.length > 0 && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n < 1 || n > shown.length) {
      return { error: `序号超出范围（1-${shown.length}），或直接输入模型名` };
    }
    return { model: shown[n - 1]! };
  }
  return { model: raw };
}

export const KEY_SCOPE_LABELS: Record<ConfigScope, string> = {
  project: '项目级',
  global: '全局',
};
