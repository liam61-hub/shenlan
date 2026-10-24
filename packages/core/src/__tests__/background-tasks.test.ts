/**
 * 后台任务注册表（session 级）— 注册/完成流转/只消费一次/取消/并发上限
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startBackgroundTask,
  consumePendingInjections,
  listRunningBackgroundTasks,
  abortAllBackgroundTasks,
  clearBackgroundTasks,
  setBackgroundRunner,
  setBackgroundListener,
} from '../background-tasks.js';
import type { BackgroundRunner, BackgroundEvent } from '../background-tasks.js';

const okRunner: BackgroundRunner = () => Promise.resolve({ goal: 'g', summary: 's', success: true });

describe('后台任务注册表', () => {
  beforeEach(() => {
    clearBackgroundTasks();
    setBackgroundRunner(okRunner);
  });

  it('启动任务：立即返回 taskId，不阻塞（不 await 完成）', () => {
    const r = startBackgroundTask('探索定价', '查 Tavily 定价', undefined, { maxBackground: 3 });
    expect(r.taskId).toMatch(/^bg-/);
    expect(listRunningBackgroundTasks()).toHaveLength(1);
  });

  it('完成流转：runner resolve 后入待注入队列，running 列表清空', async () => {
    let resolveFn!: (v: { goal: string; summary: string; success: boolean }) => void;
    setBackgroundRunner(() => new Promise((res) => { resolveFn = res; }));
    startBackgroundTask('g', 't', undefined, { maxBackground: 3 });
    expect(listRunningBackgroundTasks()).toHaveLength(1);
    resolveFn({ goal: 'g', summary: '结论', success: true });
    await vi.waitFor(() => expect(listRunningBackgroundTasks()).toHaveLength(0));
    expect(consumePendingInjections()).toEqual([
      expect.objectContaining({ goal: 'g', summary: '结论', success: true }),
    ]);
  });

  it('只消费一次：第二次 consume 返回空', async () => {
    startBackgroundTask('g', 't', undefined, { maxBackground: 3 });
    await vi.waitFor(() => expect(listRunningBackgroundTasks()).toHaveLength(0));
    expect(consumePendingInjections()).toHaveLength(1);
    expect(consumePendingInjections()).toHaveLength(0);
  });

  it('并发上限：超过 maxBackground 抛错（含当前运行数），不排队', () => {
    setBackgroundRunner(() => new Promise(() => {})); // 永不完成
    startBackgroundTask('a', 't', undefined, { maxBackground: 2 });
    startBackgroundTask('b', 't', undefined, { maxBackground: 2 });
    expect(() => startBackgroundTask('c', 't', undefined, { maxBackground: 2 }))
      .toThrow(/2/);
  });

  it('abort：AbortSignal 传入 runner，abortAll 后任务终止', () => {
    let seenSignal: AbortSignal | undefined;
    setBackgroundRunner((_g, _t, signal) => new Promise((_, rej) => {
      seenSignal = signal;
      signal!.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    startBackgroundTask('g', 't', undefined, { maxBackground: 1 });
    abortAllBackgroundTasks();
    expect(seenSignal!.aborted).toBe(true);
  });

  it('runner 抛错：记为 failed 并注入失败摘要', async () => {
    setBackgroundRunner(() => Promise.reject(new Error('boom')));
    startBackgroundTask('g', 't', undefined, { maxBackground: 1 });
    await vi.waitFor(() => expect(listRunningBackgroundTasks()).toHaveLength(0));
    const [inj] = consumePendingInjections();
    expect(inj!.success).toBe(false);
  });

  it('clear：清空注册表与待注入队列', () => {
    startBackgroundTask('g', 't', undefined, { maxBackground: 1 });
    clearBackgroundTasks();
    expect(listRunningBackgroundTasks()).toHaveLength(0);
    expect(consumePendingInjections()).toHaveLength(0);
  });
});

describe('后台任务事件监听（UI 驱动）', () => {
  beforeEach(() => {
    clearBackgroundTasks();
    setBackgroundRunner(okRunner);
    setBackgroundListener(null);
  });

  it('start / done 事件按序触发（含 taskId 与 goal）', async () => {
    const events: BackgroundEvent[] = [];
    setBackgroundListener((ev) => { events.push(ev); });
    const { taskId } = startBackgroundTask('g1', 't', undefined, { maxBackground: 1 });
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(events[0]).toMatchObject({ type: 'start', taskId, goal: 'g1' });
    expect(events[1]).toMatchObject({ type: 'done', taskId, goal: 'g1', success: true });
  });

  it('runner 失败触发 failed 事件', async () => {
    const events: BackgroundEvent[] = [];
    setBackgroundListener((ev) => { events.push(ev); });
    setBackgroundRunner(() => Promise.reject(new Error('boom')));
    startBackgroundTask('g2', 't', undefined, { maxBackground: 1 });
    await vi.waitFor(() => expect(events.some(e => e.type === 'failed')).toBe(true));
  });

  it('取消监听后不再收到事件', () => {
    const events: BackgroundEvent[] = [];
    setBackgroundListener((ev) => { events.push(ev); });
    setBackgroundListener(null);
    startBackgroundTask('g3', 't', undefined, { maxBackground: 1 });
    expect(events).toHaveLength(0);
  });
});
