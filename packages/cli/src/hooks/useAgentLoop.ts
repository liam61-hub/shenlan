/**
 * useAgentLoop — agent 循环 hook
 *
 * 监听 state.messages 变化（新用户消息），运行 agent 循环，
 * 通过 dispatch 更新流式输出、工具状态、确认提示等。
 */
import { useEffect, useRef, useCallback } from 'react';
import type { Dispatch } from 'react';
import { getTodos, getPlan, clearTodos, clearPlan, clearTaskProgress, abortAllBackgroundTasks, syncSessionMessages, debugLog } from '@shenlan/core';
import type { ShenlanConfig, TokenUsage } from '@shenlan/core';
import type { AppAction, AppState } from '../context.js';
import { runAgentLoop } from '../repl.js';
import { getMode } from '../mode.js';
import type { ConfirmRequestInfo } from '../repl.js';
import type { FileChange } from '../file-change.js';
import { buildConfirmTitle, buildConfirmDetail, buildConfirmOptions } from '../confirm-options.js';
import { formatToolSummary } from '../tool-summary.js';
import { formatShellOutputChange } from '../shell-summary.js';
import { continuesToolGroup } from '../tool-group.js';
import { shellActivities, shellActivityLines, type ShellActivity } from '../shell-activity.js';

interface ShellRunSummary {
  command: string;
  output: string;
  previousOutput: string | null;
  failed: boolean;
}

interface ToolRunGroup {
  name: string;
  detail: string;
  durationMs: number;
  runs: number;
  outcome: 'done' | 'error';
  summaries: string[];
}

function shellOutputLine(output: string): string {
  return output.split('\n').find(line => line.trim())?.trim() || '(no output)';
}

// Token 批量合并（模块级，每 50ms flush 一次）
let pendingTokens = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dispatchForTokens: Dispatch<AppAction> | null = null;

function flushTokens() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingTokens && dispatchForTokens) {
    dispatchForTokens({ type: 'TOKEN', token: pendingTokens });
    pendingTokens = '';
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushTokens, 50);
}

// Confirm resolve holder
let confirmResolver: ((value: string) => void) | null = null;

export function resolveConfirmResult(result: string) {
  if (confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(result);
  }
}

/**
 * /clear 等重置场景：会话消息清空后，已处理的用户消息计数必须归零，
 * 否则下一条消息（计数与归零前相等）会被误判为“没有新消息”而不再触发 agent 循环。
 */
let resetAgentLoopFlag = false;
export function resetAgentLoopState(): void {
  resetAgentLoopFlag = true;
}

/** 当前 agent 循环的 AbortController（ESC 立即中断在途 LLM 请求） */
let activeAbortController: AbortController | null = null;
export function abortActiveLoop(): void {
  activeAbortController?.abort();
  // ESC 同时终止全部运行中后台任务（§26.5）
  abortAllBackgroundTasks();
}

interface UseAgentLoopParams {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  config: ShenlanConfig;
  model: string;
}

