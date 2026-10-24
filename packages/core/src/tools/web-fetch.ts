/**
 * web_fetch — 抓取网页并提取可读文本
 *
 * 对齐 Codex / Claude Code 的网页抓取工具：
 * 仅允许 http/https；跟随重定向；非 2xx 返回错误；
 * 成功时剥离 script/style 与 HTML 标签、折叠空行，截断到 8000 字符。
 */
import { registerTool } from './index.js';
import type { ToolResult } from './index.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 8_000;
const RETRY_DELAY_MS = 500;

/** 瞬时网络错误（cause code）：可自动重试一次 */
const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR', // 我方 20s 超时（AbortSignal.timeout 触发）
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** cause code → 中文提示（错误可观测性：不再只有笼统的 fetch failed） */
const CAUSE_HINTS: Record<string, string> = {
  ETIMEDOUT: '网络超时：目标站点可能不可达或响应过慢（20s 超时），可稍后重试',
  ABORT_ERR: '网络超时：目标站点可能不可达或响应过慢（20s 超时），可稍后重试',
  UND_ERR_CONNECT_TIMEOUT: '连接超时：目标站点可能不可达或响应过慢，可稍后重试',
  UND_ERR_HEADERS_TIMEOUT: '响应头超时：服务端响应缓慢，可稍后重试',
  ECONNRESET: '连接被重置：目标站点或网络中途断开，可能瞬时抖动',
  ECONNREFUSED: '连接被拒绝：目标站点拒绝访问或端口未开放',
  ENOTFOUND: 'DNS 解析失败：域名不存在或本地 DNS 异常',
  EAI_AGAIN: 'DNS 解析超时：本地 DNS 暂不可用',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书校验失败：可能需要代理访问或系统信任该证书',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书校验失败（自签证书）：可能需要代理访问或系统信任该证书',
};

/** 提取 undici 错误的 cause 链（code/message） */
function networkCause(err: unknown): { code: string; message: string } | null {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === 'string') {
    return { code: cause.code, message: typeof cause.message === 'string' ? cause.message : '' };
  }
  return null;
}

/** 从 HTML 提取可读文本：去 script/style、去标签、折叠空白行 */
export function extractPageText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = withoutScripts
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

registerTool({
  name: 'web_fetch',
  description:
    'Fetch a web page and return its readable text content. Only http/https URLs are allowed; non-2xx responses and network errors are reported as failures.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'HTTP(S) URL to fetch, e.g. https://example.com/page',
      },
    },
    required: ['url'],
  },
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const url = String(params.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return {
        content: `Failed to fetch ${url}: only http/https URLs are supported`,
        isError: true,
      };
    }

    // 每次尝试独立的超时信号（重试时上一个超时信号已 aborted，不能复用）
    const attempt = (): Promise<Response> => {
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      return fetch(url, { signal: merged });
    };

    try {
      let resp: Response;
      try {
        resp = await attempt();
      } catch (err) {
        // 瞬时网络错误自动重试一次（HTTP 层错误不重试；用户中止不重试）
        const nc = networkCause(err);
        if (nc && RETRYABLE_NETWORK_CODES.has(nc.code) && !signal?.aborted) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          resp = await attempt();
        } else {
          throw err;
        }
      }
      if (!resp.ok) {
        return {
          content: `Failed to fetch ${url}: HTTP ${resp.status}`,
          isError: true,
        };
      }

      const html = await resp.text();
      let text = extractPageText(html);
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS) + '...(truncated)';
      }
      return { content: text || '(no content)' };
    } catch (err) {
      const nc = networkCause(err);
      const codeSuffix = nc ? ` (${nc.code})` : '';
      const hint = nc && CAUSE_HINTS[nc.code] ? ` — ${CAUSE_HINTS[nc.code]}` : '';
      const msg = (err as Error).message || String(err);
      return { content: `Failed to fetch ${url}: ${msg}${codeSuffix}${hint}`, isError: true };
    }
  },
});
