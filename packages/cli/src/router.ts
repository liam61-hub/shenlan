/**
 * 模型路由 — 按任务自动选模型
 *
 * 策略: cost-first (默认) / quality-first / manual
 * 按输入模态、任务类型、上下文大小自动匹配
 */
import type { ShenlanConfig, Message } from '@shenlan/core';
import { hasProviderKey, getPrice, fallbackPriceFor, setActiveModel, chat, resolveApiKey, resolveBaseUrl, resolveModelProvider, MODEL_CATALOG, catalogModel, type CatalogModel } from '@shenlan/core';
import { getModel, setModel, DEFAULT_MODEL } from './commands/model.js';

type RoutingPolicy = 'cost-first' | 'quality-first' | 'manual';



let policy: RoutingPolicy = 'cost-first';
let lockedModel: string | null = null;
/**
 * 配置里显式设定的默认模型（initRoutingFromConfig 记录；/model auto 等重置基线时使用）。
 * 初始为 null：router ↔ commands/model 存在循环导入，模块初始化时 DEFAULT_MODEL 可能尚未就绪，
 * 因此推迟到调用时用 ?? DEFAULT_MODEL 求值。
 */
let configuredDefaultModel: string | null = null;
/** 会话级模型粘性：记录本会话首个路由结果，后续轮次沿用（/model 切换时重置） */
let sessionStickyModel: string | null = null;

/** 获取路由策略 */
export function getPolicy(): RoutingPolicy { return policy; }

/** 获取锁定模型 */
export function getLockedModel(): string | null { return lockedModel; }

/** 获取当前实际生效模型：会话粘性路由模型优先（与 repl 实际调用一致），否则默认模型 */
export function getEffectiveModel(): string {
  return sessionStickyModel ?? getModel();
}

/**
 * 启动时从配置恢复路由状态（index.tsx 在 loadConfig 后调用）：
 *  - routing.policy=manual + lockedModel → 恢复手动锁定
 *  - routing.policy=cost-first|quality-first → 恢复策略
 *  - 顺带修复：未锁定时让配置里的 model.model 真正生效
 * 同时把生效模型同步到 core 的 web_search 路由（setActiveModel）。
 */
export function initRoutingFromConfig(config: ShenlanConfig): void {
  const routing = config.routing;
  configuredDefaultModel = config.model.model || DEFAULT_MODEL;
  if (routing?.policy === 'manual' && routing.lockedModel) {
    policy = 'manual';
    lockedModel = routing.lockedModel;
    setModel(routing.lockedModel);
    setActiveModel(routing.lockedModel);
    return;
  }
  if (routing?.policy === 'cost-first' || routing?.policy === 'quality-first') {
    policy = routing.policy;
  } else {
    policy = 'cost-first';
  }
  lockedModel = null;
  setModel(config.model.model || DEFAULT_MODEL);
  sessionStickyModel = null;
  setActiveModel(getEffectiveModel());
}

/** 根据任务文本推断任务类型 */
function detectTaskType(input: string): 'coding' | 'deep_reasoning' | 'long_context' | 'general' {
  // 注意：\b 是 ASCII 词边界，中文关键词不能包 \b（否则纯中文输入永远匹配不上）
  const zh = (keywords: string[]): boolean => keywords.some((k) => input.includes(k));
  const en = (pattern: RegExp): boolean => pattern.test(input);

  // 深度推理
  if (
    zh(['推导', '证明', '复杂度分析', '算法设计', '架构设计', '安全审计']) ||
    en(/\bsecurity\.?review\b/i)
  ) {
    return 'deep_reasoning';
  }
  // 编码任务
  if (
    zh([
      '代码', '编写', '实现', '修复', '重构', '测试', '部署',
      '分析', '介绍', '逻辑', '架构', '权益卡', '设计', '方案', '评审', '排查', '梳理',
    ]) ||
    en(/\b(?:code|bug|fix|refactor|test|debug|deploy|implement|build)\b/i) ||
    /\bsrc\//.test(input) || /\.[tj]sx?\b/.test(input) || /\.py\b/.test(input)
  ) {
    return 'coding';
  }
  // 长文档/大仓库（检测引用多个文件）
  if ((input.match(/@\S+/g) || []).length >= 3 || input.length > 500) {
    return 'long_context';
  }
  return 'general';
}

/** 有可用 key 的目录模型（按 provider 过滤；config 缺省时无可用集） */
function availableModels(config?: ShenlanConfig): CatalogModel[] {
  if (!config) return [];
  return MODEL_CATALOG.filter(c => hasProviderKey(config, c.provider));
}

