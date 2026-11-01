import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setSessionDir,
  createSession,
  appendToJsonl,
  flushSession,
  flushAllSessions,
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
  vi.useRealTimers();
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

  it('低流量会话在 10 秒定时器到期时刷盘', () => {
    vi.useFakeTimers();
    const session = createSession();
    appendToJsonl(session, msg('user', 'low traffic message'));
    expect(existsSync(join(dir, `${session.id}.jsonl`))).toBe(false);

    vi.advanceTimersByTime(10_000);

    expect(loadSession(session.id)?.messages).toEqual([msg('user', 'low traffic message')]);
    vi.useRealTimers();
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

  it('退出时刷完所有会话并取消低流量定时器', () => {
    vi.useFakeTimers();
    const first = createSession();
    const second = createSession();
    appendToJsonl(first, msg('user', 'first'));
    appendToJsonl(second, msg('user', 'second'));
    expect(vi.getTimerCount()).toBe(2);

    flushAllSessions();

    expect(vi.getTimerCount()).toBe(0);
    expect(loadSession(first.id)?.messages).toEqual([msg('user', 'first')]);
    expect(loadSession(second.id)?.messages).toEqual([msg('user', 'second')]);
    vi.advanceTimersByTime(10_000);
    expect(fileContent(first.id).trim().split('\n')).toEqual([JSON.stringify(msg('user', 'first'))]);
    expect(fileContent(second.id).trim().split('\n')).toEqual([JSON.stringify(msg('user', 'second'))]);
  });

  it('截断 JSONL 尾行时恢复有效前缀并保留损坏原文', () => {
    const session = createSession();
    const validPrefix = `${JSON.stringify(msg('user', '已完成问题'))}\n${JSON.stringify(msg('assistant', '已完成回答'))}\n`;
    const damagedContent = `${validPrefix}{"role":"assistant","content":"truncated`;
    writeFileSync(join(dir, `${session.id}.jsonl`), damagedContent, 'utf-8');

    const restored = loadSession(session.id);

    expect(restored?.messages).toEqual([
      msg('user', '已完成问题'),
      msg('assistant', '已完成回答'),
    ]);
    expect(restored?.recovery).toEqual({ kind: 'truncated-tail', line: 3 });
    expect(fileContent(session.id)).toBe(damagedContent);
  });

  it('中间记录损坏时只恢复此前有效前缀并报告损坏行', () => {
    const session = createSession();
    const content = `${JSON.stringify(msg('user', 'valid'))}\nnot-json\n${JSON.stringify(msg('assistant', 'later'))}\n`;
    writeFileSync(join(dir, `${session.id}.jsonl`), content, 'utf-8');

    const restored = loadSession(session.id);

    expect(restored?.messages).toEqual([msg('user', 'valid')]);
    expect(restored?.recovery).toEqual({ kind: 'corrupt-record', line: 2 });
    expect(fileContent(session.id)).toBe(content);
  });

  it('结构无效的 JSON 消息会停止恢复并保留此前有效前缀', () => {
    const session = createSession();
    const content = `${JSON.stringify(msg('user', 'valid'))}\n${JSON.stringify({ role: 'tool', content: 'missing tool_call_id' })}\n`;
    writeFileSync(join(dir, `${session.id}.jsonl`), content, 'utf-8');

    const restored = loadSession(session.id);

    expect(restored?.messages).toEqual([msg('user', 'valid')]);
    expect(restored?.recovery).toEqual({ kind: 'invalid-message', line: 2 });
    expect(fileContent(session.id)).toBe(content);
  });

  it('不恢复缺少 tool 响应的 assistant/tool 调用片段', () => {
    const session = createSession();
    const call = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'read', arguments: '{"file_path":"a.txt"}' },
    };
    const before = msg('user', 'before');
    const assistant: Message = { role: 'assistant', content: null, tool_calls: [call] };
    const after = msg('user', 'after');
    const content = [before, assistant, after].map((message) => JSON.stringify(message)).join('\n') + '\n';
    writeFileSync(join(dir, `${session.id}.jsonl`), content, 'utf-8');

    const restored = loadSession(session.id);

    expect(restored?.messages).toEqual([before, after]);
    expect(restored?.recovery).toEqual({ kind: 'incomplete-tool-pair', line: 2 });
    expect(fileContent(session.id)).toBe(content);
  });
});

