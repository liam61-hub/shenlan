/**
 * API 错误分类 — 解析 provider 返回的 "API error <status>: <body>"，
 * 输出分类 + 可操作提示，repl 错误路径与 headless run 输出统一套用。
 */

export type ApiErrorKind =
  | 'unauthorized'   // 401：密钥无效/已过期
  | 'forbidden'      // 403：权限不足
  | 'quota'          // 402：余额不足
  | 'rate_limited'   // 429：限流
  | 'model_not_found' // 模型不存在
  | 'context_overflow' // 上下文超窗
  | 'network'        // 网络/连接失败
  | 'timeout'        // 请求超时
  | 'unknown';

export interface ApiErrorClass {
  kind: ApiErrorKind;
  /** 分类 + 含掩码原始信息的友好说明 */
  message: string;
  /** 可操作建议 */
  hint: string;
}

/** 掩码：保留尾 4 位，其余用 **** 覆盖（避免在错误输出里泄漏完整密钥） */
function maskTail(raw: string): string {
  const s = raw.trim();
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
}

/** 从错误信息里抽取疑似密钥/令牌片段（401 场景附带掩码结尾便于核对） */
function extractSecret(text: string): string {
  const m = text.match(/[A-Za-z0-9_\-.]{16,}/);
  return m ? maskTail(m[0]) : '';
}

const NETWORK_HINTS = [
  'fetch failed',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  'network',
  'connect',
];

/**
 * 分类 API 错误。可解析 provider.ts 抛出的 `API error <status>: <body>`，
 * 也可处理裸的 fetch/网络错误（超时、DNS、连接拒绝等）。
 */
export function classifyApiError(err: unknown): ApiErrorClass {
  const raw = err instanceof Error ? err.message : String(err);

  // 1. 标准 "API error <status>: <body>"
  const m = raw.match(/^API error\s+(\d{3})\s*:\s*([\s\S]*)$/);
  if (m) {
    const status = Number(m[1]);
    const body = m[2].trim();
    switch (status) {
      case 401: {
        const tail = extractSecret(body);
        return {
          kind: 'unauthorized',
          message: `密钥无效或已过期（401）：${tail ? `…${tail}` : body.slice(0, 200)}`,
          hint: '运行 /keys 重新配置 API Key（或设置对应环境变量）',
        };
      }
      case 402:
        return {
          kind: 'quota',
          message: `账户余额不足（402）：${body.slice(0, 200)}`,
          hint: '请到对应 provider 控制台充值，充值后重试',
        };
      case 403:
        return {
          kind: 'forbidden',
          message: `权限不足（403）：${body.slice(0, 200)}`,
          hint: '检查 key 是否具备该模型的访问权限，或运行 /model 切换模型',
        };
      case 429:
        return {
          kind: 'rate_limited',
          message: `请求限流（429）：${body.slice(0, 200)}`,
          hint: '稍后重试，或检查是否与其他服务共享同一 key/额度',
        };
      default:
        break;
    }
  }

  // 2. 模型不存在（OpenAI 兼容返回的常见措辞）
  if (/model.*(not found|does not exist|not exist|not_found)/i.test(raw)) {
    const mm = raw.match(/["']?([A-Za-z0-9._\-:]+)["']?/);
    return {
      kind: 'model_not_found',
      message: `模型不存在：${mm ? mm[1] : raw.slice(0, 160)}`,
      hint: '运行 /model 从目录中选择可用模型',
    };
  }

  // 3. 上下文超窗（400 + context length 等）
  if (/context.*(length|exceed|limit|too long)|maximum context/i.test(raw)) {
    return {
      kind: 'context_overflow',
      message: `上下文超过模型窗口：${raw.slice(0, 200)}`,
      hint: '运行 /compact 压缩上下文，或 /clear 新开会话',
    };
  }

  // 4. 超时（AbortSignal.timeout / timeout）
  if (/timeout|timed ?out|aborted/i.test(raw)) {
    return {
      kind: 'timeout',
      message: `请求超时：${raw.slice(0, 200)}`,
      hint: '检查网络/代理后重试；如持续超时可降低 maxTokens',
    };
  }

  // 5. 网络层错误
  if (NETWORK_HINTS.some((kw) => raw.toLowerCase().includes(kw.toLowerCase()))) {
    return {
      kind: 'network',
      message: `网络连接失败：${raw.slice(0, 200)}`,
      hint: '检查网络与代理设置（HTTP_PROXY/HTTPS_PROXY）后重试',
    };
  }

  return {
    kind: 'unknown',
    message: raw.slice(0, 400),
    hint: '',
  };
}

/** 完整友好错误文本（message + hint） */
export function formatApiError(err: unknown): string {
  const cls = classifyApiError(err);
  return cls.hint ? `${cls.message} — ${cls.hint}` : cls.message;
}