/**
 * 动态成本：按生效价格（manual > auto > 内置）的 inputPrice + outputPrice（高峰口径，CNY/1M）
 * 计算。无生效价的模型走 core 的同档回退估算（fallbackPriceFor），**与有价模型同量纲**。
 *
 * 为什么不直接回退 relativeCost（1–4）：那与价格和（如 deepseek-v4-flash = 3+9 = 12）
 * 量纲不同，无价模型恒得低分，cost-first 会系统性优先选中账面 ¥0 的模型 —— 既选错模型
 * 又让成本护栏失效。回退估算仍无解（目录外模型）时才退回 relativeCost。
 */
function effectiveCost(c: CatalogModel): number {
  const p = getPrice(c.model);
  if (p) return p.inputPrice + p.outputPrice;
  const fb = fallbackPriceFor(c.model);
  if (fb) return fb.inputPrice + fb.outputPrice;
  return c.relativeCost;
}

/**
 * 择优：tier 优先（同档取 cost 低）或 cost 优先（同价取目录序，deepseek 在前）
 *
 * tier 优先模式下多一道次级键：**同档位内文本专用模型优于视觉模型**。
 * 原因：视觉模型（qwen-vl-max）的 tier 反映的是它的看图能力，其文本档位被高估，
 * 且内置价目前是占位值 —— 修掉 effectiveCost 量纲错误后它会成为 tier4 里"最便宜"的，
 * 于是纯文本编码任务会被路由给一个视觉模型。图片输入走 pickVisionModel 独立择优，
 * 不受本规则影响；跨 tier 仍以 tier 为主键（openai 的 gpt-5.4 依旧胜过 gpt-5.4-mini）。
 */
function pickBest(candidates: CatalogModel[], preferTier: boolean): CatalogModel {
  const sorted = [...candidates].sort((a, b) => {
    if (preferTier) {
      if (b.tier !== a.tier) return b.tier - a.tier;
      const av = a.modalities.includes('image') ? 1 : 0;
      const bv = b.modalities.includes('image') ? 1 : 0;
      if (av !== bv) return av - bv;
    }
    return effectiveCost(a) - effectiveCost(b);
  });
  return sorted[0];
}

type TaskType = 'coding' | 'deep_reasoning' | 'long_context' | 'general';

/** 按任务类型与可用 provider 选模型（routeModel 与 routeModelAsync 共用） */
function routeWithTaskType(taskType: TaskType, available: CatalogModel[], config?: ShenlanConfig): string {
  if (policy === 'quality-first') {
    return pickBest(available, true).model;
  }
  // cost-first: 默认选最便宜，编码/推理/长上下文自动切最强
  if (taskType === 'coding' || taskType === 'deep_reasoning' || taskType === 'long_context') {
    return pickBest(available, true).model;
  }
  return pickBest(available, false).model;
}

/** 无可用 key / 未传 config 时的回退路由（保持既有 deepseek 行为，旧测试不破） */
function fallbackRoute(taskType: TaskType, config?: ShenlanConfig): string {
  // 配置模型有可用 key（env/别名/providerKeys/model.apiKey 任一）→ 尊重配置默认模型
  const configured = config?.model.model;
  if (config && configured && resolveApiKey(config, resolveModelProvider(config, configured))) {
    return configured || getModel() || DEFAULT_MODEL;
  }
  if (policy === 'quality-first') return 'deepseek-v4-pro';
  if (taskType === 'coding' || taskType === 'deep_reasoning' || taskType === 'long_context') {
    return 'deepseek-v4-pro';
  }
  return 'deepseek-v4-flash';
}

/**
 * 目录外模型 + 其 provider 有可用 key → 直接采用配置模型。
 * 用户显式指定专属端点模型（如 gpt-5.4）时不走自动路由，防止 providerKeys 里
 * 残留的 deepseek/qwen key 掩盖新配置；目录内模型保持 cost-first 自动路由不变。
 */
function configuredOutOfCatalog(config?: ShenlanConfig): string | null {
  if (!config) return null;
  const m = config.model.model;
  if (!m || MODEL_CATALOG.some((c) => c.model === m)) return null;
  return resolveApiKey(config, resolveModelProvider(config, m)) ? m : null;
}

/**
 * 按策略、任务类型与可用 provider 选模型（同步，关键词启发式）。
 * config 缺省或没有任何 provider key → 保持既有 deepseek 行为。
 * 目录外模型（有 key）→ 直接采用配置模型（见 configuredOutOfCatalog）。
 */