describe('syncSessionMessages（全量同步）', () => {
  it('任务进度工具调用与结果随会话恢复并保留顺序', () => {
    const session = createSession();
    const progressMessages: Message[] = [
      msg('user', '实现多阶段改动'),
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'progress-1', type: 'function', function: {
          name: 'task_progress', arguments: JSON.stringify({ kind: 'stage', status: 'started', title: 'Implementation' }),
        } }],
      },
      { role: 'tool', tool_call_id: 'progress-1', name: 'task_progress', content: 'Progress recorded: stage started — Implementation' },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'progress-2', type: 'function', function: {
          name: 'task_progress', arguments: JSON.stringify({ kind: 'verification', status: 'failed', title: 'Tests' }),
        } }],
      },
      { role: 'tool', tool_call_id: 'progress-2', name: 'task_progress', content: 'Progress recorded: verification failed — Tests' },
    ];
    syncSessionMessages(session.id, progressMessages);

    expect(loadSession(session.id)?.messages).toEqual(progressMessages);
  });

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

  it('原子 checkpoint 替换完整文件并清除正常临时文件', () => {
    const session = createSession();
    syncSessionMessages(session.id, [msg('user', '旧快照')]);

    syncSessionMessages(session.id, [msg('user', '新快照'), msg('assistant', '完成')]);

    expect(loadSession(session.id)?.messages).toEqual([
      msg('user', '新快照'),
      msg('assistant', '完成'),
    ]);
    expect(readdirSync(dir).filter((name) => name.startsWith(`${session.id}.jsonl.tmp-`))).toEqual([]);
  });

  it('checkpoint 替换前中断时仍恢复旧 checkpoint，忽略残留临时文件', () => {
    const session = createSession();
    const completed = [msg('user', '已完成轮次'), msg('assistant', '已保存回答')];
    syncSessionMessages(session.id, completed);
    const original = fileContent(session.id);
    writeFileSync(join(dir, `${session.id}.jsonl.tmp-interrupted`), '{"role":"user"', 'utf-8');

    const restored = loadSession(session.id);

    expect(restored?.messages).toEqual(completed);
    expect(fileContent(session.id)).toBe(original);
  });
});

describe('writeSessionMeta / listSessions', () => {
  it('writeSessionMeta 写入 id/title/messageCount', () => {
    const session = createSession('测试会话', 'D:/WORK/project-a');
    session.messages = [msg('user', 'hi')];
    writeSessionMeta(session, { updatedAt: '2026-08-13T00:00:00.000Z' });

    const meta = JSON.parse(
      readFileSync(join(dir, `${session.id}.meta.json`), 'utf-8'),
    ) as Record<string, unknown>;
    expect(meta.id).toBe(session.id);
    expect(meta.title).toBe('测试会话');
    expect(meta.messageCount).toBe(1);
    expect(meta.projectPath).toBe('D:/WORK/project-a');
    expect(meta.updatedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('loadSession 和 listSessions 返回已校验的项目身份', () => {
    const session = createSession(undefined, 'D:/WORK/project-a');
    appendToJsonl(session, msg('user', 'project scoped'));
    flushSession(session.id);
    writeSessionMeta(session);

    expect(loadSession(session.id)?.projectPath).toBe('D:/WORK/project-a');
    expect(listSessions().find((listed) => listed.id === session.id)?.projectPath).toBe('D:/WORK/project-a');
  });

  it('无效 session ID 不会被当作文件路径读取', () => {
    expect(loadSession('../outside')).toBeNull();
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
