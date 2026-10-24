/**
 * attachInputImages — 首轮图片直传 + injectFileRefs 图片排除
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@shenlan/core';
import { attachInputImages } from '../image-input.js';
import { injectFileRefs } from '../repl.js';

// 1x1 透明 PNG（与 view-image.test.ts 同款）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('attachInputImages — 首轮图片直传', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-imginput-'));
    writeFileSync(join(tmp, 'photo.png'), PNG_BYTES);
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('视觉模型 + @图片 → 最后 user 消息展开为 text + image_url 内容块', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '看下这张图 @photo.png' },
    ];
    const ok = attachInputImages(messages, '看下这张图 @photo.png', 'qwen-vl-max', tmp);
    expect(ok).toBe(true);
    const parts = messages[1]!.content as Array<{ type: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: '看下这张图 @photo.png' });
    const img = parts[1] as unknown as { image_url: { url: string } };
    expect(img.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('非视觉模型 → 不展开，消息原样', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '看下这张图 @photo.png' },
    ];
    const ok = attachInputImages(messages, '看下这张图 @photo.png', 'deepseek-v4-flash', tmp);
    expect(ok).toBe(false);
    expect(messages[1]!.content).toBe('看下这张图 @photo.png');
  });

  it('图片文件不存在 → 全部失败返回 false', () => {
    const messages: Message[] = [{ role: 'user', content: '看图 @missing.png' }];
    const ok = attachInputImages(messages, '看图 @missing.png', 'qwen-vl-max', tmp);
    expect(ok).toBe(false);
    expect(messages[0]!.content).toBe('看图 @missing.png');
  });

  it('输入无图片 → 返回 false 不展开', () => {
    const messages: Message[] = [{ role: 'user', content: '帮我写代码' }];
    const ok = attachInputImages(messages, '帮我写代码', 'qwen-vl-max', tmp);
    expect(ok).toBe(false);
  });
});

describe('injectFileRefs — 图片引用排除', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-imginput-'));
    writeFileSync(join(tmp, 'photo.png'), PNG_BYTES);
    writeFileSync(join(tmp, 'readme.txt'), 'hello file content');
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('@图片 不注入文本（防止二进制乱码进上下文）', () => {
    const out = injectFileRefs('看下这张图 @photo.png', tmp);
    expect(out).not.toContain('--- @photo.png ---');
    // @原文保留（模型据此调 view_image / 直传）
    expect(out).toContain('@photo.png');
  });

  it('普通文本文件仍照常注入', () => {
    const out = injectFileRefs('读一下 @readme.txt', tmp);
    expect(out).toContain('--- @readme.txt ---');
    expect(out).toContain('hello file content');
  });
});