export function routeModel(input: string, config?: ShenlanConfig): string {
  // manual 模式
  if (policy === 'manual') return lockedModel || getModel();

  // 目录外模型 + 可用 key → 直接采用配置模型
  const outOfCatalog = configuredOutOfCatalog(config);
  if (outOfCatalog) return outOfCatalog;

  const available = availableModels(config);
  const taskType = detectTaskType(input);
  if (available.length === 0) return fallbackRoute(taskType, config);
  return routeWithTaskType(taskType, available, config);
}

const CLASSIFY_SYSTEM_PROMPT =
  'You are a task classifier. Classify the user request into exactly one of: ' +
  '"coding" (code implementation/fix/refactor/test/debug), "deep_reasoning" ' +
  '(proof, algorithm design, architecture, security review), "long_context" ' +
  '(multi-file analysis, long documents), "general" (everything else). ' +
  'Reply with a single word only.';

const CLASSIFY_TIMEOUT_MS = 8000;

/** 分类器模型：可用目录里 cost 最低的 flash 档（无 key 时返回 null） */
function classifierModel(config?: ShenlanConfig): CatalogModel | null {
  const available = availableModels(config);
  if (available.length === 0) return null;
  return pickBest(available, false);
}

/**
 * LLM 一次性任务分类（flash 小 maxTokens 单次调用）：
 * 无可用 key / 调用失败 / 输出非枚举值 → 回退关键词启发式（detectTaskType）。
 */
