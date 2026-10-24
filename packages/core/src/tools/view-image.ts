/**
 * view_image 工具 — 图片直传视觉模型（§25：图片直传 Qwen-VL 的前置工具）
 *
 * 读取图片文件编码为 base64 data URL，经工具结果的 images 结构化字段
 * 在消息组装时展开为 image_url 内容块（content 只留描述文本，避免把
 * 十几 MB 的 base64 当纯文本塞给非视觉模型）。会话中途补图走本工具；
 * 首轮 @图片 由 CLI 直传（detectModality 路由 + attachInputImages），
 * 不需要经过工具调用链（qwen-vl-max 官方标注不支持 Function Calling）。
 */
import { registerTool } from './index.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { expandHome } from './paths.js';

/** 支持的图片后缀 → MIME（CLI 直传与工具共用） */
export const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 单图大小上限（10MB，超出拒绝避免上下文爆炸） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 图片文件编码为 base64 data URL（ext/mime 校验、存在性、10MB 上限的单一实现，
 * view_image 工具与 CLI 首轮直传共用）。
 */
export function encodeImageAsDataUrl(filePath: string): { ok: true; dataUrl: string; name: string; sizeKB: number } | { ok: false; error: string } {
  const resolved = resolve(expandHome(filePath));
  const ext = extname(resolved).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) {
    return { ok: false, error: `Unsupported image type "${ext || '(none)'}" — supported: png/jpg/jpeg/webp/gif/bmp` };
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `Image not found: ${resolved}` };
  }
  const size = statSync(resolved).size;
  if (size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Image too large: ${Math.round(size / 1024 / 1024)}MB (max 10MB)` };
  }
  const data = readFileSync(resolved).toString('base64');
  const name = resolved.split(/[\\/]/).pop();
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${data}`,
    name: name || resolved,
    sizeKB: Math.round(size / 1024),
  };
}

registerTool({
  name: 'view_image',
  description:
    'Read an image file and make it visible to the model (base64 data URL carried in the structured images field). ' +
    'Use when the user references an image (e.g. @photo.png) and visual analysis is needed. ' +
    'Requires a vision-capable model (e.g. qwen-vl); on text-only models the image is ignored.',
  inputSchema: {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: 'Path to the image file (png/jpg/jpeg/webp/gif/bmp)',
      },
    },
    required: ['image_path'],
  },
  async execute(params, _signal?) {
    const rawPath = (params.image_path as string) || '';
    if (!rawPath) {
      return { content: 'Missing required parameter: image_path', isError: true };
    }
    const encoded = encodeImageAsDataUrl(rawPath);
    if (!encoded.ok) {
      return { content: encoded.error, isError: true };
    }
    return {
      content: `Image loaded: ${encoded.name} (${encoded.sizeKB}KB)`,
      images: [encoded.dataUrl],
    };
  },
});
