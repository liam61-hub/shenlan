/**
 * provider 协议层 — 请求体组装（max_tokens/max_completion_tokens 家族映射、多模态透传）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chat, chatStream, maxTokensFieldFor } from '../provider.js';
import type { Message, StreamCallbacks } from '../provider.js';
import type { ModelConfig } from '../config.js';

const cfg = (model: string): ModelConfig => ({
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model,
  maxTokens: 8192,
});

function lastBody(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const url = mock.mock.calls[0][0] as string;
  expect(url).toContain('/v1/chat/completions');
  return JSON.parse(mock.mock.calls[0][1].body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('maxTokensFieldFor — 模型家族参数名映射', () => {
  it('o 系列（o1/o3/o4）→ max_completion_tokens', () => {
    expect(maxTokensFieldFor('o1')).toBe('max_completion_tokens');
    expect(maxTokensFieldFor('o1-pro')).toBe('max_completion_tokens');
    expect(maxTokensFieldFor('o3-mini')).toBe('max_completion_tokens');
    expect(maxTokensFieldFor('o4')).toBe('max_completion_tokens');
  });

  it('gpt-5.x / deepseek / qwen 系 → max_tokens', () => {
    expect(maxTokensFieldFor('gpt-5.4')).toBe('max_tokens');
    expect(maxTokensFieldFor('gpt-5.4-mini')).toBe('max_tokens');
    expect(maxTokensFieldFor('deepseek-v4-flash')).toBe('max_tokens');
    expect(maxTokensFieldFor('qwen-vl-max')).toBe('max_tokens');
  });
});

describe('chat — 请求体组装', () => {
  it('o 系列模型请求体含 max_completion_tokens 且不含 max_tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'x', model: 'o3-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await chat(cfg('o3-mini'), [{ role: 'user', content: 'hi' }]);
    const body = lastBody(fetchMock);
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.max_tokens).toBeUndefined();
  });

  it('gpt-5.4 请求体含 max_tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'x', model: 'gpt-5.4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await chat(cfg('gpt-5.4'), [{ role: 'user', content: 'hi' }]);
    const body = lastBody(fetchMock);
    expect(body.max_tokens).toBe(8192);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('多模态 ContentPart[] 原样序列化透传（直传协议正确性）', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'x', model: 'qwen-vl-max',
      choices: [{ index: 0, message: { role: 'assistant', content: '一张图' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await chat(cfg('qwen-vl-max'), [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }]);
    const body = lastBody(fetchMock);
    const parts = (body.messages as Array<{ content: unknown }>)[0]!.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: '看图' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });
});

describe('chatStream — 请求体组装', () => {
  it('工具 schema 与 tool_choice=auto 保持现状，o 系列走 max_completion_tokens', async () => {
    const fetchMock = vi.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const callbacks: StreamCallbacks = {
      onToken: () => {},
      onComplete: () => {},
      onError: () => {},
    };
    await chatStream(cfg('o3-mini'), [{ role: 'user', content: 'hi' }], [{
      name: 'read',
      description: 'read file',
      parameters: { type: 'object', properties: {} },
    }], callbacks);

    const body = lastBody(fetchMock);
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toHaveLength(1);
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.max_tokens).toBeUndefined();
  });

  it('请求 stream_options.include_usage 以回传 usage（诊断空回复必需）', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    await chatStream(cfg('deepseek-v4-flash'), [{ role: 'user', content: 'hi' }], undefined, {
      onToken: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    expect(lastBody(fetchMock).stream_options).toEqual({ include_usage: true });
  });
});

/** 用若干 SSE 行构造一个流式响应 */
function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

describe('chatStream — 思考流（reasoning_content）处理', () => {
  it('reasoning_content 不污染 content：仅思考无正文时 message.content 为空', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      chunk({ reasoning_content: '让我想想…' }),
      chunk({ reasoning_content: '再想想…' }, 'length'),
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    let out: Message | undefined;
    await chatStream(cfg('deepseek-v4-flash'), [{ role: 'user', content: 'hi' }], undefined, {
      onToken: () => { throw new Error('reasoning 不应触发 onToken'); },
      onComplete: (m) => { out = m; },
      onError: (e) => { throw e; },
    });

    expect(out?.content).toBeNull();
    expect(out?.tool_calls).toBeUndefined();
  });

  it('思考 + 正文同时出现时，只有正文进入 message.content', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      chunk({ reasoning_content: '内部推理' }),
      chunk({ content: '最终' }),
      chunk({ content: '回答' }, 'stop'),
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    let out: Message | undefined;
    await chatStream(cfg('deepseek-v4-flash'), [{ role: 'user', content: 'hi' }], undefined, {
      onToken: () => {},
      onComplete: (m) => { out = m; },
      onError: (e) => { throw e; },
    });

    expect(out?.content).toBe('最终回答');
  });
});
