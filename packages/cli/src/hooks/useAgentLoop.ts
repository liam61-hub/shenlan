/**
 * useAgentLoop — agent 循环 hook
 *
 * 监听 state.messages 变化（新用户消息），运行 agent 循环，
 * 通过 dispatch 更新流式输出、工具状态、确认提示等。
 */
import { useEffect, useRef, useCallback } from 'react';
import type { Dispatch } from 'react';
import { getTodos, getPlan, recordUsage, clearTodos, clearPlan, abortAllBackgroundTasks } from '@shenlan/core';
import type { ShenlanConfig, TokenUsage } from '@shenlan/core';
import type { AppAction, AppState } from '../context.js';
import { runAgentLoop } from '../repl.js';
import { getMode } from '../mode.js';
import type { ConfirmRequestInfo } from '../repl.js';
import type { FileChange } from '../file-change.js';
import { buildConfirmTitle, buildConfirmDetail, buildConfirmOptions } from '../confirm-options.js';
import { formatToolSummary } from '../tool-summary.js';

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
      try {
        await runAgentLoop(
          '', // Not used directly — last message is already in messages array
          config,
          state.messages,
          {
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
            onToolStart(id: string, name: string, detail: string) {
              if (currentRunId !== runIdRef.current) return;
              flushTokens();
              dispatch({ type: 'TOOL_START', id, name, detail });
            },
            onToolDone(id: string, name: string, detail: string, resultContent?: string, fileChange?: FileChange) {
              if (currentRunId !== runIdRef.current) return;
              dispatch({ type: 'TOOL_DONE', id, name, detail });
              // goal 模式：模型调用 goal_complete → 状态置 completed（/budget 展示）
              if (name === 'goal_complete') {
                dispatch({ type: 'GOAL_COMPLETE' });
              }
              // todo_write / update_plan：把核心层 session 状态同步到 UI 动态区
              if (name === 'todo_write') {
                dispatch({ type: 'TODOS', todos: getTodos() });
              } else if (name === 'update_plan') {
                dispatch({ type: 'PLAN', plan: getPlan() });
              }
              if (resultContent) {
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
              // 错误对齐 Codex / Claude Code：工具失败不再以「错误」样式输出。
              // 只发 TOOL_DONE（绿色 ✔）+ 普通工具结果行，错误文本仍保留在对话
              // 消息中供模型判断；仅 API/agent 级致命错误走 onError 红色横幅。
              dispatch({ type: 'TOOL_DONE', id, name, detail: '' });
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
                if (info.kind === 'cost-guardrail') {
                  const isDay = info.guardKind === 'day';
                  const zh = info.language === 'zh-CN';
                  const options = isDay
                    ? [
                        { label: zh ? '停止任务（默认）' : 'Stop task (default)', key: '1', value: 'stop' },
                        { label: zh ? '今日豁免并继续' : 'Continue for today', key: '2', value: 'continue' },
                        { label: zh ? '调高单日上限（输入新值）' : 'Enter a new daily limit', key: '3', value: 'feedback' },
                      ]
                    : [
                        { label: zh ? '停止任务（默认）' : 'Stop task (default)', key: '1', value: 'stop' },
                        { label: zh ? '本次继续（仅本会话）' : 'Continue this session', key: '2', value: 'continue' },
                        { label: zh ? '调高本会话上限（输入新值）' : 'Enter a new session limit', key: '3', value: 'feedback' },
                      ];
                  dispatch({
                    type: 'CONFIRM_PROMPT',
                    prompt: {
                      kind: 'cost-guardrail',
                      language: info.language,
                      title: zh ? `成本护栏已触发（${isDay ? '单日上限' : '本会话上限'}）` : `Cost limit reached (${isDay ? 'daily' : 'session'})`,
                      detail: [info.reason || (zh ? '成本已达上限' : 'Cost limit reached')],
                      toolName: 'cost-guardrail',
                      description: info.description,
                      options,
                      selected: 0,
                      feedbackMode: false,
                      feedbackText: '',
                      feedbackLabel: zh ? (isDay ? '输入新的单日上限（CNY，如 50）：' : '输入新的本会话上限（CNY，如 10）：') : `Enter new ${isDay ? 'daily' : 'session'} limit (CNY):`,
                      footerHint: zh ? '↑/↓ 选择 · Enter 确认 · Esc 调高上限 · Ctrl+C 终止' : '↑/↓ select · Enter confirm · Esc change limit · Ctrl+C abort',
                    },
                  });
                  return;
                }
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
            onCost(model: string, promptTokens: number, completionTokens: number) {
              // 每轮真实 usage 记账（含工具调用轮），供 /cost /budget 展示
              recordUsage(model, promptTokens, completionTokens);
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
              // 任务结束清理本次任务的 todo/plan（plan 模式保留：计划是跨轮产物）
              if (getMode() !== 'plan') {
                clearTodos();
                clearPlan();
              }
              // Sync agent-modified messages back to React state
              (globalThis as any).__shenlanAgentMessages = state.messages;
              dispatch({ type: 'COMPLETE', usage });
            },
            onError(error: Error) {
              if (currentRunId !== runIdRef.current) return;
              flushTokens();
              if (getMode() !== 'plan') {
                clearTodos();
                clearPlan();
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
