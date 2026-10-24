/**
 * 后台任务注册表（session 级，与 todo / plan 同级，随会话存在）
 *
 * background_agent 工具派发的异步子任务：工具立即返回，任务完成结果进入
 * 待注入队列，由 CLI 主循环在每次 LLM 调用前消费一次（只注入一次）。
 * 运行中任务不持久化（v1 语义：进程退出即放弃，§26.7）。
 */
import { randomBytes } from 'node:crypto';

/** 后台任务执行器（可注入，测试用；生产由 background-agent.ts 注册 runSubTask 包装） */
export type BackgroundRunner = (
  goal: string,
  task: string,
  signal: AbortSignal,
) => Promise<{ goal: string; summary: string; success: boolean }>;

interface BackgroundTaskRecord {
  taskId: string;
  goal: string;
  status: 'running' | 'done' | 'failed';
  startTime: number;
  endTime: number | null;
  controller: AbortController;
}

export interface BackgroundInjection {
  taskId: string;
  goal: string;
  summary: string;
  success: boolean;
}

/** 注册表事件（CLI UI 监听驱动动态区行与瞬态通知；与待注入队列独立，纯观测） */
export interface BackgroundEvent {
  type: 'start' | 'done' | 'failed';
  taskId: string;
  goal: string;
  summary?: string;
  /** done/failed 事件携带；start 事件缺省 */
  success?: boolean;
}

type BackgroundListener = (ev: BackgroundEvent) => void;

const tasks = new Map<string, BackgroundTaskRecord>();
let pendingInjections: BackgroundInjection[] = [];
let runner: BackgroundRunner | null = null;
let listener: BackgroundListener | null = null;

/** 注册默认执行器（生产由 background-agent 工具模块在加载时调用） */
export function setBackgroundRunner(r: BackgroundRunner): void {
  runner = r;
}

/** 设置事件监听（传 null 取消）；任务 start/done/failed 时触发 */
export function setBackgroundListener(l: BackgroundListener | null): void {
  listener = l;
}

function emit(ev: BackgroundEvent): void {
  try {
    listener?.(ev);
  } catch { /* 监听器异常不影响任务流转 */ }
}

/** 当前运行中任务（按启动时间排序） */
export function listRunningBackgroundTasks(): Array<{ taskId: string; goal: string; startTime: number }> {
  return [...tasks.values()]
    .filter((t) => t.status === 'running')
    .sort((a, b) => a.startTime - b.startTime)
    .map((t) => ({ taskId: t.taskId, goal: t.goal, startTime: t.startTime }));
}

/** 当前运行中任务数（并发上限检查用） */
export function countRunningBackgroundTasks(): number {
  let n = 0;
  for (const t of tasks.values()) if (t.status === 'running') n++;
  return n;
}

/**
 * 启动后台任务（立即返回，不 await）。
 * 超过 maxBackground 抛错（含当前运行数，不排队）；完成/失败结果入待注入队列。
 */
export function startBackgroundTask(
  goal: string,
  task: string,
  r: BackgroundRunner | undefined,
  opts: { maxBackground: number },
): { taskId: string } {
  const running = countRunningBackgroundTasks();
  if (running >= opts.maxBackground) {
    throw new Error(
      `background task limit reached: ${running} running (max ${opts.maxBackground}), retry later or use agent tool instead`,
    );
  }
  const taskId = `bg-${randomBytes(4).toString('hex')}`;
  const controller = new AbortController();
  tasks.set(taskId, {
    taskId, goal, status: 'running', startTime: Date.now(), endTime: null, controller,
  });
  const run = r ?? runner ?? (() => Promise.resolve({ goal, summary: 'background runner not set', success: false }));
  emit({ type: 'start', taskId, goal });
  void run(goal, task, controller.signal)
    .then((result) => finish(taskId, result.success, result.summary))
    .catch(() => finish(taskId, false, 'background task error'));
  return { taskId };
}

function finish(taskId: string, success: boolean, summary: string): void {
  const rec = tasks.get(taskId);
  if (!rec) return;
  rec.status = success ? 'done' : 'failed';
  rec.endTime = Date.now();
  emit({ type: rec.status, taskId, goal: rec.goal, summary, success });
  pendingInjections.push({ taskId, goal: rec.goal, summary, success });
}

/** 消费待注入队列（出队即删，同一结果绝不重复注入） */
export function consumePendingInjections(): BackgroundInjection[] {
  const out = pendingInjections;
  pendingInjections = [];
  return out;
}

/** 终止全部运行中后台任务（/stop、ESC；/clear 额外清队列见 clearBackgroundTasks） */
export function abortAllBackgroundTasks(): void {
  for (const t of tasks.values()) {
    if (t.status === 'running') t.controller.abort();
  }
}

/** 清空注册表与待注入队列（/clear） */
export function clearBackgroundTasks(): void {
  abortAllBackgroundTasks();
  tasks.clear();
  pendingInjections = [];
}
