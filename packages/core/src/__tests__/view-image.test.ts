/**
 * view_image 工具 — 图片直传视觉模型（base64 data URL 注入工具结果）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAllTools, getTool, DEFAULT_CONFIG } from '../index.js';

// 1x1 透明 PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('view_image 工具', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-viewimg-'));
    await registerAllTools({ ...DEFAULT_CONFIG });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function tool() {
    return getTool('view_image')!;
  }

  it('工具已注册', () => {
    expect(tool().name).toBe('view_image');
  });

  it('读取图片返回结构化 images 字段（content 只留描述，不含 base64 文本）', async () => {
    const p = join(tmp, 'photo.png');
    writeFileSync(p, PNG_BYTES);
    const result = await tool().execute({ image_path: p });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('photo.png');
    // base64 走 images 结构化字段，不再作为纯文本内嵌 content
    expect(result.content).not.toContain('data:image/png;base64,');
    expect(result.images).toHaveLength(1);
    expect(result.images![0]!.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('文件不存在返回错误', async () => {
    const result = await tool().execute({ image_path: join(tmp, 'nope.png') });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('不支持的后缀返回错误（不读文件）', async () => {
    const p = join(tmp, 'doc.txt');
    writeFileSync(p, 'hello');
    const result = await tool().execute({ image_path: p });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('png/jpg');
  });

  it('缺 image_path 参数返回参数错误', async () => {
    const result = await tool().execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('image_path');
  });
});
