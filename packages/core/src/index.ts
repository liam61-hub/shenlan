/**
 * @shenlan/core — Agent Harness 内核
 *
 * 零 UI 依赖，所有决策逻辑在此实现
 */
export { loadConfig, createDefaultConfigFile, ensureConfigSampleFiles, ensureProjectConfigFiles, DEFAULT_CONFIG, PROVIDER_PRESETS, resolveApiKey, detectProvider, resolveModelProvider, hasProviderKey, hasAnyProviderKey, resolveBaseUrl, detectProviderFromUrl, envVarForProvider, providerEnvVars, normalizeBaseUrl, chatCompletionsUrl, updateConfig, writeConfigFile, readRawConfig, globalConfigPath, projectConfigPath } from './config.js';
export { MODEL_CATALOG, catalogModel, catalogModelsByProvider, isVisionModelInCatalog, modelSupportsModality, isThinkingModel, getModelMaxOutputTokens, resolveMaxOutputTokens, DEFAULT_THINKING_OUTPUT_FLOOR, defaultCompactModelFor } from './model-catalog.js';
export type { CatalogModel, CatalogPrice, OutputBudgetOptions } from './model-catalog.js';
export type { ShenlanConfig, ModelConfig, PermissionConfig, PermissionMode, ProviderKeys, ProviderBaseUrls, ProviderModels, ProviderPreset, AgentConfig, ContextConfig, BalanceCheckConfig, MemoryConfig, UpdateCheckConfig, TavilyConfig, ActionSafetyConfig, PlanModeConfig, PitfallMemoryConfig, ProviderFailoverConfig, OnboardingConfig, RoutingConfig, RoutingPolicy, ConfigScope } from './config.js';
export { CONFIG_KEYS, CONFIG_KEY_PREFIXES, lookupConfigKey, parseConfigValue, getNested, setNested, deleteNested, ENV_VARS, descText } from './config-schema.js';
export type { ConfigKeyMeta, ConfigKeyPrefixRule, ParseConfigResult, EnvVarMeta, Lang, BilingualText } from './config-schema.js';

export { chat, chatStream, messageTextOf, maxTokensFieldFor } from './provider.js';
export type { Message, Role, ToolCall, FunctionDef, ChatResponse, StreamCallbacks, TokenUsage, ContentPart } from './provider.js';
export { toolResultToMessages } from './message-builders.js';

export {
  createSession,
  addMessage,
  appendToJsonl,
  flushSession,
  flushAllSessions,
  syncSessionMessages,
  writeSessionMeta,
  loadSession,
  listSessions,
  setSessionDir,
} from './session.js';
export type { Session } from './session.js';

export { buildSystemPrompt, getAvailableTools, refreshMemorySection } from './context.js';

export {
  estimateTokens,
  estimateTotalTokens,
  compressMessages,
  compressMessagesV2,
  buildRuleSummary,
  isSummaryMessage,
  sanitizeMessagePairing,
  SUMMARY_MARKER,
} from './compression.js';
export type { CompressV2Options, CompressV2Result } from './compression.js';

export { needsConfirmation, decidePermission, describePermissionMode } from './permission.js';
export type { PermissionDecision } from './permission.js';

export { configDir, dataDir, platformId } from './platform.js';
export { isPathSafe, maskSensitive, isProtectedPath, setSafetyConfig } from './security.js';
export { scanForSecrets, isBlockedPath, maskSecret } from './security-scan.js';
export type { SecretMatch } from './security-scan.js';
export { classifyApiError, formatApiError } from './api-errors.js';
export type { ApiErrorClass, ApiErrorKind } from './api-errors.js';
export { loadDotEnvFiles } from './dotenv.js';
export { expandHome } from './tools/paths.js';
export { moveToTrash, restoreFromTrash, listTrash, emptyTrash } from './trash.js';

export { ERR_CODES } from './errors.js';
export type { ErrorCode } from './errors.js';

export { storeRef, retrieveRef, listRefs, cleanupRefs } from './ref-store.js';

export {
  estimateCost,
  estimateCostDetailed,
  fallbackPriceFor,
  unpricedCatalogModels,
  getPrice,
  formatCost,
  isPriceTableExpired,
  pricesFilePath,
  loadUserPrices,
  resetPrices,
  getEffectivePrices,
  writePricesFile,
} from './pricing.js';
export type { PriceTable, PriceFile, ManualPrice, AutoPrice, LoadedPrices, CostSource, CostEstimate, FallbackPrice } from './pricing.js';

export { syncPrices, qwenModelsUrl, parseDeepSeekPricing } from './prices-sync.js';
export type { PriceSyncResult, SyncProvider, SyncPricesOptions } from './prices-sync.js';

export { recordUsage, getSessionCost, resetSessionCost } from './cost-tracker.js';
export type { SessionCost, ModelUsage } from './cost-tracker.js';

export { takeSnapshot, undoS, snapshotCount, listSnapshots } from './snapshot.js';

