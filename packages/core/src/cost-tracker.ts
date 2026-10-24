/**
 * 会话级成本记账 — 累加每轮 LLM 真实 usage，供 /cost /budget 展示
 *
 * 以 API 响应里的真实 usage（prompt/completion tokens）为准，按价格表折算 CNY；
 * 会话成本为进程内 session 级状态，不落盘，/clear 时重置（与 todo/plan 同一生命周期）；
 * 单日成本按本地日期持久化到 ~/.shenlan/cost-ledger.json（跨会话生效），
 * 供成本护栏 checkCostGuardrail 在每次 LLM 调用前检查。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CostGuardrailsConfig } from './config.js';
import { debugLog } from './debug-logger.js';
import { estimateCostDetailed, formatCost } from './pricing.js';

export interface SessionCost {
  promptTokens: number;
  completionTokens: number;
  costCny: number;
  calls: number;
  /** costCny 中来自同档回退估算（无内置价）的部分 */
  estimatedCostCny: number;
  /** 用了回退估算的调用次数 */
  estimatedCalls: number;
  /** 本会话遇到的无内置价模型（去重，供 /cost /budget 提示） */
  unpricedModels: string[];
}

/** 单日成本账本（本地日期） */
export interface DailyCost {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  costCny: number;
  calls: number;
  /** costCny 中来自回退估算的部分（旧账本文件缺失 → 0） */
  estimatedCostCny?: number;
  estimatedCalls?: number;
}

/** 成本护栏检查结果 */
export interface CostGuardrailCheck {
  blocked: boolean;
  /** 触发原因（blocked=true 时） */
  reason?: string;
  /** 触发维度：会话上限 / 单日上限（blocked 或预警时） */
  kind?: 'session' | 'day';
  /** 当前用量占比（max(session, day)，0-1+） */
  ratio: number;
  /** ok(<60%) / warn(≥60% 接近上限，仅预警不拦截) / blocked(≥100%) */
  level: 'ok' | 'warn' | 'blocked';
}

let sessionCost: SessionCost = {
  promptTokens: 0,
  completionTokens: 0,
  costCny: 0,
  calls: 0,
  estimatedCostCny: 0,
  estimatedCalls: 0,
  unpricedModels: [],
};

/** 会话级豁免：用户在一次成本弹窗里选择「本次继续」后置位，/clear 重置 */
let sessionWaived = false;

/** 今日本地日期 YYYY-MM-DD */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 日账本路径：默认 ~/.shenlan/cost-ledger.json，
 * 可用 SHENLAN_COST_LEDGER 环境变量覆盖（测试隔离用）。
 */
export function costLedgerPath(): string {
  return process.env.SHENLAN_COST_LEDGER || join(homedir(), '.shenlan', 'cost-ledger.json');
}

/** 日账本数据结构（含豁免标记；估算字段来自 DailyCost，旧账本缺失时归零） */
interface LedgerData extends DailyCost {
  dayWaived?: boolean;
}

/** 读取今日账本；文件缺失/损坏/日期已变 → 按今日归零 */
function loadLedger(): LedgerData {
  try {
    const parsed = JSON.parse(readFileSync(costLedgerPath(), 'utf-8'));
    if (parsed && typeof parsed.date === 'string' && parsed.date === today()) {
      return {
        date: parsed.date,
        costCny: typeof parsed.costCny === 'number' ? parsed.costCny : 0,
        calls: typeof parsed.calls === 'number' ? parsed.calls : 0,
        dayWaived: parsed.dayWaived === true,
        estimatedCostCny: typeof parsed.estimatedCostCny === 'number' ? parsed.estimatedCostCny : 0,
        estimatedCalls: typeof parsed.estimatedCalls === 'number' ? parsed.estimatedCalls : 0,
      };
    }
  } catch {
    // 文件不存在或损坏：按今日归零
  }
  return { date: today(), costCny: 0, calls: 0, dayWaived: false, estimatedCostCny: 0, estimatedCalls: 0 };
}

