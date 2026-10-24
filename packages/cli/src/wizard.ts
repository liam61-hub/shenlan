/**
 * 首次引导向导 — 多 provider 配置（DeepSeek / qwen / OpenAI / Custom OpenAI-compatible）
 *
 * 交互流程：
 *   1. provider 多选（逗号/空格分隔，非法输入循环重问，空输入默认 1）
 *   2. 每个选中 provider 询问 API Key（去空格；空输入 = 取消该 provider）；
 *      custom 条目改为三问：baseUrl（空 = 自动推导官方端点，未知模型建议必填）→
 *      API Key → 模型名自由文本（派生 provider 按 detectProvider 归属，如 gpt-5.4 → openai）
 *   3. 每个有 key 的普通 provider 选择模型（默认第 1 项）；
 *      **目录无模型的厂商**（doubao/zhipu/kimi 等 preset 已认领但 MODEL_CATALOG 无记录）
 *      先按其 key 探测厂商 /v1/models 拿清单再单选（超过 DISCOVERED_MODEL_LIST_LIMIT 截断展示，
 *      并允许直接输入模型名）；探测失败/无清单退回手输模型名——不再对空列表做单选
 *   4. 配置多个 provider 时追加「默认模型」从已选型号中选择；单 provider 直接采用
 *   5. 每个写入 key 的 provider 单独做连通性测试（失败仅黄色警告不中断）；
 *      第 3 步已探测过的条目复用其结果，不重复请求
 *
 * 落盘：进入时询问保存作用域（g 全局 ~/.shenlan/config.json（默认）/ p 项目 .shenlan/config.json），
 * 默认全局（私有分发、用户自带 key：密钥集中管理，不散落在各项目）；用户显式选 p 才写项目级。
 * updateConfig 原子写 + 深合并 —
 *   providerKeys 按 provider 合并写入（保留既有 provider 条目，空 key 不写），
 *   custom 条目换算为派生 provider：providerKeys[p] + providerBaseUrls[p]（baseUrl 归一化；
 *   派生 provider 为内置且 baseUrl 留空时不写 baseUrl，走内置默认端点）；
 *   model.model 写最终默认模型；全新配置时 model.baseUrl 置空（resolveBaseUrl 按
 *   provider 自动解析，默认模型为 qwen 时自动走 dashscope），已有文件保留原 baseUrl
 *   等字段。重跑向导 = 合并更新（支持先配 deepseek 再补 qwen）。
 * 不写 routing — 保持 cost-first 自动路由。
 */
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import type { ConfigScope, ShenlanConfig } from '@shenlan/core';
import { updateConfig, projectConfigPath, globalConfigPath, loadDotEnvFiles, detectProvider, normalizeBaseUrl, envVarForProvider } from '@shenlan/core';
import { PROVIDERS, providerById, DISCOVERED_MODEL_LIST_LIMIT, type ProviderDef } from './providers.js';

/** 已配置 provider 条目（provider id + 所选模型） */
export interface ConfiguredProvider {
  provider: string;
  model: string;
}

/** 向导结果：已配置 providers 列表 + 最终默认模型 */
export interface WizardResult {
  providers: ConfiguredProvider[];
  defaultModel: string;
}

function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => resolve(answer.trim()));
  });
}

/** 保存作用域：g 全局（默认）/ p 项目 */
async function selectScope(rl: ReturnType<typeof createInterface>): Promise<ConfigScope> {
  while (true) {
    const answer = await ask(
      rl,
      chalk.dim('  Save API keys to — (g)lobal ~/.shenlan/config.json, (p)roject .shenlan/config.json (default: g): '),
    );
    const v = answer.toLowerCase();
    if (!v || v === 'g' || v === 'global') return 'global';
    if (v === 'p' || v === 'project') return 'project';
    console.log(chalk.yellow('  ⚠ Invalid input — enter g (global) or p (project).'));
  }
}

