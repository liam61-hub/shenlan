/**
 * 会话管理 — 消息列表 + JSONL 落盘
 */
import type { Message } from './provider.js';
import { messageTextOf } from './provider.js';
import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './platform.js';

/** 会话 */
export interface Session {
  id: string;
  createdAt: Date;
  messages: Message[];
  title?: string;
}

/** 会话存储目录（默认用平台数据目录） */
let sessionDir = join(dataDir(), 'sessions');

/**
 * 设置会话存储目录
 */
export function setSessionDir(dir: string): void {
  sessionDir = dir;
}

/**
 * 创建新会话
 */
export function createSession(title?: string): Session {
  return {
    id: generateSessionId(),
    createdAt: new Date(),
    messages: [],
    title,
  };
}

/**
 * 生成会话 id：标准 UUID v4（复制粘贴友好，用户不手输），
 * 并对照已有会话文件做存在性检查，理论上不会撞、撞了自动重试。
 */
function generateSessionId(): string {
  mkdirSync(sessionDir, { recursive: true });
  const existing = new Set(readdirSync(sessionDir));
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    if (!existing.has(`${id}.jsonl`)) return id;
  }
  return randomUUID();
}

/**
 * 添加消息到会话
 */
export function addMessage(session: Session, ...messages: Message[]): void {
  session.messages.push(...messages);
}

/**
 * 将一条消息追加到 JSONL 日志（批量追加 + 节流）
 */
const batchBuffer = new Map<string, string[]>();
let lastFlush = 0;

export function appendToJsonl(session: Session, message: Message): void {
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `${session.id}.jsonl`);

  // 批量缓冲
  if (!batchBuffer.has(session.id)) batchBuffer.set(session.id, []);
  batchBuffer.get(session.id)!.push(JSON.stringify(message));

  // 每 10s 或超过 20 条时刷盘
  const now = Date.now();
  const buf = batchBuffer.get(session.id)!;
  if (buf.length >= 20 || now - lastFlush > 10000) {
    appendFileSync(filePath, buf.join('\n') + '\n', 'utf-8');
    buf.length = 0;
    lastFlush = now;
  }
}

/** 强制刷盘（会话结束时调用） */
export function flushSession(sessionId: string): void {
  const buf = batchBuffer.get(sessionId);
  if (buf && buf.length > 0) {
    const filePath = join(sessionDir, `${sessionId}.jsonl`);
    appendFileSync(filePath, buf.join('\n') + '\n', 'utf-8');
    buf.length = 0;
  }
  batchBuffer.delete(sessionId);
}

/**
 * 全量同步：把当前内存消息列表整体写入 JSONL。
 *
 * 先 flush 批量缓冲（可能含已被替换的旧消息），再截断重写为当前消息，
 * 保证 `--resume <id>` 恢复出的内容与当前对话完全一致。
 * 用于退出兜底、/clear、上下文压缩、配对修复等长度回退/内容变更场景。
 */
export function syncSessionMessages(sessionId: string, messages: Message[]): void {
  flushSession(sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  const content = messages.map((m) => JSON.stringify(m)).join('\n');
  writeFileSync(filePath, content ? content + '\n' : '', 'utf-8');
}

/**
 * 写入会话元数据
 */
export function writeSessionMeta(session: Session, extra?: Record<string, unknown>): void {
  mkdirSync(sessionDir, { recursive: true });
  const metaPath = join(sessionDir, `${session.id}.meta.json`);
  const meta = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    messageCount: session.messages.length,
    ...extra,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * 从 JSONL 文件恢复会话
 */
export function loadSession(sessionId: string): Session | null {
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const messages: Message[] = lines.map((line) => JSON.parse(line));

    return {
      id: sessionId,
      createdAt: new Date(),
      messages,
    };
  } catch {
    return null;
  }
}

/**
 * 列出所有会话
 */
export function listSessions(): Array<{ id: string; createdAt: Date; messageCount: number; title?: string }> {
  if (!existsSync(sessionDir)) return [];

  const files = readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'));

  return files.map((file: string) => {
    const id = file.replace('.jsonl', '');
    const stats = statSync(join(sessionDir, file));
    // 快速统计行数
    const content = readFileSync(join(sessionDir, file), 'utf-8');
    const messageCount = content.trim().split('\n').filter(Boolean).length;

    // 尝试从第一条用户消息提取标题
    let title: string | undefined;
    try {
      const firstLine = content.trim().split('\n')[0];
      const firstMsg = JSON.parse(firstLine);
      if (firstMsg.role === 'user' && firstMsg.content) {
        const text = typeof firstMsg.content === 'string'
          ? firstMsg.content
          : (Array.isArray(firstMsg.content) ? messageTextOf({ content: firstMsg.content }) : '');
        title = text.slice(0, 50);
      }
    } catch {
      // ignore
    }

    return { id, createdAt: stats.birthtime, messageCount, title };
  }).sort((a: { createdAt: Date }, b: { createdAt: Date }) => b.createdAt.getTime() - a.createdAt.getTime());
}