export { loadSkillIndex, buildSkillIndexText, loadSkillContent, buildSkillScanDirs } from './skill-loader.js';
export type { SkillEntry } from './skill-loader.js';

export { loadMemories, injectMemories, loadMemoryIndex, updateMemoryIndex, removeMemoryIndex, injectMemoryIndex, buildMemorySection, MEMORY_BLOCK_START, MEMORY_BLOCK_END, globalMemoryDir, projectMemoryDir, DEFAULT_MEMORY_TOKEN_BUDGET } from './memory.js';
export type { MemoryEntry, MemoryIndex, MemoryIndexLine, MemorySection, BuildMemorySectionOptions } from './memory.js';

export { expandImports, IMPORT_MAX_DEPTH, IMPORT_MAX_FILE_BYTES } from './memory-import.js';
export type { ExpandImportsOptions, ExpandImportsResult } from './memory-import.js';

export {
  discoverRuleFiles,
  matchPathsRule,
  touchedPathsOfToolCall,
  buildRulesSection,
  RULE_MAX_DEPTH,
  RULE_MAX_FILE_BYTES,
  RULE_LEVEL_MAX_CHARS,
} from './rules-loader.js';
export type {
  RuleFile,
  RuleLevel,
  RuleDiscovery,
  DiscoverRuleFilesOptions,
  RulesSection,
  BuildRulesSectionOptions,
} from './rules-loader.js';

export {
  connectMcpServers,
  disconnectAll,
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  refreshMcpServers,
  setMcpServerEnabled,
  connectMcpServer,
  disconnectMcpServer,
} from './mcp-manager.js';
export type { McpServerStatus } from './mcp-manager.js';
export { McpClient } from './mcp-client.js';
export type { McpServerConfig, McpToolDef } from './mcp-client.js';

export {
  registerTool,
  unregisterTool,
  getTool,
  getAllTools,
  getToolSchemas,
  registerAllTools,
} from './tools/index.js';
export type { Tool, ToolResult, JsonSchema } from './tools/index.js';
export { validateToolArguments } from './tools/schema-validation.js';
export type { ArgumentValidationResult } from './tools/schema-validation.js';
export { executeToolCall } from './tools/execute.js';
export type { ToolExecutionOptions, ToolExecutionResult, ToolApprovalRequest } from './tools/execute.js';
export {
  executeToolWithTimeout,
  TOOL_TIMEOUTS,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './tools/timeout.js';
export type { TimeoutToolResult } from './tools/timeout.js';
export { runSubTask, setAgentConfig, getAgentConfig } from './tools/agent.js';
export type { SubTaskProgress, SubTaskResult, SubTaskStatus } from './tools/agent.js';
export { setActiveModel, getActiveModel } from './tools/web-search.js';
export { getTodos, clearTodos } from './tools/todo.js';
export type { TodoItem, TodoStatus } from './tools/todo.js';
export { getTaskProgress, clearTaskProgress } from './tools/task-progress.js';
export type { TaskProgressEvent, TaskProgressKind, TaskProgressStatus } from './tools/task-progress.js';
export { getPlan, clearPlan } from './tools/plan.js';
export type { PlanItem, PlanStatus } from './tools/plan.js';
export { registerExitPlanModeTool, unregisterExitPlanModeTool } from './tools/exit-plan-mode.js';
export { GOAL_COMPLETE_TOOL, registerGoalComplete, unregisterGoalComplete } from './tools/goal.js';
export { savePlan, renderPlanMarkdown, sanitizePlanTitle } from './plans.js';
export type { PlanSaveMeta, SavedPlan } from './plans.js';
export {
  startBackgroundTask,
  consumePendingInjections,
  listRunningBackgroundTasks,
  countRunningBackgroundTasks,
  abortAllBackgroundTasks,
  clearBackgroundTasks,
  setBackgroundRunner,
  setBackgroundListener,
} from './background-tasks.js';
export type { BackgroundRunner, BackgroundInjection, BackgroundEvent } from './background-tasks.js';

export { isHighRiskCommand, HIGH_RISK_PATTERNS } from './tools/shell.js';
export { IMAGE_MIMES, encodeImageAsDataUrl } from './tools/view-image.js';
export { setTranscribeRunner, whisperTranscribeRunner } from './tools/transcribe-media.js';
export type { TranscribeRequest, TranscribeRunner } from './tools/transcribe-media.js';
export { recordAuditEvent, readAuditEvents, auditLogPath } from './audit.js';
export type { AuditEvent } from './audit.js';
export { checkDeepseekBalance } from './balance.js';
export type { BalanceCheckResult } from './balance.js';
export {
  parsePitfallEntry,
  loadPitfalls,
  searchPitfalls,
  incrementPitfallHits,
  globalPitfallPath,
} from './pitfall-store.js';
export type { PitfallEntry } from './pitfall-store.js';

export { debugLog } from './debug-logger.js';