/** provider 多选：逗号/空格分隔，非法输入循环重问，空输入默认 1 */
async function selectProviders(rl: ReturnType<typeof createInterface>): Promise<ProviderDef[]> {
  const list = PROVIDERS.map((p, i) => `[${i + 1}] ${p.name}`).join(' ');
  while (true) {
    const answer = await ask(rl, chalk.dim(`  Providers ${list} (default: 1): `));
    if (!answer) return [PROVIDERS[0]!];
    const tokens = answer.split(/[,\s]+/).filter(Boolean);
    const picked: ProviderDef[] = [];
    let valid = true;
    for (const token of tokens) {
      const n = Number(token);
      if (!Number.isInteger(n) || n < 1 || n > PROVIDERS.length) {
        valid = false;
        break;
      }
      const def = PROVIDERS[n - 1]!;
      if (!picked.includes(def)) picked.push(def);
    }
    if (!valid || picked.length === 0) {
      console.log(chalk.yellow(`  ⚠ Invalid input — enter a number 1-${PROVIDERS.length} (e.g. 1,2).`));
      continue;
    }
    return picked;
  }
}

/** 模型单选：默认第 1 项，非法输入循环重问 */
async function selectModel(
  rl: ReturnType<typeof createInterface>,
  provider: ProviderDef,
  choices: Array<{ id: string; label: string }>,
): Promise<string> {
  const options = choices.map((m, i) => `[${i + 1}] ${m.label}`).join(' ');
  while (true) {
    const answer = await ask(rl, chalk.dim(`  ${provider.name} model — ${options} (default: 1): `));
    if (!answer) return choices[0]!.id;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
      return choices[n - 1]!.id;
    }
    console.log(chalk.yellow(`  ⚠ Invalid input — enter a number 1-${choices.length}.`));
  }
}

/**
 * 发现型模型单选：只展示前 DISCOVERED_MODEL_LIST_LIMIT 项（与 /keys 面板同一上限）；
 * 接受序号，也接受直接输入模型名（用于列表未展示或探测接口未返回的模型）。
 */
async function selectDiscoveredModel(
  rl: ReturnType<typeof createInterface>,
  provider: ProviderDef,
  models: string[],
): Promise<string> {
  const shown = models.slice(0, DISCOVERED_MODEL_LIST_LIMIT);
  const options = shown.map((m, i) => `[${i + 1}] ${m}`).join(' ');
  const more = models.length > shown.length ? ` …(+${models.length - shown.length} more)` : '';
  console.log(chalk.dim(`    ${options}${more}`));
  while (true) {
    const answer = await ask(
      rl,
      chalk.dim(`  ${provider.name} model — number 1-${shown.length} or a model name (default: 1): `),
    );
    if (!answer) return shown[0]!;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1]!;
    // 非纯数字一律按模型名接受（可填未展示的模型）
    if (!/^\d+$/.test(answer)) return answer;
    console.log(chalk.yellow(`  ⚠ Invalid input — enter a number 1-${shown.length} or a model name.`));
  }
}

/** 默认模型选择：从已选型号中指定，默认第 1 项 */
async function selectDefaultModel(
  rl: ReturnType<typeof createInterface>,
  configured: ConfiguredProvider[],
): Promise<string> {
  const options = configured.map((c, i) => `[${i + 1}] ${c.model}`).join(' ');
  while (true) {
    const answer = await ask(rl, chalk.dim(`  Default model — ${options} (default: 1): `));
    if (!answer) return configured[0]!.model;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= configured.length) {
      return configured[n - 1]!.model;
    }
    console.log(chalk.yellow(`  ⚠ Invalid input — enter a number 1-${configured.length}.`));
  }
}

/** 自定义 provider 模型名自由文本：trim 非空循环重问 */
async function askModelName(rl: ReturnType<typeof createInterface>, provider: ProviderDef): Promise<string> {
  while (true) {
    const answer = await ask(rl, chalk.dim(`  ${provider.name} Model name (e.g. gpt-5.4, deepseek-v4-flash): `));
    if (answer) return answer;
    console.log(chalk.yellow('  ⚠ Model name cannot be empty.'));
  }
}

/** 已配置条目（含落盘所需的派生 provider 与可选 baseUrl） */
interface ConfiguredEntry {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** 第 3 步为「目录无模型」的厂商预探测的结果；有值时第 6 步复用，不重复请求 */
  probe?: ModelProbeResult;
}

/**
 * 单个 provider 配置：custom 走 baseUrl（空 = 自动推导官方端点）→ API Key（空 = 跳过）→
 * 模型名三步；普通 provider 走 API Key → 模型单选（目录有模型）或
 * API Key → 探测厂商接口 → 模型单选/手输（目录无模型）。
 * custom 的 provider 按模型名派生（detectProvider，如 gpt-5.4 → openai），
 * baseUrl 归一化后随条目带回。
 */
