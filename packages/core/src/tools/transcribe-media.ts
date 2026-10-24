/**
 * transcribe_media 工具 — 音视频「转写 → 文本」管线（§25：实现可插拔）
 *
 * 默认 runner 走 whisper CLI（本地转写）；runner 可注入（测试/替换实现）。
 * 转写结果作为文本进入上下文，路由到默认文本模型。
 */
import { registerTool } from './index.js';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { expandHome } from './paths.js';

/** 支持的音视频后缀 */
const MEDIA_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.mp4', '.webm', '.mov', '.mkv', '.avi'];

/** 转写结果上限（超出截断，避免上下文爆炸） */
const MAX_TRANSCRIPT_CHARS = 8000;

export interface TranscribeRequest {
  mediaPath: string;
  language: string; // 空 = auto
}

export type TranscribeRunner = (req: TranscribeRequest) => Promise<string>;

let runner: TranscribeRunner | null = null;

/** 注入转写 runner（传 null 恢复默认 whisper CLI） */
export function setTranscribeRunner(r: TranscribeRunner | null): void {
  runner = r;
}

/** 默认 runner：whisper CLI（本地安装；输出 txt 到临时目录后读取）。CLI 启动时注入 */
export async function whisperTranscribeRunner(req: TranscribeRequest): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'shenlan-trans-'));
  try {
    const args = ['--model', 'small', '--output_format', 'txt', '--output_dir', outDir];
    if (req.language && req.language !== 'auto') args.push('--language', req.language);
    args.push(req.mediaPath);
    const res = spawnSync('whisper', args, { encoding: 'utf-8' });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`whisper exited ${res.status}: ${(res.stderr || '').slice(0, 200)}`);
    }
    const stem = req.mediaPath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    const outFile = join(outDir, `${stem}.txt`);
    if (!existsSync(outFile)) {
      // whisper 输出文件名可能带原始扩展名变体，退回目录搜索
      const found = readdirSync(outDir).find((f) => f.endsWith('.txt'));
      if (!found) throw new Error('whisper produced no output file');
      return readFileSync(join(outDir, found), 'utf-8');
    }
    return readFileSync(outFile, 'utf-8');
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

registerTool({
  name: 'transcribe_media',
  description:
    'Transcribe an audio/video file to text (whisper CLI). The transcript is injected as text ' +
    'and routed to the default text model. Use when the user references media that needs transcription.',
  inputSchema: {
    type: 'object',
    properties: {
      media_path: {
        type: 'string',
        description: 'Path to the audio/video file (mp3/wav/m4a/aac/flac/ogg/mp4/webm/mov/mkv/avi)',
      },
      language: {
        type: 'string',
        description: 'Language code for transcription (e.g. zh, en). Omit for auto-detect.',
      },
    },
    required: ['media_path'],
  },
  async execute(params, _signal?) {
    const rawPath = (params.media_path as string) || '';
    if (!rawPath) {
      return { content: 'Missing required parameter: media_path', isError: true };
    }
    const mediaPath = resolve(expandHome(rawPath));
    const ext = extname(mediaPath).toLowerCase();
    if (!MEDIA_EXTS.includes(ext)) {
      return { content: `Unsupported media type "${ext || '(none)'}" — supported: ${MEDIA_EXTS.join('/')}`, isError: true };
    }
    if (!existsSync(mediaPath)) {
      return { content: `Media file not found: ${mediaPath}`, isError: true };
    }

    const run = runner;
    if (!run) {
      return { content: 'transcribe_media not configured: set a transcribe runner (whisper CLI not installed?)', isError: true };
    }
    try {
      const transcript = await run({ mediaPath, language: (params.language as string) || 'auto' });
      const truncated = transcript.length > MAX_TRANSCRIPT_CHARS
        ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n...(truncated)'
        : transcript;
      return { content: `Transcript (${mediaPath.split(/[\\/]/).pop()}):\n\n${truncated}` };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const hint = e.code === 'ENOENT'
        ? 'whisper CLI not found — install it (e.g. pip install openai-whisper) or configure a custom transcribe runner'
        : (e.message || 'unknown error');
      return { content: `Transcription failed: ${hint}`, isError: true };
    }
  },
});
