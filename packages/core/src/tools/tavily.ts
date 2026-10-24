/**
 * Tavily 联网搜索工具（可选独立工具，tavily.enabled 默认关闭，由 registerAllTools 条件导入）
 *
 * API: https://docs.tavily.com/
 * Key 统一解析（resolveApiKey）：TAVILY_API_KEY 环境变量 > providerKeys.tavily
 */
import { registerTool } from './index.js';
import { loadConfig, resolveApiKey } from '../config.js';

registerTool({
  name: 'tavily_search',
  description: 'Search the web using Tavily API. Returns titles, URLs, and content snippets. Use for finding current information, documentation, or facts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of results (default: 5, max: 10)',
      },
    },
    required: ['query'],
  },
  async execute(params, signal?) {
    const query = params.query as string;
    const maxResults = Math.min((params.max_results as number) || 5, 10);
    const apiKey = resolveApiKey(loadConfig(), 'tavily');

    if (!apiKey) {
      return {
        content: 'Tavily search unavailable: set TAVILY_API_KEY env var or add providerKeys.tavily to config (/config set providerKeys.tavily <key>)',
        isError: true,
      };
    }

    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: maxResults,
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { content: `Tavily API error ${resp.status}: ${text.slice(0, 200)}`, isError: true };
      }

      const data = await resp.json() as {
        results?: Array<{ title: string; url: string; content: string; score: number }>;
      };

      const results = data.results || [];
      if (results.length === 0) {
        return { content: `No results found for "${query}"` };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content.slice(0, 200)}`,
      ).join('\n\n');

      return { content: `Search results for "${query}":\n\n${formatted}` };
    } catch (err) {
      return { content: `Tavily search failed: ${(err as Error).message}`, isError: true };
    }
  },
});