async function configureProvider(
  rl: ReturnType<typeof createInterface>,
  provider: ProviderDef,
): Promise<ConfiguredEntry | null> {
  let baseUrl = '';
  if (provider.custom) {
    baseUrl = await ask(
      rl,
      chalk.dim(`  ${provider.name} Base URL (empty = auto-detect official endpoint; required for unknown models): `),
    );
  }
  const apiKey = await ask(rl, chalk.dim(`  ${provider.name} API Key (leave empty to skip ${provider.name}): `));
  if (!apiKey) {
    console.log(chalk.dim(`  Skipping ${provider.name}.`));
    return null;
  }

  // custom：baseUrl → key → 模型名自由文本（provider 按模型名派生）
  if (provider.custom) {
    const model = await askModelName(rl, provider);
    return { provider: detectProvider(model), model, apiKey, baseUrl };
  }

  // 目录有该厂商模型：直接单选（保持既有流程与序号语义）
  if (provider.models.length > 0) {
    const model = await selectModel(rl, provider, provider.models);
    return { provider: provider.id, model, apiKey, baseUrl };
  }

  // 目录无该厂商模型：先按 key 探测厂商 /v1/models 拿清单，拿到就单选，
  // 拿不到退回手输——空列表直接单选会取到 undefined（历史崩溃点）。
  process.stdout.write(chalk.dim(`  Discovering ${provider.name} models... `));
  const probe = await requestModels(provider, apiKey, baseUrl);
  reportProbe(probe);
  const model = probe.models.length > 0
    ? await selectDiscoveredModel(rl, provider, probe.models)
    : await askModelName(rl, provider);
  return { provider: provider.id, model, apiKey, baseUrl, probe };
}

/** /v1/models 探测结果：连通性 + 发现的模型清单（任何失败都降级为空清单） */
interface ModelProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  models: string[];
}