export function useAgentLoop({ state, dispatch, config }: UseAgentLoopParams) {
  // Init to current count so resumed sessions don't auto-rerun
  const lastMsgCountRef = useRef(
    state.messages.filter(m => m.role === 'user').length
  );
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // goal 状态透传：effect 依赖 submitSeq，goal 用 ref 保持最新值
  const goalRef = useRef(state.goal);
  goalRef.current = state.goal;

  // Keep dispatch ref for token flushing
  useEffect(() => {
    dispatchForTokens = dispatch;
  }, [dispatch]);

  // Watch for new user messages
  // IMPORTANT: depends on submitSeq (not state.messages.length) because
  // runAgentLoop mutates state.messages in place (push), which would change
  // .length and cause React to abort the in-flight agent loop via cleanup.
  useEffect(() => {
    if (resetAgentLoopFlag) {
      resetAgentLoopFlag = false;
      lastMsgCountRef.current = 0;
    }
    const userMsgs = state.messages.filter(m => m.role === 'user');
    if (userMsgs.length === 0) return;
    if (userMsgs.length === lastMsgCountRef.current) return;

    // Abort any in-flight run so the new message starts fresh
    if (abortRef.current) {
      abortRef.current.abort();
    }

    lastMsgCountRef.current = userMsgs.length;
    const currentRunId = ++runIdRef.current;

    const abortController = new AbortController();
    abortRef.current = abortController;
    activeAbortController = abortController;

    (async () => {
      const shellRuns: ShellRunSummary[] = [];
      const shellRunById = new Map<string, ShellRunSummary>();
      const activityRuns = new Map<string, { activities: ShellActivity[]; finished: boolean }>();
      const recordActivity = (id: string, phase: 'started' | 'finished', output = '', failed = false) => {
        const run = activityRuns.get(id);
        if (!run || run.finished) return;
        if (phase === 'finished') run.finished = true;
        const result = shellActivityLines({ id, activities: run.activities, phase, output, failed });
        for (const [index, content] of result.lines.entries()) {
          dispatch({ type: 'TOOL_RESULT', id: `${id}-${phase}-${index}`, name: 'shell', detail: '', content, isError: result.failed });
        }
      };
      let lastShellRun: ShellRunSummary | null = null;
      let toolRunGroup: ToolRunGroup | null = null;
      const toolRunById = new Map<string, { group: ToolRunGroup; startedAt: number }>();
      const flushToolRunGroup = () => {
        if (!toolRunGroup) return;
        const group = toolRunGroup;
        toolRunGroup = null;
        dispatch({
          type: 'TOOL_GROUP_RESULT',
          id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: group.name,
          detail: group.detail,
          outcome: group.outcome,
          durationMs: group.durationMs,
          runs: group.runs,
          content: group.name === 'read' ? group.summaries.at(-1) || 'read: (no output)' : group.summaries.length > 1
            ? group.summaries.map((summary, index) => `${index + 1}. ${summary}`).join(' · ')
            : group.summaries[0] || `${group.name}: (no output)`,
        });
      };
      const flushShellSummaries = () => {
        const pending = shellRuns.splice(0);
        for (const [index, run] of pending.entries()) {
          const body = run.previousOutput === null
            ? shellOutputLine(run.output)
            : formatShellOutputChange(run.previousOutput, run.output);
          dispatch({
            type: 'TOOL_RESULT',
            id: `shell-summary-${index}`,
            name: 'shell',
            detail: run.command,
            content: run.failed ? `✖ shell ${run.command}: ${body}` : `shell ${run.command}: ${body}`,
            isError: run.failed,
          });
        }
      };
      try {
        await runAgentLoop(
          '', // Not used directly — last message is already in messages array
          config,
          state.messages,
          {
            onShellActivity(event) {
              if (currentRunId !== runIdRef.current) return;
              flushTokens();
              if (!activityRuns.has(event.id)) activityRuns.set(event.id, { activities: event.activities, finished: false });
              recordActivity(event.id, event.phase, event.output, event.failed);
            },
            onThinkingStart() {
              if (currentRunId !== runIdRef.current) return;
              // 新一轮 LLM 请求：进入 thinking，显示 spinner
              dispatch({ type: 'THINKING_START' });
            },
            onToken(token: string) {
              if (currentRunId !== runIdRef.current) return;
              pendingTokens += token;
              scheduleFlush();
            },
            onToolStart(id: string, name: string, detail: string, shellCommand?: string) {
              if (currentRunId !== runIdRef.current) return;
              flushTokens();
              if (name === 'shell') {
                flushToolRunGroup();
                const command = (shellCommand ?? detail).trim();
                const activities = shellActivities(command);
                if (activities.length) {
                  flushShellSummaries();
                  lastShellRun = null;
                  activityRuns.set(id, { activities, finished: false });
                  dispatch({ type: 'TOOL_START', id, name, detail });
                  return;
                }
                if (lastShellRun && lastShellRun.command !== command) flushShellSummaries();
                let summary = lastShellRun;
                if (!summary || summary.command !== command) {
                  summary = { command, output: '', previousOutput: null, failed: false };
                  shellRuns.push(summary);
                }
                lastShellRun = summary;
                shellRunById.set(id, summary);
              } else {
                flushShellSummaries();
                lastShellRun = null;
                const normalizedDetail = detail.trim();
                const groupable = !['write', 'edit', 'task_progress', 'shell_status'].includes(name);
                if (!groupable) flushToolRunGroup();
                if (groupable && toolRunGroup && !continuesToolGroup(toolRunGroup, name, normalizedDetail)) {
                  flushToolRunGroup();
                }
                if (groupable && !toolRunGroup) {
                  toolRunGroup = {
                    name,
                    detail: normalizedDetail,
                    durationMs: 0,
                    runs: 0,
                    outcome: 'done',
                    summaries: [],
                  };
                }
                if (groupable && toolRunGroup) {
                  toolRunGroup.detail = normalizedDetail;
                  toolRunGroup.runs += 1;
                  toolRunById.set(id, { group: toolRunGroup, startedAt: Date.now() });
                }
              }
              dispatch({ type: 'TOOL_START', id, name, detail, grouped: toolRunById.has(id) });
            },
            onToolDone(id: string, name: string, detail: string, resultContent?: string, fileChange?: FileChange) {
              if (currentRunId !== runIdRef.current) return;
              const shellSummary = name === 'shell' ? shellRunById.get(id) : undefined;
              const toolRun = name !== 'shell' ? toolRunById.get(id) : undefined;
              const toolGroup = toolRun?.group;
              if (toolRun && toolGroup) {
                toolGroup.durationMs += Math.max(0, Date.now() - toolRun.startedAt);
                if (name === 'read') toolGroup.summaries.length = 0;
                if (resultContent) toolGroup.summaries.push(formatToolSummary(name, detail, resultContent, false));
              }
              if (shellSummary) {
                shellSummary.previousOutput = shellSummary.output || null;
                shellSummary.output = resultContent || '';
                shellSummary.failed = false;
              }
              dispatch({ type: 'TOOL_DONE', id, name, detail, recordHistory: name !== 'shell' && !toolGroup });
              // goal 模式：模型调用 goal_complete → 状态置 completed
              if (name === 'goal_complete') {
                dispatch({ type: 'GOAL_COMPLETE' });
              }
              // todo_write / update_plan：把核心层 session 状态同步到 UI 动态区
              if (name === 'todo_write') {
                const todos = getTodos();
                dispatch({ type: 'TODOS', todos });
                debugLog('Todo UI synchronized', {
                  totalCount: todos.length,
                  inProgressCount: todos.filter(todo => todo.status === 'in_progress').length,
                  pendingCount: todos.filter(todo => todo.status === 'pending').length,
                  completedCount: todos.filter(todo => todo.status === 'completed').length,
                });
              } else if (name === 'update_plan') {
                dispatch({ type: 'PLAN', plan: getPlan() });
              }
              if (resultContent && name !== 'shell' && !toolGroup && !activityRuns.has(id)) {
                dispatch({
                  type: 'TOOL_RESULT',
                  id,
                  name,
                  detail,
                  content: formatToolSummary(name, detail, resultContent, false),
                  isError: false,
                  fileChange,
                });
              }
            },
            onToolError(id: string, name: string, error: string) {
              if (currentRunId !== runIdRef.current) return;
              recordActivity(id, 'finished', error, true);
              const shellSummary = name === 'shell' ? shellRunById.get(id) : undefined;
              const toolRun = name !== 'shell' ? toolRunById.get(id) : undefined;
              const toolGroup = toolRun?.group;
              if (toolRun && toolGroup) {
                toolGroup.durationMs += Math.max(0, Date.now() - toolRun.startedAt);
                toolGroup.outcome = 'error';
                toolGroup.summaries.push(formatToolSummary(name, toolGroup.detail, error, false));
              }
              if (shellSummary) {
                shellSummary.previousOutput = shellSummary.output || null;
                shellSummary.output = error;
                shellSummary.failed = true;
              }
              // 错误对齐 Codex / Claude Code：工具失败不再以「错误」样式输出。
              // 只发 TOOL_DONE（绿色 ✔）+ 普通工具结果行，错误文本仍保留在对话
              // 消息中供模型判断；仅 API/agent 级致命错误走 onError 红色横幅。
              dispatch({ type: 'TOOL_DONE', id, name, detail: '', recordHistory: name !== 'shell' && !toolGroup });
              if (name === 'shell' || toolGroup || activityRuns.has(id)) return;
              dispatch({
                type: 'TOOL_RESULT',
                id,
                name,
                detail: '',
                content: formatToolSummary(name, '', error, false),
                isError: false,
              });
            },
            async onConfirm(info: ConfirmRequestInfo) {
              flushTokens();
              return new Promise<string>((resolve) => {
                confirmResolver = resolve;
                const kind = info.kind;
                dispatch({
                  type: 'CONFIRM_PROMPT',
                  prompt: {
                    kind,
                    language: info.language,
                    title: buildConfirmTitle(kind, info.language),
                    detail: buildConfirmDetail(kind, {
                      paths: info.paths,
                      command: info.kind === 'external' || info.kind === 'destructive' ? info.description : info.command,
                      pattern: info.pattern,
                    }, info.language),
                    toolName: info.toolName,
                    description: info.description,
                    options: buildConfirmOptions(kind, {
                      paths: info.paths,
                      prefix: info.prefix,
                      family: info.commandGrant?.family,
                    }, info.language),
                    selected: 0,
                    feedbackMode: false,
                    feedbackText: '',
                    feedbackLabel: info.feedbackLabel,
                  },
                });
              });
            },
            onModel(model: string) {
              if (currentRunId !== runIdRef.current) return;
              // 实际生效模型同步到 UI（底部状态行/顶部头部显示，sticky 路由优先）
              dispatch({ type: 'SET_MODEL', model });
            },
            onNotice(content: string) {
              if (currentRunId !== runIdRef.current) return;
              flushTokens();
              dispatch({ type: 'ADD_SYSTEM_MSG', content });
            },
            onComplete(usage?: TokenUsage) {
              if (currentRunId !== runIdRef.current) return;
              flushTokens();
              flushShellSummaries();
              flushToolRunGroup();
              // A completed turn is durable before the UI reports completion.
              // The shared messages array already contains the final assistant/tool messages here.
              syncSessionMessages(state.sessionId, state.messages);
              // 任务结束清理本次任务的 todo/plan（plan 模式保留：计划是跨轮产物）
              if (getMode() !== 'plan') {
                clearTodos();
                clearPlan();
                clearTaskProgress();
              }
              // Sync agent-modified messages back to React state
              (globalThis as any).__shenlanAgentMessages = state.messages;
              dispatch({ type: 'COMPLETE', usage });
            },
            onError(error: Error) {
              if (currentRunId !== runIdRef.current) return;
              for (const [id, run] of activityRuns) {
                if (!run.finished) recordActivity(id, 'finished', 'Execution stopped before a final result was received.', true);
              }
              flushTokens();
              flushShellSummaries();
              flushToolRunGroup();
              if (getMode() !== 'plan') {
                clearTodos();
                clearPlan();
                clearTaskProgress();
              }
              dispatch({ type: 'ERROR', error: error.message });
            },
          },
          abortController.signal,
          goalRef.current,
        );
      } catch (err) {
        if (currentRunId !== runIdRef.current) return;
        if ((err as Error).name !== 'AbortError') {
          flushShellSummaries();
          flushToolRunGroup();
          dispatch({ type: 'ERROR', error: (err as Error).message });
        }
      }
    })();

    return () => {
      activeAbortController = null;
      abortController.abort();
    };
  }, [state.submitSeq]);
}