async function classifyTaskAsync(input: string, config?: ShenlanConfig): Promise<TaskType> {
  const classifier = classifierModel(config);
  if (!classifier || !config) return detectTaskType(input);
  const apiKey = resolveApiKey(config, classifier.provider);
  if (!apiKey) return detectTaskType(input);

  const messages: Message[] = [
    { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
    { role: 'user', content: input.slice(0, 2000) },
  ];
  try {
    const withTimeout = new Promise<Awaited<ReturnType<typeof chat>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('classify timeout')), CLASSIFY_TIMEOUT_MS);
      chat({
        baseUrl: resolveBaseUrl(config, classifier.model),
        apiKey,
        model: classifier.model,
        maxTokens: 16,
      }, messages).then(
        (resp) => { clearTimeout(timer); resolve(resp); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
    const resp = await withTimeout;
    const text = (resp.choices[0]?.message?.content ?? '').trim().toLowerCase();
    if (['coding', 'deep_reasoning', 'long_context', 'general'].includes(text)) {
      return text as TaskType;
    }
    return detectTaskType(input);
  } catch {
    return detectTaskType(input);
  }
}

/** 异步路由：LLM 一次性分类（失败回退启发式）替代同步关键词路径（生产路径） */
export async function routeModelAsync(input: string, config?: ShenlanConfig): Promise<string> {
  if (policy === 'manual') return lockedModel || getModel();

  // 目录外模型 + 可用 key → 直接采用配置模型（与 routeModel 同步语义一致）
  const outOfCatalog = configuredOutOfCatalog(config);
  if (outOfCatalog) return outOfCatalog;

  const available = availableModels(config);

  // 输入模态：图片 → 优先视觉模型（qwen-vl）；无视觉模型可用时降级文本模型并提示
  if (detectModality(input) === 'image') {
    const vision = pickVisionModel(config);
    if (vision) return vision;
  }

  const taskType = await classifyTaskAsync(input, config);
  if (available.length === 0) return fallbackRoute(taskType, config);
  return routeWithTaskType(taskType, available, config);
}

/**
 * 会话级模型粘性：本会话首个路由结果在后续轮次沿用（生产路径走 LLM 分类，/model 切换时重置）。
 * 中途发图单向升级：sticky 为非视觉模型且输入含图片（policy 非 manual）→ 切换为可用视觉模型
 * 并提示（视觉 → 文本不降级，避免抖动）；manual 锁定尊重用户手选不升级。
 */
export async function routeModelSticky(input: string, config?: ShenlanConfig): Promise<string> {
  if (!sessionStickyModel) {
    sessionStickyModel = await routeModelAsync(input, config);
    setActiveModel(sessionStickyModel);
    return sessionStickyModel;
  }
  if (detectModality(input) === 'image' && policy !== 'manual' && !isVisionModel(sessionStickyModel)) {
    const vision = pickVisionModel(config);
    if (vision) {
      sessionStickyModel = vision;
      setActiveModel(vision);
      routeDegradedNotice = `输入包含图片，已切换至视觉模型 ${vision}`;
    }
  }
  return sessionStickyModel;
}

/** 输入模态检测：@图片路径（png/jpg/jpeg/webp/gif/bmp）→ image */
export function detectModality(input: string): 'image' | 'text' {
  return /@[\w./\\-]+\.(png|jpe?g|webp|gif|bmp)\b/i.test(input) ? 'image' : 'text';
}

/** 是否为目录内的视觉模型（modalities 含 image）；目录外模型视为 false */
export function isVisionModel(model: string): boolean {
  return MODEL_CATALOG.some((c) => c.model === model && c.modalities.includes('image'));
}

/**
 * 可用视觉模型择优（modalities 含 image 的目录模型按 tier/价选优）。
 * 无视觉模型但有可用文本集时写一次性降级提示；返回 null = 无可用视觉模型。
 */
export function pickVisionModel(config?: ShenlanConfig): string | null {
  const available = availableModels(config);
  const visionModels = available.filter((m) => m.modalities.includes('image'));
  if (visionModels.length > 0) return pickBest(visionModels, true).model;
  if (available.length > 0) {
    routeDegradedNotice =
      '输入包含图片但无可用视觉模型（qwen-vl）——已按文本模型路由，图片内容不会被解读（可先 /config 配置 qwen key）';
  }
  return null;
}

/**
 * 故障转移备用模型（§25）：当前模型失败时的跨 provider 等价模型。
 * 规则：同 tier 优先；无同 tier 取最高 tier；并列按成本升序、再按目录序。
 * 备用 provider 无 key / 当前模型不在目录 → null（不切换）。
 */
export function findFailoverTarget(model: string, config?: ShenlanConfig): string | null {
  const current = MODEL_CATALOG.find((c) => c.model === model);
  if (!current || !config) return null;
  const candidates = MODEL_CATALOG.filter((c) => c.provider !== current.provider && hasProviderKey(config, c.provider));
  if (candidates.length === 0) return null;
  const sameTier = candidates.filter((c) => c.tier === current.tier);
  const pool = sameTier.length > 0 ? sameTier : candidates;
  return pickBest(pool, true).model;
}

/** 降级路由提示（图片输入但无视觉模型）：set 于路由时，consume 后清空（只提示一次） */
let routeDegradedNotice: string | null = null;

export function consumeRouteDegradedNotice(): string | null {
  const n = routeDegradedNotice;
  routeDegradedNotice = null;
  return n;
}

/** 重置会话级模型粘性（/model 切换、策略变更时调用） */
export function resetSessionSticky(): void {
  sessionStickyModel = null;
  // 粘性清除后生效模型回到基准，同步活动模型（web_search 等 core 工具保持路由一致）
  setActiveModel(getEffectiveModel());
}

/** 查询模型上下文窗口（token），未知模型按 100 万兜底 */
export function getModelContextWindow(model: string): number {
  return MODEL_CATALOG.find((c) => c.model === model)?.contextWindow ?? 1_000_000;
}

/** 获取当前路由决策的解释 */
export function explainRoute(input: string): string {
  const taskType = detectTaskType(input);
  const model = routeModel(input);
  const labels: Record<string, string> = {
    coding: 'coding task', deep_reasoning: 'deep reasoning',
    long_context: 'long context', general: 'general',
  };
  return `${model} (${getPolicy()}, ${labels[taskType]})`;
}

/** 手动锁定模型 */
export function lockModel(model: string): void {
  policy = 'manual';
  lockedModel = model;
  setModel(model);
  setActiveModel(model);
}

/** 恢复自动路由 */
export function enableAuto(): void {
  policy = 'cost-first';
  lockedModel = null;
  // 回到配置里显式设定的默认模型，而不是硬编码 deepseek
  const base = configuredDefaultModel ?? DEFAULT_MODEL;
  setModel(base);
  setActiveModel(base);
}

/** 设置路由策略 */
export function setPolicy(p: RoutingPolicy): void {
  policy = p;
  // 离开 manual 锁定态后基准模型回到配置默认（否则 /model 会展示残留的锁定模型）
  if (p !== 'manual') {
    const base = configuredDefaultModel ?? DEFAULT_MODEL;
    setModel(base);
    setActiveModel(base);
  } else {
    // 手动态：生效模型 = 锁定模型（未锁定时回退当前基准）
    setActiveModel(lockedModel ?? getModel());
  }
}

/** 获取当前路由信息 */
export function routingInfo(): string {
  if (policy === 'manual') return `manual (locked: ${lockedModel || getModel()})`;
  return policy;
}

/** 模型能力目录（供外部查询） */
export function getCatalog(): CatalogModel[] { return MODEL_CATALOG; }
