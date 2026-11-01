/**
 * 会话管理 — 消息列表 + JSONL 落盘
 */
import type { Message } from './provider.js';
import { messageTextOf } from './provider.js';
import { sanitizeMessagePairing } from './compression.js';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './platform.js';

/** 会话 */
export interface Session {
  id: string;
  createdAt: Date;
  messages: Message[];
  title?: string;
  projectPath?: string;
  recovery?: {
    kind: 'truncated-tail' | 'corrupt-record' | 'invalid-message' | 'incomplete-tool-pair';
    line: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContentPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  return value.type === 'image_url'
    && isRecord(value.image_url)
    && typeof value.image_url.url === 'string';
}

function isToolCall(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'function' || typeof value.id !== 'string' || !value.id) return false;
  if (!isRecord(value.function)) return false;
  return typeof value.function.name === 'string'
    && value.function.name.length > 0
    && typeof value.function.arguments === 'string';
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  if (!['system', 'user', 'assistant', 'tool'].includes(String(value.role))) return false;
  if (value.content !== null && typeof value.content !== 'string') {
    if (!Array.isArray(value.content) || !value.content.every(isContentPart)) return false;
  }
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  if (value.tool_calls !== undefined) {
    if (value.role !== 'assistant' || !Array.isArray(value.tool_calls) || !value.tool_calls.every(isToolCall)) return false;
  }
  if (value.tool_call_id !== undefined) {
    if (value.role !== 'tool' || typeof value.tool_call_id !== 'string' || !value.tool_call_id) return false;
  }
  return value.role !== 'tool' || typeof value.tool_call_id === 'string' && value.tool_call_id.length > 0;
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
export function createSession(title?: string, projectPath?: string): Session {
  return {
    id: generateSessionId(),
    createdAt: new Date(),
    messages: [],
    title,
    ...(projectPath ? { projectPath } : {}),
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
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SESSION_FLUSH_INTERVAL_MS = 10_000;

function clearFlushTimer(sessionId: string): void {
  const timer = flushTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  flushTimers.delete(sessionId);
}

function scheduleSessionFlush(sessionId: string): void {
  if (flushTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    flushTimers.delete(sessionId);
    flushSession(sessionId);
  }, SESSION_FLUSH_INTERVAL_MS);
  timer.unref?.();
  flushTimers.set(sessionId, timer);
}

export function appendToJsonl(session: Session, message: Message): void {
  mkdirSync(sessionDir, { recursive: true });

  // 批量缓冲
  if (!batchBuffer.has(session.id)) batchBuffer.set(session.id, []);
  batchBuffer.get(session.id)!.push(JSON.stringify(message));

  const buf = batchBuffer.get(session.id)!;
  if (buf.length >= 20) flushSession(session.id);
  else scheduleSessionFlush(session.id);
}

/** 强制刷盘（会话结束时调用） */
export function flushSession(sessionId: string): void {
  clearFlushTimer(sessionId);
  const buf = batchBuffer.get(sessionId);
  if (buf && buf.length > 0) {
    const filePath = join(sessionDir, `${sessionId}.jsonl`);
    appendFileSync(filePath, buf.join('\n') + '\n', 'utf-8');
    buf.length = 0;
  }
  batchBuffer.delete(sessionId);
}

/** Flush every buffered session and cancel all pending low-traffic timers. */
export function flushAllSessions(): void {
  const sessionIds = new Set([...batchBuffer.keys(), ...flushTimers.keys()]);
  for (const sessionId of sessionIds) clearFlushTimer(sessionId);

  const errors: unknown[] = [];
  for (const sessionId of sessionIds) {
    try {
      flushSession(sessionId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Failed to flush one or more sessions');
}

function writeAtomicCheckpoint(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original error */ }
    }
    try { unlinkSync(tempPath); } catch { /* a process crash may leave a temp file */ }
    throw err;
  }
}

/**
 * 全量同步：把当前内存消息列表整体写入 JSONL。
 *
 * 先 flush 批量缓冲（可能含已被替换的旧消息），再原子替换为当前消息，
 * 保证 `--resume <id>` 恢复出的内容与当前对话完全一致。
 * 用于退出兜底、/clear、上下文压缩、配对修复等长度回退/内容变更场景。
 */
export function syncSessionMessages(sessionId: string, messages: Message[]): void {
  flushSession(sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  const content = messages.map((m) => JSON.stringify(m)).join('\n');
  writeAtomicCheckpoint(filePath, content ? content + '\n' : '');
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
    projectPath: session.projectPath,
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
  if (!isSessionId(sessionId)) return null;
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const messages: Message[] = [];
    let recovery: Session['recovery'];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isMessage(parsed)) {
          recovery = { kind: 'invalid-message', line: i + 1 };
          break;
        }
        messages.push(parsed);
      } catch {
        const hasLaterRecord = lines.slice(i + 1).some((remaining) => remaining.trim().length > 0);
        recovery = { kind: hasLaterRecord ? 'corrupt-record' : 'truncated-tail', line: i + 1 };
        break;
      }
    }

    const pairedMessages = sanitizeMessagePairing(messages);
    if (pairedMessages.length !== messages.length) {
      const retained = new Set(pairedMessages);
      const firstDropped = messages.findIndex((message) => !retained.has(message));
      const droppedMessage = messages[firstDropped];
      const kind = droppedMessage?.role === 'assistant'
        && !droppedMessage.tool_calls?.length
        && !droppedMessage.content
        ? 'invalid-message'
        : 'incomplete-tool-pair';
      if (!recovery || firstDropped + 1 < recovery.line) {
        recovery = { kind, line: firstDropped + 1 };
      }
    }

    const projectPath = readSessionProjectPath(sessionId);
    return {
      id: sessionId,
      createdAt: new Date(),
      messages: pairedMessages,
      ...(projectPath ? { projectPath } : {}),
      ...(recovery ? { recovery } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 列出所有会话
 */
export function listSessions(): Array<{ id: string; createdAt: Date; messageCount: number; title?: string; projectPath?: string }> {
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

    const projectPath = readSessionProjectPath(id);
    return { id, createdAt: stats.birthtime, messageCount, title, ...(projectPath ? { projectPath } : {}) };
  }).sort((a: { createdAt: Date }, b: { createdAt: Date }) => b.createdAt.getTime() - a.createdAt.getTime());
}

function isSessionId(sessionId: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(sessionId);
}

function readSessionProjectPath(sessionId: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(sessionDir, `${sessionId}.meta.json`), 'utf-8')) as unknown;
    if (!isRecord(meta) || meta.id !== sessionId || typeof meta.projectPath !== 'string' || !meta.projectPath.trim()) {
      return undefined;
    }
    return meta.projectPath;
  } catch {
    return undefined;
  }
}