function saveLedger(ledger: LedgerData): void {
  try {
    mkdirSync(dirname(costLedgerPath()), { recursive: true });
    writeFileSync(costLedgerPath(), JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (err) {
    // 账本写失败不影响 LLM 调用：护栏降级为仅会话内检查
    debugLog('cost ledger write failed', { path: costLedgerPath(), error: String(err) });
  }
}

/**
 * 记录一次 LLM 调用的真实用量，累加进会话成本与单日账本。
 *
 * 无内置价的模型走同档回退估算（estimateCostDetailed），估算部分单独计入
 * estimatedCostCny/estimatedCalls 以便 /cost /budget 说明「这个数含估算」；
 * 目录外未知模型仍计 0（无从估算），但 token 照常累加。
 */
export function recordUsage(model: string, promptTokens: number, completionTokens: number): void {
  const est = estimateCostDetailed(model, promptTokens, completionTokens);
  sessionCost.promptTokens += promptTokens;
  sessionCost.completionTokens += completionTokens;
  sessionCost.costCny += est.cny;
  sessionCost.calls += 1;
  if (est.source !== 'price') {
    sessionCost.estimatedCalls += 1;
    sessionCost.estimatedCostCny += est.cny;
    if (!sessionCost.unpricedModels.includes(model)) sessionCost.unpricedModels.push(model);
  }
  // 单日账本：本地日期累计，跨会话持久化
  const ledger = loadLedger();
  ledger.costCny += est.cny;
  ledger.calls += 1;
  if (est.source !== 'price') {
    ledger.estimatedCostCny = (ledger.estimatedCostCny ?? 0) + est.cny;
    ledger.estimatedCalls = (ledger.estimatedCalls ?? 0) + 1;
  }
  saveLedger(ledger);
}

/** 当前会话累计成本（返回副本） */
export function getSessionCost(): SessionCost {
  return { ...sessionCost, unpricedModels: [...sessionCost.unpricedModels] };
}

/** 今日累计成本（跨会话，从账本读取） */
export function getDailyCost(): DailyCost {
  return loadLedger();
}

/** 重置会话成本（/clear 时调用） */
export function resetSessionCost(): void {
  sessionCost = {
    promptTokens: 0,
    completionTokens: 0,
    costCny: 0,
    calls: 0,
    estimatedCostCny: 0,
    estimatedCalls: 0,
    unpricedModels: [],
  };
  sessionWaived = false;
}

/**
 * 豁免本会话的会话级上限（成本弹窗「本次继续」）。
 * 单次决定后本会话不再因会话上限拦截；/clear 或下次进程启动复位。
 */
export function waiveSession(): void {
  sessionWaived = true;
}

/** 今日是否已被豁免（跨会话持久化在日账本，重启生效） */
export function isDayWaived(): boolean {
  return loadLedger().dayWaived === true;
}

/** 豁免今日的单日上限（写入日账本，重启后仍生效） */
export function waiveDay(date = today()): void {
  const ledger = loadLedger();
  ledger.date = date;
  ledger.dayWaived = true;
  saveLedger(ledger);
}

/**
 * 拦截原因里的估算说明后缀：含回退估算时让「为什么被拦」可解释。
 * 无估算成分 → 空串（原有文案逐字不变）。
 */
function estimatedSuffix(estimatedCalls: number, estimatedCostCny: number): string {
  if (estimatedCalls <= 0) return '';
  return `（其中 ${formatCost(estimatedCostCny)} 来自 ${estimatedCalls} 次无内置价调用的同档估算）`;
}

/**
 * 成本护栏检查：每次 LLM 调用前调用。
 * 会话成本或今日成本已达上限 → blocked（调用方停止当前任务，不再发起调用）。
 * 未启用 / 未配置 → 不拦截。
 */
export function checkCostGuardrail(guardrails?: CostGuardrailsConfig): CostGuardrailCheck {
  if (!guardrails?.enabled) return { blocked: false, ratio: 0, level: 'ok' };
  const session = sessionCost.costCny;
  const daily = getDailyCost().costCny;
  const sessionLimit = guardrails.maxCostPerSession;
  const dayLimit = guardrails.maxCostPerDay;
  const sessionRatio = sessionLimit > 0 ? session / sessionLimit : 0;
  const dayRatio = dayLimit > 0 ? daily / dayLimit : 0;
  const ratio = Math.max(sessionRatio, dayRatio);
  const level: CostGuardrailCheck['level'] =
    ratio >= 1 ? 'blocked' : ratio >= 0.6 ? 'warn' : 'ok';

  const sessionBlocked = !sessionWaived && sessionLimit > 0 && session >= sessionLimit;
  if (sessionBlocked) {
    return {
      blocked: true,
      kind: 'session',
      ratio,
      level,
      reason: `本会话成本 ${formatCost(session)} 已达上限 ${formatCost(guardrails.maxCostPerSession)}${estimatedSuffix(sessionCost.estimatedCalls, sessionCost.estimatedCostCny)}`,
    };
  }
  const dayBlocked = !isDayWaived() && dayLimit > 0 && daily >= dayLimit;
  if (dayBlocked) {
    const ledger = getDailyCost();
    return {
      blocked: true,
      kind: 'day',
      ratio,
      level,
      reason: `今日成本 ${formatCost(daily)} 已达上限 ${formatCost(guardrails.maxCostPerDay)}${estimatedSuffix(ledger.estimatedCalls ?? 0, ledger.estimatedCostCny ?? 0)}`,
    };
  }
  return { blocked: false, kind: ratio >= 0.6 ? (sessionRatio >= dayRatio ? 'session' : 'day') : undefined, ratio, level };
}
