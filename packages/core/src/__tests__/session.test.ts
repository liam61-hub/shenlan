import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setSessionDir,
  createSession,
  appendToJsonl,
  flushSession,
  syncSessionMessages,
  writeSessionMeta,
  loadSession,
  listSessions,
} from '../session.js';
import type { Message } from '../provider.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shenlan-session-test-'));
  setSessionDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const msg = (role: Message['role'], content: string): Message => ({ role, content });

function fileContent(sessionId: string): string {
  return readFileSync(join(dir, `${sessionId}.jsonl`), 'utf-8');
}

describe('appendToJsonl / flushSession / loadSession 往返', () => {
  it('批量缓冲：flush 后全部写入并可 load 往返', () => {
    const session = createSession();
    appendToJsonl(session, msg('user', '第一条'));
    appendToJsonl(session, msg('assistant', '第二条'));

    flushSession(session.id);

    expect(existsSync(join(dir, `${session.id}.jsonl`))).toBe(true);
    const restored = loadSession(session.id);
    expect(restored?.id).toBe(session.id);
    expect(restored?.messages).toEqual([
      msg('user', '第一条'),
      msg('assistant', '第二条'),
    ]);
  });

  it('达到 20 条自动刷盘，flush 兜底补齐剩余', () => {
    const session = createSession();
    for (let i = 0; i < 20; i++) {
      appendToJsonl(session, msg('user', `m${i}`));
    }
    // 第 20 条触发自动刷盘（数量条件，与时间无关）
    expect(loadSession(session.id)?.messages).toHaveLength(20);

    for (let i = 20; i < 25; i++) {
      appendToJsonl(session, msg('user', `m${i}`));
    }
    flushSession(session.id);
    const restored = loadSession(session.id);
    expect(restored!.messages).toHaveLength(25);
    expect(restored!.messages[24]).toEqual(msg('user', 'm24'));
  });

  it('flushSession 幂等且清空缓冲', () => {
    const session = createSession();
    appendToJsonl(session, msg('user', 'a'));
    flushSession(session.id);
    flushSession(session.id);
    appendToJsonl(session, msg('assistant', 'b'));
    flushSession(session.id);

    expect(fileContent(session.id).trim().split('\n')).toEqual([
      JSON.stringify(msg('user', 'a')),
      JSON.stringify(msg('assistant', 'b')),
    ]);
  });
});

describe('syncSessionMessages（全量同步）', () => {
  it('替换文件为当前消息，不残留缓冲旧消息', () => {
    const session = createSession();
    appendToJsonl(session, msg('user', '旧消息'));

    // 长度回退 / 内容替换：整体重写为当前消息
    syncSessionMessages(session.id, [
      msg('system', '压缩摘要'),
      msg('user', '当前消息'),
    ]);

    const restored = loadSession(session.id);
    expect(restored?.messages).toEqual([
      msg('system', '压缩摘要'),
      msg('user', '当前消息'),
    ]);

    // 缓冲已清空：后续追加不会把旧消息再次写入
    appendToJsonl(session, msg('assistant', '新回复'));
    flushSession(session.id);
    expect(loadSession(session.id)?.messages).toEqual([
      msg('system', '压缩摘要'),
      msg('user', '当前消息'),
      msg('assistant', '新回复'),
    ]);
  });

  it('空消息列表：文件置空且 loadSession 返回空会话（id 仍可恢复）', () => {
    const session = createSession();
    appendToJsonl(session, msg('user', 'x'));
    syncSessionMessages(session.id, []);

    expect(existsSync(join(dir, `${session.id}.jsonl`))).toBe(true);
    expect(fileContent(session.id)).toBe('');
    const restored = loadSession(session.id);
    expect(restored?.id).toBe(session.id);
    expect(restored?.messages).toEqual([]);
  });

  it('作为退出兜底：把尚未刷盘的内存消息完整落盘', () => {
    const session = createSession();
    const live: Message[] = [
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
    ];
    // 模拟实时追加只落到缓冲，随后退出兜底全量同步
    for (const m of live) appendToJsonl(session, m);
    syncSessionMessages(session.id, live);

    expect(loadSession(session.id)?.messages).toEqual(live);
  });
});

describe('writeSessionMeta / listSessions', () => {
  it('writeSessionMeta 写入 id/title/messageCount', () => {
    const session = createSession('测试会话');
    session.messages = [msg('user', 'hi')];
    writeSessionMeta(session, { updatedAt: '2026-08-13T00:00:00.000Z' });

    const meta = JSON.parse(
      readFileSync(join(dir, `${session.id}.meta.json`), 'utf-8'),
    ) as Record<string, unknown>;
    expect(meta.id).toBe(session.id);
    expect(meta.title).toBe('测试会话');
    expect(meta.messageCount).toBe(1);
    expect(meta.updatedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('listSessions 只统计 jsonl 文件且带 messageCount', () => {
    const a = createSession();
    appendToJsonl(a, msg('user', 'a1'));
    flushSession(a.id);
    const b = createSession();
    appendToJsonl(b, msg('user', 'b1'));
    flushSession(b.id);

    const sessions = listSessions();
    expect(new Set(sessions.map((s) => s.id))).toEqual(new Set([a.id, b.id]));
    expect(sessions.every((s) => s.messageCount === 1)).toBe(true);
  });

  it('会话 id 为标准 UUID v4 且批量创建互不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createSession().id));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});
