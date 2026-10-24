/**
 * 首轮图片直传 — @图片 引用展开为 OpenAI 兼容 image_url 内容块
 *
 * 交互（repl）与 headless（run）共用：detectModality 命中 + 当前为视觉模型时，
 * 把输入中的每个 @图片 编码为 data URL，替换最后一条 user 消息的 content 为
 * [文本, ...image_url parts]（qwen-vl-max 官方不支持 Function Calling，
 * 视觉主路径不走工具调用链）。单个图片失败静默跳过，全部失败返回 false。
 */
import type { Message, ContentPart } from '@shenlan/core';
import { IMAGE_MIMES, encodeImageAsDataUrl } from '@shenlan/core';
import { join, extname } from 'node:path';
import { detectModality, isVisionModel } from './router.js';

/** @图片 引用提取（与 injectFileRefs 同款正则，只取图片后缀） */
function imageRefs(input: string): string[] {
  const refs = input.match(/@([^\s]+\.[a-zA-Z0-9]{1,6})(\s|$)/g) || [];
  return refs
    .map((r) => r.slice(1).trim())
    .filter((p) => IMAGE_MIMES[extname(p).toLowerCase()]);
}

/** 首轮直传：成功替换最后一条 user 消息返回 true；无图片/非视觉模型/全部失败返回 false */
export function attachInputImages(
  messages: Message[],
  input: string,
  model: string,
  cwd: string,
): boolean {
  if (detectModality(input) !== 'image' || !isVisionModel(model)) return false;
  const imageParts: ContentPart[] = [];
  for (const filePath of imageRefs(input)) {
    const encoded = encodeImageAsDataUrl(join(cwd, filePath));
    if (encoded.ok) imageParts.push({ type: 'image_url', image_url: { url: encoded.dataUrl } });
  }
  if (imageParts.length === 0) return false;
  const userMsgs = messages.filter((m) => m.role === 'user');
  if (userMsgs.length === 0) return false;
  const last = userMsgs[userMsgs.length - 1]!;
  messages[messages.indexOf(last)] = {
    ...last,
    content: [{ type: 'text', text: input }, ...imageParts],
  };
  return true;
}
