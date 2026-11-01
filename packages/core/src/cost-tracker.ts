/** Session token usage and optional local price estimates for /cost. */
import { estimateCostDetailed } from './pricing.js';

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** Local estimate from the configured price table; null means unknown. */
  estimatedCostCny: number | null;
  hasFallbackEstimate: boolean;
}

export interface SessionCost {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** Sum of available local estimates; null if any model price is unknown. */
  estimatedCostCny: number | null;
  unpricedModels: string[];
  byModel: ModelUsage[];
}

const emptySession = (): SessionCost => ({
  promptTokens: 0,
  completionTokens: 0,
  calls: 0,
  estimatedCostCny: 0,
  unpricedModels: [],
  byModel: [],
});

let sessionUsage = emptySession();

/** Record API-reported usage. Estimated amounts are display-only and never persisted. */
export function recordUsage(model: string, promptTokens: number, completionTokens: number): void {
  const estimate = estimateCostDetailed(model, promptTokens, completionTokens);
  let item = sessionUsage.byModel.find((usage) => usage.model === model);
  if (!item) {
    item = { model, promptTokens: 0, completionTokens: 0, calls: 0, estimatedCostCny: 0, hasFallbackEstimate: false };
    sessionUsage.byModel.push(item);
  }
  item.promptTokens += promptTokens;
  item.completionTokens += completionTokens;
  item.calls += 1;
  if (estimate.cny === null) {
    item.estimatedCostCny = null;
    if (!sessionUsage.unpricedModels.includes(model)) sessionUsage.unpricedModels.push(model);
  } else if (item.estimatedCostCny !== null) {
    item.estimatedCostCny += estimate.cny;
  }
  item.hasFallbackEstimate ||= estimate.source !== 'price';

  sessionUsage.promptTokens += promptTokens;
  sessionUsage.completionTokens += completionTokens;
  sessionUsage.calls += 1;
  if (estimate.cny === null) sessionUsage.estimatedCostCny = null;
  else if (sessionUsage.estimatedCostCny !== null) sessionUsage.estimatedCostCny += estimate.cny;
}

export function getSessionCost(): SessionCost {
  return {
    ...sessionUsage,
    unpricedModels: [...sessionUsage.unpricedModels],
    byModel: sessionUsage.byModel.map((item) => ({ ...item })),
  };
}

export function resetSessionCost(): void {
  sessionUsage = emptySession();
}
