/**
 * transcribe_media 工具 — 音视频转写管线（runner 可插拔）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAllTools, getTool, DEFAULT_CONFIG } from '../index.js';
import { setTranscribeRunner } from '../tools/transcribe-media.js';

describe('transcribe_media 工具', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-trans-'));
    setTranscribeRunner(null);
    await registerAllTools({ ...DEFAULT_CONFIG });
  });

  afterEach(() => {
    setTranscribeRunner(null);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function tool() {
    return getTool('transcribe_media')!;
  }

  it('工具已注册', () => {
    expect(tool().name).toBe('transcribe_media');
  });

  it('runner 注入：转写结果以文本进入上下文（截断 8000 字符）', async () => {
    const p = join(tmp, 'a.mp3');
    writeFileSync(p, 'x');
    setTranscribeRunner(async ({ mediaPath, language }) => {
      expect(mediaPath).toBe(p);
      expect(language).toBe('zh');
      return '这是转写出来的文本内容。';
    });
    const result = await tool().execute({ media_path: p, language: 'zh' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('这是转写出来的文本内容');
  });

  it('runner 失败：返回清晰错误（含安装提示）', async () => {
    const p = join(tmp, 'a.mp3');
    writeFileSync(p, 'x');
    setTranscribeRunner(async () => {
      const err = new Error('whisper not found');
      (err as any).code = 'ENOENT';
      throw err;
    });
    const result = await tool().execute({ media_path: p });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('whisper');
  });

  it('未注入 runner：返回未配置错误', async () => {
    const p = join(tmp, 'a.mp3');
    writeFileSync(p, 'x');
    const result = await tool().execute({ media_path: p });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not configured');
  });

  it('文件不存在返回错误', async () => {
    const result = await tool().execute({ media_path: join(tmp, 'nope.mp3') });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('不支持的后缀返回错误', async () => {
    const p = join(tmp, 'a.txt');
    writeFileSync(p, 'x');
    const result = await tool().execute({ media_path: p });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('mp3');
  });

  it('缺 media_path 参数返回参数错误', async () => {
    const result = await tool().execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('media_path');
  });
});
