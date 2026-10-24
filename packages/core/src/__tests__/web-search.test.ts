import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qwenSearch, dashscopeResponsesSearch, setActiveModel, qwenSearchModel, QWEN_CHAT_SEARCH_MODELS, QWEN_RESPONSES_MODELS } from '../tools/web-search.js';
import { getTool } from '../tools/index.js';
import { MODEL_CATALOG } from '../model-catalog.js';

const realEnv = {
  SHENLAN_CONFIG_DIR: process.env.SHENLAN_CONFIG_DIR,
  SHENLAN_API_KEY: process.env.SHENLAN_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  QWEN_API_KEY: process.env.QWEN_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
};

describe('web_search — 原生搜索适配器（deepseek / qwen）+ Tavily fallback', () => {
  let tmp: string;
  let globalDir: string;
  let projectDir: string;
  let fetchMock: MockInstance;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-websearch-'));
    globalDir = join(tmp, 'global');
    projectDir = join(tmp, 'proj');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = globalDir;
    // 清除模块级活动模型注入，避免跨用例污染
    setActiveModel(null);
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    delete process.env.SHENLAN_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.QWEN_API_KEY;
    delete process.env.TAVILY_API_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(realEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeGlobalConfig(patch: Record<string, unknown>): void {
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({
      model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
      permissions: { mode: 'default', allow: ['read', 'search'], deny: [] },
      skills: [],
      mcpServers: [],
      ...patch,
    }, null, 2), 'utf-8');
  }

  const dashscope = 'https://dashscope.aliyuncs.com/compatible-mode';
  const okJson = (json: unknown) => ({ ok: true, json: async () => json });
  /** 构造 chat/completions SSE 流式响应（多个 delta content 分片） */
  const sseResponse = (chunks: Array<{ content?: string }>) => {
    const encoder = new TextEncoder();
    const lines: string[] = [];
    for (const c of chunks) {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: c.content ?? '' } }] })}\n\n`);
    }
    lines.push('data: [DONE]\n\n');
    return {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      }),
    };
  };

  describe('qwenSearch（原生适配器直接测试）', () => {
    it('请求打到 compatible-mode/v1/chat/completions，带 Bearer、enable_search 与 stream:true', async () => {
      fetchMock.mockResolvedValue(sseResponse([{ content: '杭州明天晴，28°C' }]));

      const result = await qwenSearch('杭州明天天气', 'sk-qwen', 'qwen-plus', dashscope);

      expect(result).toEqual({ text: '杭州明天晴，28°C' });
      expect(fetchMock).toHaveBeenCalledWith(
        `${dashscope}/v1/chat/completions`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-qwen' },
          body: JSON.stringify({
            model: 'qwen-plus',
            messages: [{ role: 'user', content: '杭州明天天气' }],
            enable_search: true,
            search_options: { forced_search: true, search_strategy: 'agent' },
            stream: true,
          }),
        }),
      );
    });

    it('SSE 多分片内容拼接', async () => {
      fetchMock.mockResolvedValue(sseResponse([{ content: '杭州' }, { content: '多云转晴' }, { content: '' }]));

      const result = await qwenSearch('杭州天气', 'sk-qwen', 'qwen-plus', dashscope);

      expect(result).toEqual({ text: '杭州多云转晴' });
    });

    it('HTTP 失败返回 error 而非抛错', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

      const result = await qwenSearch('q', 'sk-qwen', 'qwen-plus', dashscope);

      expect(result).toEqual({ error: 'HTTP 500: boom' });
    });

    it('空内容返回 error', async () => {
      fetchMock.mockResolvedValue(sseResponse([]));

      const result = await qwenSearch('q', 'sk-qwen', 'qwen-plus', dashscope);

      expect('error' in result ? result.error : '').toContain('empty');
    });

    it('超 2000 字符截断', async () => {
      fetchMock.mockResolvedValue(sseResponse([{ content: 'x'.repeat(2500) }]));

      const result = await qwenSearch('q', 'sk-qwen', 'qwen-plus', dashscope);

      expect(result).toEqual({ text: 'x'.repeat(2000) + '...(truncated)' });
    });
  });

  describe('dashscopeResponsesSearch（Responses API 原生适配器直接测试）', () => {
    it('请求打到 compatible-mode/v1/responses，带 Bearer、web_search 工具与模型', async () => {
      fetchMock.mockResolvedValue(okJson({
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '思考过程' }] },
          { type: 'web_search_call', action: { queries: ['北京天气'] } },
          { type: 'message', content: [{ type: 'output_text', text: '北京晴' }] },
        ],
      }));

      const result = await dashscopeResponsesSearch('北京天气', 'sk-qwen', 'qwen3.8-max', dashscope);

      expect(result).toEqual({ text: '北京晴' });
      expect(fetchMock).toHaveBeenCalledWith(
        `${dashscope}/v1/responses`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-qwen' },
          body: JSON.stringify({ model: 'qwen3.8-max', input: '北京天气', tools: [{ type: 'web_search' }] }),
        }),
      );
    });

    it('跳过 reasoning/web_search_call，只拼接 message 文本', async () => {
      fetchMock.mockResolvedValue(okJson({
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '不该出现' }] },
          { type: 'web_search_call', action: { queries: ['x'] } },
          { type: 'message', content: [{ type: 'output_text', text: '杭州多云' }] },
        ],
      }));

      const result = await dashscopeResponsesSearch('q', 'sk-qwen', 'qwen3.8-max', dashscope);

      expect(result).toEqual({ text: '杭州多云' });
    });

    it('HTTP 失败返回 error 而非抛错', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad model' });

      const result = await dashscopeResponsesSearch('q', 'sk-qwen', 'qwen3.8-max', dashscope);

      expect(result).toEqual({ error: 'HTTP 400: bad model' });
    });

    it('超时返回 timeout 标记（供适配器回退）', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      fetchMock.mockRejectedValue(timeoutErr);

      const result = await dashscopeResponsesSearch('q', 'sk-qwen', 'qwen3.8-max', dashscope);

      expect(result).toEqual({ error: 'The operation was aborted due to timeout', timeout: true });
    });

    it('无文本内容返回 error', async () => {
      fetchMock.mockResolvedValue(okJson({ output: [{ type: 'web_search_call', action: { queries: ['x'] } }] }));

      const result = await dashscopeResponsesSearch('q', 'sk-qwen', 'qwen3.8-max', dashscope);

      expect('error' in result ? result.error : '').toContain('no text content');
    });

    it('超 2000 字符截断', async () => {
      fetchMock.mockResolvedValue(okJson({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(2500) }] }],
      }));

      const result = await dashscopeResponsesSearch('q', 'sk-qwen', 'qwen3.8-max', dashscope);

      expect(result).toEqual({ text: 'x'.repeat(2000) + '...(truncated)' });
    });
  });

  describe('execute 路由', () => {
    it('qwen 模型 + qwen key → 原生搜索；失败报错不降级 Tavily', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen-plus', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      process.env.TAVILY_API_KEY = 'tv-key';
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'x' });

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '测试' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('qwen search error: HTTP 500');
      const tavilyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('tavily'));
      expect(tavilyCalls).toHaveLength(0);
    });

    it('qwen 模型 + qwen key → 原生成功返回回答文本（qwen-max 不在搜索白名单，映射 qwen-plus）', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      fetchMock.mockResolvedValue(sseResponse([{ content: '北京今天晴' }]));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '北京天气' });

      expect(result.content).toBe('北京今天晴');
      // 端点经 resolveBaseUrl 解析为 dashscope compatible-mode，且带 /v1
      expect(String(fetchMock.mock.calls[0]![0])).toBe(`${dashscope}/v1/chat/completions`);
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(body.model).toBe('qwen-plus');
    });

    it('注入 deepseek 活动模型 → 走 deepseek 适配器（配置是 qwen 也不影响）', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { deepseek: 'sk-ds' },
      });
      setActiveModel('deepseek-v4-flash');
      fetchMock.mockResolvedValue(okJson({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '北京晴' }] }],
      }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '北京天气' });

      expect(result.content).toBe('北京晴');
      expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.deepseek.com/responses');
    });

    it('注入 qwen3.7-plus 活动模型 → qwen 适配器用活动型号', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      setActiveModel('qwen3.7-plus');
      fetchMock.mockResolvedValue(sseResponse([{ content: '杭州多云' }]));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '杭州天气' });

      expect(result.content).toBe('杭州多云');
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(body.model).toBe('qwen3.7-plus');
    });

    it('活动模型 qwen-turbo（实测不触发真实搜索）→ 映射 qwen-plus 执行搜索', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      setActiveModel('qwen-turbo');
      fetchMock.mockResolvedValue(sseResponse([{ content: '杭州多云' }]));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '杭州天气' });

      expect(result.content).toBe('杭州多云');
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(body.model).toBe('qwen-plus');
    });

    it('活动模型 qwen3.8-max → 走 Responses API 用原模型搜索', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      setActiveModel('qwen3.8-max');
      fetchMock.mockResolvedValue(okJson({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '上海晴' }] }],
      }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '上海天气' });

      expect(result.content).toBe('上海晴');
      expect(String(fetchMock.mock.calls[0]![0])).toBe(`${dashscope}/v1/responses`);
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(body.model).toBe('qwen3.8-max');
      expect(body.tools).toEqual([{ type: 'web_search' }]);
    });

    it('未注入活动模型 + 配置 qwen3.8-max → 走 Responses API 用配置模型', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      fetchMock.mockResolvedValue(okJson({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '广州晴' }] }],
      }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '广州天气' });

      expect(result.content).toBe('广州晴');
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(body.model).toBe('qwen3.8-max');
    });

    it('活动模型 qwen3.7-max → 走 Responses API 用原模型搜索', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      setActiveModel('qwen3.7-max');
      fetchMock.mockResolvedValue(okJson({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '深圳晴' }] }],
      }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '深圳天气' });

      expect(result.content).toBe('深圳晴');
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(body.model).toBe('qwen3.7-max');
    });

    it('活动模型 deepseek-v4-pro-0813（百炼托管）→ 走 DashScope Responses API 用原模型', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { bailian: 'sk-bailian', qwen: 'sk-qwen' },
      });
      setActiveModel('deepseek-v4-pro-0813');
      fetchMock.mockResolvedValue(okJson({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '深圳晴' }] }],
      }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '深圳天气' });

      expect(result.content).toBe('深圳晴');
      expect(String(fetchMock.mock.calls[0]![0])).toBe(`${dashscope}/v1/responses`);
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(body.model).toBe('deepseek-v4-pro-0813');
      expect(body.tools).toEqual([{ type: 'web_search' }]);
    });

    it('qwen3.8-max Responses API 超时 → 回退 qwen-plus Chat Completions 成功', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      setActiveModel('qwen3.8-max');
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      fetchMock
        .mockRejectedValueOnce(timeoutErr)
        .mockResolvedValueOnce(sseResponse([{ content: '深圳案件已开庭' }]));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '深圳保险纠纷' });

      expect(result.content).toBe('深圳案件已开庭');
      expect(String(fetchMock.mock.calls[0]![0])).toBe(`${dashscope}/v1/responses`);
      expect(String(fetchMock.mock.calls[1]![0])).toBe(`${dashscope}/v1/chat/completions`);
      const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as { body: string }).body));
      expect(body.model).toBe('qwen-plus');
    });

    it('qwen3.8-max Responses API 非超时错误（HTTP 500）→ 不回退', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      setActiveModel('qwen3.8-max');
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: 'q' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('qwen search error: HTTP 500');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('外部 abort → 超时不回退 qwen-plus', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'qwen3.8-max', maxTokens: 8192 },
        providerKeys: { qwen: 'sk-qwen' },
      });
      setActiveModel('qwen3.8-max');
      const controller = new AbortController();
      controller.abort();
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      fetchMock.mockRejectedValue(timeoutErr);

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: 'q' }, controller.signal);

      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('qwen 模型但无 qwen key → 走 Tavily', async () => {
      writeGlobalConfig({ model: { baseUrl: '', apiKey: '', model: 'qwen-plus', maxTokens: 8192 } });
      process.env.TAVILY_API_KEY = 'tv-key';
      fetchMock.mockResolvedValue(okJson({ results: [{ title: 'T', url: 'http://x', content: 'c' }] }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '测试' });

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('_(via Tavily)_');
      const tavilyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('tavily'));
      expect(tavilyCalls).toHaveLength(1);
    });

    it('无原生适配器（glm）→ 走 Tavily', async () => {
      writeGlobalConfig({ model: { baseUrl: '', apiKey: '', model: 'glm-4-flash', maxTokens: 8192 } });
      process.env.TAVILY_API_KEY = 'tv-key';
      fetchMock.mockResolvedValue(okJson({ results: [{ title: 'T', url: 'http://x', content: 'c' }] }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '测试' });

      expect(result.content).toContain('_(via Tavily)_');
    });

    it('openai（gpt-5.4）无 key → 文案按 provider 提示 Tavily 且不出现 DEEPSEEK_API_KEY', async () => {
      writeGlobalConfig({ model: { baseUrl: '', apiKey: '', model: 'gpt-5.4', maxTokens: 8192 } });

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '测试' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('no native search adapter for OpenAI (gpt-5.4)');
      expect(result.content).toContain('TAVILY_API_KEY');
      expect(result.content).not.toContain('DEEPSEEK_API_KEY');
    });

    it('deepseek 模型无 key 且无 tavily → 文案含 DEEPSEEK_API_KEY（末段回归锁定）', async () => {
      writeGlobalConfig({ model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 } });

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '测试' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('DEEPSEEK_API_KEY');
      expect(result.content).toContain('TAVILY_API_KEY');
    });

    it('无环境变量时兜底读取 providerKeys.tavily（key 统一解析）', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'glm-4-flash', maxTokens: 8192 },
        providerKeys: { tavily: 'tvly-cfg-key-1234' },
      });
      fetchMock.mockResolvedValue(okJson({ results: [{ title: 'T', url: 'http://x', content: 'c' }] }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '测试' });

      expect(result.content).toContain('_(via Tavily)_');
      const tavilyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('tavily'));
      expect(tavilyCalls).toHaveLength(1);
      const body = JSON.parse(String(tavilyCalls[0]![1]!.body));
      expect(body.api_key).toBe('tvly-cfg-key-1234');
    });

    it('deepseek 原生分支回归：成功返回文本', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
        providerKeys: { deepseek: 'sk-ds' },
      });
      fetchMock.mockResolvedValue(okJson({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '北京晴' }] }],
      }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '北京天气' });

      expect(result.content).toBe('北京晴');
      expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.deepseek.com/responses');
    });

    it('deepseek 原生失败：报错不降级 Tavily', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
        providerKeys: { deepseek: 'sk-ds' },
      });
      process.env.TAVILY_API_KEY = 'tv-key';
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'x' });

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '北京天气' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('DeepSeek search error: HTTP 500');
      const tavilyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('tavily'));
      expect(tavilyCalls).toHaveLength(0);
    });

    it('deepseek 超时后对同 query 重试一次成功', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
        providerKeys: { deepseek: 'sk-ds' },
      });
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      fetchMock
        .mockRejectedValueOnce(timeoutErr)
        .mockResolvedValueOnce(okJson({
          output: [{ type: 'message', content: [{ type: 'output_text', text: '北京晴' }] }],
        }));

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '北京天气' });

      expect(result.content).toBe('北京晴');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('deepseek 超时重试仍失败 → 报错且不降级 Tavily', async () => {
      writeGlobalConfig({
        model: { baseUrl: '', apiKey: '', model: 'deepseek-v4-flash', maxTokens: 8192 },
        providerKeys: { deepseek: 'sk-ds' },
      });
      process.env.TAVILY_API_KEY = 'tv-key';
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      fetchMock.mockRejectedValue(timeoutErr);

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '北京天气' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('DeepSeek search error');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const tavilyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('tavily'));
      expect(tavilyCalls).toHaveLength(0);
    });

    it('无任何 key → unavailable 错误', async () => {
      writeGlobalConfig({ model: { baseUrl: '', apiKey: '', model: 'qwen-plus', maxTokens: 8192 } });

      const tool = getTool('web_search')!;
      const result = await tool.execute({ query: '测试' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Web search unavailable');
    });
  });
});

describe('qwen 搜索白名单漂移守卫（#12）', () => {
  it('CHAT ∪ RESPONSES ⊆ 目录 qwen 模型 且两表互斥', () => {
    const qwenCatalog = MODEL_CATALOG.filter(c => c.provider === 'qwen').map(c => c.model);
    for (const m of [...QWEN_CHAT_SEARCH_MODELS, ...QWEN_RESPONSES_MODELS]) {
      expect(qwenCatalog, `白名单模型 ${m} 不在目录`).toContain(m);
    }
    for (const m of QWEN_CHAT_SEARCH_MODELS) {
      expect(QWEN_RESPONSES_MODELS.has(m), `${m} 同时出现在两个白名单`).toBe(false);
    }
  });

  it('qwenSearchModel：白名单内原模型（chat/responses 分流），名单外回退 qwen-plus', () => {
    expect(qwenSearchModel('qwen-plus')).toEqual({ model: 'qwen-plus', viaResponses: false });
    expect(qwenSearchModel('qwen3.7-plus')).toEqual({ model: 'qwen3.7-plus', viaResponses: false });
    expect(qwenSearchModel('qwen3.8-max')).toEqual({ model: 'qwen3.8-max', viaResponses: true });
    expect(qwenSearchModel('qwen3.7-flash')).toEqual({ model: 'qwen-plus', viaResponses: false });
    expect(qwenSearchModel('qwen-vl-max')).toEqual({ model: 'qwen-plus', viaResponses: false });
  });
});