/** 请求 /v1/models：silent（不打印），供探测与连通性测试共用 */
async function requestModels(
  provider: ProviderDef,
  apiKey: string,
  baseUrl?: string,
): Promise<ModelProbeResult> {
  const target = baseUrl ? `${normalizeBaseUrl(baseUrl)}/v1/models` : provider.testUrl;
  if (!target) {
    return { ok: false, error: 'no endpoint to verify (base URL required for unknown models)', models: [] };
  }
  try {
    const resp = await fetch(target, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { ok: false, status: resp.status, models: [] };
    let models: string[] = [];
    try {
      const body = await resp.json() as { data?: Array<{ id?: unknown }> };
      if (Array.isArray(body.data)) {
        models = [...new Set(body.data
          .map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
          .filter((id) => id.length > 0 && id.length <= 200))]
          .slice(0, 1000);
      }
    } catch { /* 成功但非 JSON：只做连通性确认 */ }
    return { ok: true, status: resp.status, models };
  } catch (err) {
    return { ok: false, error: (err as Error).message, models: [] };
  }
}

/** 探测结果单行播报（失败仅黄色提示，不中断向导） */
function reportProbe(probe: ModelProbeResult): void {
  if (probe.ok) {
    console.log(chalk.green(`✓ Connected${probe.models.length ? ` · discovered ${probe.models.length} models` : ''}`));
  } else if (probe.status !== undefined) {
    console.log(chalk.yellow(`⚠ HTTP ${probe.status}`));
  } else if (probe.error?.startsWith('no endpoint')) {
    console.log(chalk.dim('skipped (no endpoint to verify — resolves at runtime)'));
  } else {
    console.log(chalk.yellow(`⚠ ${probe.error}`));
  }
}

/** 连通性测试：失败仅黄色警告，不中断向导；baseUrl 提供时按归一化根路径拼 /v1/models */
async function testConnectivity(provider: ProviderDef, apiKey: string, baseUrl?: string): Promise<string[]> {
  process.stdout.write(chalk.dim(`  Testing ${provider.name} connection... `));
  const probe = await requestModels(provider, apiKey, baseUrl);
  reportProbe(probe);
  return probe.models;
}

export async function runWizard(): Promise<WizardResult> {
  // .env 加载：与交互/headless 入口一致（项目 cwd/.env + 全局 ~/.shenlan/.env）
  loadDotEnvFiles(process.cwd());
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.bold('\n  🔧 深蓝 shenlan — First-time Setup\n'));
  console.log(chalk.dim('  API keys are saved locally (providerKeys, 0600); environment variables still take priority.\n'));

  // 0. 保存作用域：默认全局（密钥集中管理），项目级为显式选择
  const scope = await selectScope(rl);
  const scopeLabel = scope === 'global' ? '全局 ~/.shenlan/config.json' : '项目 .shenlan/config.json';
  console.log(chalk.dim(`  Keys will be saved to: ${scopeLabel}\n`));

  // 1. provider 多选
  const selected = await selectProviders(rl);

  // 2-3. 每个选中 provider：API Key（空 = 取消）+ 模型；custom 走 baseUrl 三步
  const configured: ConfiguredEntry[] = [];
  for (const provider of selected) {
    const entry = await configureProvider(rl, provider);
    if (entry) configured.push(entry);
  }

  if (configured.length === 0) {
    rl.close();
    console.log(chalk.yellow('\n  ⚠ No provider configured — rerun --setup anytime to configure.'));
    console.log(chalk.dim('  Start: node packages/cli/dist/index.js\n'));
    return { providers: [], defaultModel: '' };
  }

  // 4. 默认模型：多 provider 时从已选型号中选择，单 provider 直接采用
  const defaultModel = configured.length > 1
    ? await selectDefaultModel(rl, configured)
    : configured[0]!.model;

  rl.close();

  // 5. 落盘：updateConfig 原子写 + 深合并（保留既有 providerKeys 与其他字段）
  const cwd = process.cwd();
  const providerKeys: Record<string, string> = {};
  const providerBaseUrls: Record<string, string> = {};
  for (const c of configured) {
    providerKeys[c.provider] = c.apiKey;
    // custom 填了 baseUrl 才写 providerBaseUrls（归一化去尾部 /v1；留空走内置默认端点）
    if (c.baseUrl) providerBaseUrls[c.provider] = normalizeBaseUrl(c.baseUrl);
  }

  const isFresh = !existsSync(scope === 'global'
    ? globalConfigPath()
    : projectConfigPath(cwd));
  const patch: Record<string, unknown> = { providerKeys };
  if (Object.keys(providerBaseUrls).length > 0) patch.providerBaseUrls = providerBaseUrls;
  if (isFresh) {
    // 全新配置：baseUrl 置空，实际端点由 resolveBaseUrl 按 provider 自动解析
    patch.model = { baseUrl: '', model: defaultModel, maxTokens: 8192 };
  } else {
    // 已有配置：只更新默认模型，保留原 baseUrl 等字段
    patch.model = { model: defaultModel };
  }
  updateConfig(patch as unknown as Partial<ShenlanConfig>, { scope, cwd });

  // 6. 每个写入 key 的 provider 分别连通性测试（custom 用其 baseUrl；派生 provider 展示回落 custom 行）；
  //    第 3 步已探测过的条目复用其结果，避免对同一端点重复请求
  for (const c of configured) {
    const def = PROVIDERS.find((p) => p.id === c.provider) ?? providerById('custom')!;
    let discovered: string[];
    if (c.probe) {
      process.stdout.write(chalk.dim(`  Testing ${def.name} connection... `));
      reportProbe(c.probe);
      discovered = c.probe.models;
    } else {
      discovered = await testConnectivity(def, c.apiKey, c.baseUrl || undefined);
    }
    const models = [...new Set([...discovered, c.model])].sort();
    updateConfig({ providerModels: { [c.provider]: models } }, { scope, cwd });
  }

  // 7. 结束输出：已配置 provider 与其模型 + env 覆盖提示 + 启动命令
  console.log(chalk.green('\n  ✓ Setup complete!'));
  console.log(chalk.dim('  Configured providers:'));
  for (const c of configured) {
    const def = PROVIDERS.find((p) => p.id === c.provider);
    console.log(chalk.dim(`    ${def ? def.name : c.provider} → ${c.model}`));
  }
  console.log(chalk.dim(`  Default model: ${defaultModel}`));
  const envTips = configured.map((c) => {
    const def = PROVIDERS.find((p) => p.id === c.provider);
    return `export ${def ? def.envVar : envVarForProvider(c.provider)}=<key>`;
  }).join('  ');
  console.log(chalk.dim(`  Tip: ${envTips} overrides config (env takes priority).`));
  console.log(chalk.dim(`  Keys saved to: ${scopeLabel}`));
  console.log(chalk.dim('  Start: node packages/cli/dist/index.js\n'));

  return {
    providers: configured.map(({ provider, model }) => ({ provider, model })),
    defaultModel,
  };
}
