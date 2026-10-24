/**
 * 消息组装助手 — tool 结果 → 对话消息（含多模态图片展开）
 *
 * view_image 等工具把图片以 data URL 放在 ToolResult.images 结构化字段，
 * 这里在落消息时展开为 OpenAI 格式的 image_url 内容块；非视觉模型静默丢弃
 * images（纯文本 API 收到 image_url 会 400）。
 */
import type { Message, ContentPart } from './provider.js';

/**
 * tool 结果 → 消息序列：
 *  - 恒返回第 1 条 role:'tool' 文本消息（与上方 assistant(tool_calls) 配对）
 *  - 视觉模型且带图片时追加第 2 条 role:'user' 消息，content 为
 *    [文本说明, ...image_url parts]（OpenAI 兼容视觉协议）
 */
export function toolResultToMessages(params: {
  toolName: string;
  toolCallId: string;
  content: string;
  images?: string[];
  modelVision: boolean;
}): Message[] {
  const messages: Message[] = [{
    role: 'tool',
    tool_call_id: params.toolCallId,
    name: params.toolName,
    content: params.content,
  }];
  if (params.modelVision && params.images && params.images.length > 0) {
    const parts: ContentPart[] = [
      { type: 'text', text: `[图片已由 ${params.toolName} 载入，见下]` },
      ...params.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ];
    messages.push({ role: 'user', content: parts });
  }
  return messages;
}
