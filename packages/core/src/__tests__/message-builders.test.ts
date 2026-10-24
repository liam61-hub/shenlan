/**
 * messageTextOf / toolResultToMessages — 多模态消息组装助手
 */
import { describe, it, expect } from 'vitest';
import { messageTextOf, toolResultToMessages } from '../index.js';
import type { Message } from '../index.js';

describe('messageTextOf — 多模态 content 纯文本提取', () => {
  it('string 原样返回', () => {
    expect(messageTextOf({ content: '你好' })).toBe('你好');
  });

  it('null 返回空串', () => {
    expect(messageTextOf({ content: null })).toBe('');
  });

  it('ContentPart[] 拼接 text 块，图片以占位表示', () => {
    const text = messageTextOf({
      content: [
        { type: 'text', text: '看图：' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: ' 描述它' },
      ],
    });
    expect(text).toContain('看图：');
    expect(text).toContain('[图片: data:image/png;base64,AAAA]');
    expect(text).toContain(' 描述它');
  });

  it('超长 data URL 占位截断到 80 字符', () => {
    const longUrl = 'data:image/png;base64,' + 'A'.repeat(200);
    const text = messageTextOf({
      content: [{ type: 'image_url', image_url: { url: longUrl } }],
    });
    expect(text).toContain('[图片:');
    expect(text).toContain('…]');
    expect(text.length).toBeLessThan(longUrl.length);
  });
});

describe('ContentPart 持久化兼容', () => {
  it('JSON.stringify 后可往返（会话 JSONL 存取）', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: '图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    };
    const round = JSON.parse(JSON.stringify(msg)) as Message;
    expect(round.content).toEqual(msg.content);
    expect(messageTextOf(round)).toContain('[图片:');
  });
});

describe('toolResultToMessages — 工具结果展开', () => {
  it('视觉模型 + 图片：tool 文本消息 + 含 image_url 的 user 消息', () => {
    const msgs = toolResultToMessages({
      toolName: 'view_image',
      toolCallId: 'call_1',
      content: 'Image loaded: photo.png (1KB)',
      images: ['data:image/png;base64,AAAA'],
      modelVision: true,
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'view_image',
      content: 'Image loaded: photo.png (1KB)',
    });
    expect(msgs[1]!.role).toBe('user');
    const parts = msgs[1]!.content as Array<{ type: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: '[图片已由 view_image 载入，见下]' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });

  it('非视觉模型：仅 tool 文本消息，images 静默丢弃', () => {
    const msgs = toolResultToMessages({
      toolName: 'view_image',
      toolCallId: 'call_1',
      content: 'Image loaded: photo.png (1KB)',
      images: ['data:image/png;base64,AAAA'],
      modelVision: false,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('tool');
  });

  it('无图片：任何模型都只返回 tool 文本消息', () => {
    const msgs = toolResultToMessages({
      toolName: 'read',
      toolCallId: 'call_2',
      content: 'file content',
      modelVision: true,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('tool');
  });
});
