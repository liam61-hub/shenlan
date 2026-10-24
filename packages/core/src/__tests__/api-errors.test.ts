import { describe, expect, it } from 'vitest';
import { classifyApiError, formatApiError } from '../api-errors.js';

describe('classifyApiError — API 错误分类表', () => {
  it('401 密钥无效：分类 unauthorized，提示 /keys，含掩码结尾', () => {
    const cls = classifyApiError(
      new Error('API error 401: Invalid API key sk-abcdefghijklmnopqrstuvwxyz123456'),
    );
    expect(cls.kind).toBe('unauthorized');
    expect(cls.hint).toContain('/keys');
    // 掩码只保留尾 4，不泄露完整 key
    expect(cls.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(cls.message).toContain('3456');
  });

  it('402 余额不足', () => {
    const cls = classifyApiError(new Error('API error 402: Insufficient balance'));
    expect(cls.kind).toBe('quota');
    expect(cls.hint).toContain('充值');
  });

  it('403 权限不足', () => {
    const cls = classifyApiError(new Error('API error 403: Forbidden'));
    expect(cls.kind).toBe('forbidden');
    expect(cls.hint).toContain('/model');
  });

  it('429 限流：提示稍后重试', () => {
    const cls = classifyApiError(new Error('API error 429: Too many requests'));
    expect(cls.kind).toBe('rate_limited');
    expect(cls.hint).toContain('稍后重试');
  });

  it('模型不存在：分类 model_not_found，提示 /model', () => {
    const cls = classifyApiError(
      new Error('API error 404: Model "deepseek-v99" not found'),
    );
    expect(cls.kind).toBe('model_not_found');
    expect(cls.hint).toContain('/model');
  });

  it('上下文超窗', () => {
    const cls = classifyApiError(
      new Error('API error 400: This model maximum context length is 128000 tokens'),
    );
    expect(cls.kind).toBe('context_overflow');
    expect(cls.hint).toContain('/compact');
  });

  it('超时：分类 timeout，提示检查网络', () => {
    const cls = classifyApiError(new Error('The operation was aborted due to timeout'));
    expect(cls.kind).toBe('timeout');
    expect(cls.hint).toContain('网络');
  });

  it('网络错误：分类 network，提示检查代理', () => {
    const cls = classifyApiError(new Error('fetch failed: ENOTFOUND api.deepseek.com'));
    expect(cls.kind).toBe('network');
    expect(cls.hint).toContain('代理');
  });

  it('未知错误：原样 message，无 hint', () => {
    const cls = classifyApiError(new Error('some weird thing happened'));
    expect(cls.kind).toBe('unknown');
    expect(cls.message).toContain('some weird thing happened');
    expect(cls.hint).toBe('');
  });
});

describe('formatApiError', () => {
  it('拼接 message 与 hint', () => {
    const text = formatApiError(new Error('API error 401: Invalid API key sk-abcdefghijklmnopqrstuvwxyz123456'));
    expect(text).toContain('—');
    expect(text).toContain('/keys');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });
});
