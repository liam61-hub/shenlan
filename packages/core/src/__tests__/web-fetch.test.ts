import { describe, expect, it, afterEach, vi } from 'vitest';
import '../tools/web-fetch.js';
import { getTool } from '../tools/index.js';
import type { Tool } from '../tools/index.js';

let tool: Tool;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
  tool = getTool('web_fetch')!;
  vi.stubGlobal('fetch', impl);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web_fetch 工具', () => {
  it('成功：剥离 script/style 与 HTML 标签，折叠空行', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => [
        '<html><head>',
        '<script>const x = 1;</script>',
        '<style>body { color: red }</style>',
        '</head><body>',
        '<h1>Title</h1>',
        '<p>Hello world</p>',
        '<p></p>',
        '<p>Second paragraph</p>',
        '</body></html>',
      ].join('\n'),
    }));

    const res = await tool.execute({ url: 'https://example.com/page' });

    expect(res.isError).toBeUndefined();
    expect(res.content).toBe('Title\nHello world\nSecond paragraph');
    expect(res.content).not.toContain('<script>');
    expect(res.content).not.toContain('<style>');
    expect(res.content).not.toContain('const x');
    expect(res.content).not.toContain('color: red');
  });

  it('非 2xx 返回错误（isError + HTTP 状态）', async () => {
    stubFetch(async () => ({ ok: false, status: 404, text: async () => 'not found' }));

    const res = await tool.execute({ url: 'https://example.com/missing' });

    expect(res.isError).toBe(true);
    expect(res.content).toBe('Failed to fetch https://example.com/missing: HTTP 404');
  });

  it('非 http(s) scheme 拒绝', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return { ok: true, status: 200, text: async () => 'x' };
    });

    const res = await tool.execute({ url: 'file:///etc/passwd' });

    expect(called).toBe(false);
    expect(res.isError).toBe(true);
    expect(res.content).toBe('Failed to fetch file:///etc/passwd: only http/https URLs are supported');
  });

  it('超时 reject 返回错误', async () => {
    stubFetch(async () => {
      throw Object.assign(
        new Error('The operation was aborted due to timeout'),
        { name: 'TimeoutError' },
      );
    });

    const res = await tool.execute({ url: 'https://example.com/slow' });

    expect(res.isError).toBe(true);
    expect(res.content).toContain('Failed to fetch https://example.com/slow:');
    expect(res.content).toContain('timeout');
  });

  it('超长内容截断到 8000 字符并追加 ...(truncated)', async () => {
    const longText = 'word '.repeat(3000); // 15000 chars
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => `<html><body><p>${longText}</p></body></html>`,
    }));

    const res = await tool.execute({ url: 'https://example.com/long' });

    expect(res.isError).toBeUndefined();
    expect(res.content!.length).toBe(8000 + '...(truncated)'.length);
    expect(res.content!.endsWith('...(truncated)')).toBe(true);
  });

  it('空内容返回 (no content)', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body></body></html>',
    }));

    const res = await tool.execute({ url: 'https://example.com/empty' });

    expect(res.content).toBe('(no content)');
  });

  it('网络错误带 cause code 与超时提示（ETIMEDOUT）', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    });
    const res = await tool.execute({ url: 'https://example.com' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('ETIMEDOUT');
    expect(res.content).toContain('超时');
  });

  it('证书类错误提示代理/证书（UNABLE_TO_VERIFY_LEAF_SIGNATURE）', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
    });
    const res = await tool.execute({ url: 'https://example.com' });
    expect(res.content).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(res.content).toContain('证书');
  });

  it('无 cause 的错误原样兜底', async () => {
    stubFetch(async () => {
      throw new Error('fetch failed');
    });
    const res = await tool.execute({ url: 'https://example.com' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('fetch failed');
  });

  it('瞬时网络错误（ECONNRESET）自动重试一次成功', async () => {
    const calls: unknown[] = [];
    stubFetch(async () => {
      calls.push(1);
      if (calls.length === 1) {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      }
      return {
        ok: true,
        status: 200,
        text: async () => '<html><body>retry ok</body></html>',
      };
    });
    const res = await tool.execute({ url: 'https://example.com' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('retry ok');
    expect(calls).toHaveLength(2);
  });

  it('HTTP 4xx 不重试', async () => {
    const calls: unknown[] = [];
    stubFetch(async () => {
      calls.push(1);
      return { ok: false, status: 404, text: async () => 'not found' };
    });
    const res = await tool.execute({ url: 'https://example.com/missing' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
