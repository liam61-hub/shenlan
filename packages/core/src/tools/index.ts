/**
 * 工具接口定义 + 注册中心
 */
import { loadConfig, resolveApiKey } from '../config.js';
import { debugLog } from '../debug-logger.js';
import type { ShenlanConfig } from '../config.js';

/** JSON Schema 类型（简化版） */
export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

/** 工具执行结果 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  /** 图片 data URL 数组（结构化携带，消息组装时展开为 image_url 内容块；纯增量字段） */
  images?: string[];
}

/** 工具定义 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}

/** 工具注册中心 */
const toolRegistry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (toolRegistry.has(tool.name)) {
    throw new Error(`Tool "${tool.name}" is already registered`);
  }
  toolRegistry.set(tool.name, tool);
}

/** 卸载工具（幂等；不存在时静默忽略），用于 MCP 热卸载/重连 */
export function unregisterTool(name: string): void {
  toolRegistry.delete(name);
}

export function getTool(name: string): Tool | undefined {
  return toolRegistry.get(name);
}

export function getAllTools(): Tool[] {
  return Array.from(toolRegistry.values());
}

export function getToolSchemas(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}> {
  return getAllTools().map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

// ---- 注册内置工具 ----
// 通过 registerAllTools() 动态导入，避免 ES module 循环依赖。
// config 可选传入（测试与独立 core 使用）；缺省 loadConfig()。
export async function registerAllTools(config?: ShenlanConfig): Promise<void> {
  const imports: Array<Promise<unknown>> = [
    import('./read.js'),
    import('./write.js'),
    import('./edit.js'),
    import('./shell.js'),
    import('./search.js'),
    import('./glob.js'),
    import('./pitfall.js'),
    import('./ref.js'),
    import('./restore.js'),
    import('./web-search.js'),
    import('./agent.js'),
    import('./background-agent.js'),
    import('./web-fetch.js'),
    import('./view-image.js'),
    import('./transcribe-media.js'),
    import('./todo.js'),
    import('./plan.js'),
    import('./memory.js'),
  ];
  // tavily_search 为可选独立工具（tavily.enabled，默认关闭）；
  // web_search 的 Tavily 兜底不受此开关影响
  const cfg = config ?? loadConfig();
  if (cfg.tavily?.enabled) {
    if (!resolveApiKey(cfg, 'tavily')) {
      debugLog('tavily.enabled=true 但未配置 key（TAVILY_API_KEY 环境变量或 providerKeys.tavily）', {});
    }
    imports.push(import('./tavily.js'));
  }
  await Promise.all(imports);
}
