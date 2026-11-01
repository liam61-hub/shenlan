/**
 * App — 主组件，useReducer 管理全局状态
 */
import { Box, Static } from 'ink';
import { useReducer, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { AppContext, securityMenuLength, type KeysPanelState } from './context.js';
import type {
  AppState, AppAction, AppContextType,
  HistoryItem,
  SlashSuggestions,
} from './context.js';
import { mcpMenuFor } from './context.js';
import { SLASH_COMMANDS } from './slash-commands.js';
import type { ShenlanConfig, Session } from '@shenlan/core';
import { appendToJsonl, syncSessionMessages, estimateCost, formatCost, debugLog, setBackgroundListener, messageTextOf } from '@shenlan/core';
import { DynamicRegion } from './components/DynamicRegion.js';
import { InputBox } from './components/InputBox.js';
import { useAgentLoop } from './hooks/useAgentLoop.js';
import { resolveConfirmResult } from './hooks/useAgentLoop.js';
import { getMode, setMode, cycleMode } from './mode.js';
import { buildFrozenItems } from './frozen-items.js';
import { splitStreaming } from './streaming.js';
import { ingestStreamLine, flushPendingBlock } from './stream-blocks.js';
import type { FlushItem } from './stream-blocks.js';
import type { RunMode } from './mode.js';
import { initialModelSelection } from './commands/model.js';
import { buildKeyProviders } from './keys.js';
import { formatShellOutputChange } from './shell-summary.js';
import { shellActivities, shellActivityLines } from './shell-activity.js';

let systemMessageSequence = 0;

interface AppProps {
  config: ShenlanConfig;
  model: string;
  version: string;
  termWidth: number;
  termHeight: number;
  initialMessages: Array<import('@shenlan/core').Message>;
  session: Session;
  /** 首次引导：无任何 provider key 时挂载后自动打开 /keys 面板（可 Esc 跳过） */
  onboarding?: boolean;
}

export function App({ config, model, version, termWidth, termHeight, initialMessages, session, onboarding }: AppProps) {
  const initialState: AppState = {
    history: initialMessages.length > 0 ? messagesToHistory(initialMessages) : [],
    messages: initialMessages,
    phase: 'idle',
    streamingTail: '',
    streamFenceOpen: false,
    pendingBlock: null,
    toolStatuses: [],
    bgTasks: [],
    toolOutputs: new Map(),
    todos: [],
    plan: [],
    confirmPrompt: null,
    mcpPanel: null,
    skillsPanel: null,
    modelPanel: null,
    keysPanel: null,
    securityPanel: null,
    configPanel: null,
    onboarding: null,
    goal: extractGoalFromMessages(initialMessages),
    slashSuggestions: null,
    inputHistory: [],
    inputValue: '',
    error: null,
    notice: null,
    model,
    sessionId: session.id,
    submitSeq: 0,
    staticEpoch: 0,
  };

  const [state, dispatch] = useReducer(reducer, initialState);

  // 后台任务事件 → UI 状态：注册表 listener 只装一次（/clear 清注册表不动 listener）
  useEffect(() => {
    setBackgroundListener((ev) => {
      if (ev.type === 'start') {
        dispatch({ type: 'BG_TASK_START', id: ev.taskId, goal: ev.goal });
      } else {
        dispatch({
          type: 'BG_TASK_DONE',
          id: ev.taskId,
          goal: ev.goal,
          success: ev.success === true,
          summary: ev.summary ?? '',
        });
      }
    });
    return () => setBackgroundListener(null);
  }, []);
  const [currentMode, setCurrentMode] = useState<RunMode>(getMode());
  // 终端尺寸：启动时捕获，resize 时更新（Ink 自身会重排，但视口高度需要最新值）
  const [term, setTerm] = useState({ width: termWidth, height: termHeight });

  // 首次引导：无任何 provider key 且非 headless → 挂载后打开欢迎流程
  // （只触发一次：欢迎 → 配 key → 快速上手；Esc 可跳过，之后随时 /keys 再配）
  const onboardingShownRef = useRef(false);
  useEffect(() => {
    if (!onboarding || onboardingShownRef.current) return;
    onboardingShownRef.current = true;
    dispatch({ type: 'ONBOARDING_OPEN', providers: buildKeyProviders(config) });
  }, [onboarding, config]);

  // 终端 resize → 更新视口高度/分隔线宽度
  useEffect(() => {
    const onResize = () => {
      const w = process.stdout.columns || termWidth;
      const h = process.stdout.rows || termHeight;
      setTerm({ width: w, height: h });
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, [termWidth, termHeight]);

  // Render cycle counter — logs every 100th render or when phase changes
  const renderCountRef2 = useRef(0);
  const lastPhaseRef = useRef(state.phase);
  renderCountRef2.current++;
  if (renderCountRef2.current % 100 === 0 || lastPhaseRef.current !== state.phase) {
    debugLog('App render', {
      renderCount: renderCountRef2.current,
      phase: state.phase,
      streamingTailLen: state.streamingTail.length,
      historyLen: state.history.length,
      msgLen: state.messages.length,
      mode: currentMode,
    });
  }
  lastPhaseRef.current = state.phase;

  // Agent loop hook
  useAgentLoop({ state, dispatch, config, model });

  // Wrap dispatch to handle mode actions + keep module state in sync
  // Stable reference via useCallback + ref to avoid re-rendering all children on every token
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const wrappedDispatch = useCallback((action: AppAction) => {
    if (action.type === 'CYCLE_MODE') {
      cycleMode();
      setCurrentMode(getMode());
      return;
    }
    if (action.type === 'SET_MODE') {
      setMode(action.mode);
      setCurrentMode(action.mode);
      return;
    }
    dispatchRef.current(action);
  }, []);

  // Expose dispatch for non-React paths (SIGCONT resume message, etc.)
  useEffect(() => {
    (globalThis as any).__shenlanDispatch = wrappedDispatch;
  }, [wrappedDispatch]);

  // Sync messages to global for session saving on exit
  useEffect(() => {
    (globalThis as any).__shenlanMessages = state.messages;
  }, [state.messages]);

  // 实时落盘：按 state.messages.length 增量调用 appendToJsonl（ref 记已追加条数去重）。
  // 长度回退（/clear、上下文压缩、tool_calls 配对修复）说明内存内容已被替换/清空，
  // 整体重写该会话 JSONL，保证 --resume 恢复出的内容与当前对话一致。
  // 注意：runAgentLoop 原地 push/替换 messages（引用不变），effect 无依赖数组，
  // 每次渲染后都对比长度，能捕获原地变更；退出路径另有 syncSessionMessages 兜底。
  const appendedCountRef = useRef(0);
  useEffect(() => {
    const msgs = state.messages;
    if (msgs.length < appendedCountRef.current) {
      syncSessionMessages(session.id, msgs);
      appendedCountRef.current = msgs.length;
      return;
    }
    while (appendedCountRef.current < msgs.length) {
      appendToJsonl(session, msgs[appendedCountRef.current]);
      appendedCountRef.current++;
    }
  });

  // Intercept CONFIRM_RESULT to resolve the confirm promise
  const prevPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (prevPhaseRef.current === 'confirming' && state.phase !== 'confirming') {
      // Confirm was resolved — already handled in reducer
    }
    prevPhaseRef.current = state.phase;
  }, [state.phase]);

  const ctx: AppContextType = {
    config,
    mode: currentMode,
    model: state.model,
    termWidth: term.width,
    termHeight: term.height,
    state,
    dispatch: wrappedDispatch,
  };

  // 静态项：logo 头部 + 已完成消息 + 流式整行（append-only，<Static> 增量写入）
  const frozenItems = useMemo(
    () => buildFrozenItems(state, version, term.width),
    [state.history, version, term.width],
  );

  return (
    <AppContext.Provider value={ctx}>
      <Box flexDirection="column">
        {/* /clear 后 staticEpoch+1 重挂载：旧 index 只增不减，会跳过清空后的新消息，
            重挂载让 <Static> 从 index 0 重绘（配合 /clear 的主动清屏） */}
        <Static key={state.staticEpoch} items={frozenItems}>{node => node}</Static>
        <DynamicRegion />
        <InputBox />
      </Box>
    </AppContext.Provider>
  );
}

// ===== Reducer =====

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SUBMIT_INPUT': {
      const newHistory = [...state.inputHistory];
      if (newHistory.length === 0 || newHistory[newHistory.length - 1] !== action.input) {
        newHistory.push(action.input);
        if (newHistory.length > 100) newHistory.shift();
      }
      // 新消息打断：先把未完成的表格/公式块冻结，再开新轮
      const flushed = flushStreamState(state);
      const userMsg: HistoryItem = {
        key: `user-${Date.now()}`,
        role: 'user',
        content: action.input,
        ts: Date.now(),
      };
      return {
        ...state,
        ...flushed,
        inputHistory: newHistory,
        inputValue: '',
        slashSuggestions: null,
        history: [...flushed.history, userMsg],
        messages: [...state.messages, { role: 'user', content: action.input }],
        phase: 'thinking',
        toolStatuses: [],
        bgTasks: [],
        error: null,
        notice: null,
        submitSeq: state.submitSeq + 1,
      };
    }

    case 'ADD_SYSTEM_MSG': {
      return {
        ...state,
        history: [...state.history, {
          // Parallel sub-agent callbacks can arrive within one millisecond.
          // Static item keys must remain unique or React may drop/reuse rows.
          key: `system-${Date.now()}-${++systemMessageSequence}`,
          role: 'system' as const,
          content: action.content,
          ts: Date.now(),
        }],
      };
    }

    case 'THINKING_START': {
      // 新一轮 LLM 请求开始：遗留的未完成 tail/块冻结为静态行，
      // 让 thinking spinner 得以显示（showThinking 要求 tail 为空）
      const flushed = flushStreamState(state);
      return { ...state, ...flushed, phase: 'thinking' };
    }

    case 'TOKEN': {
      // 完成整行立即冻结进 history（<Static> 增量写入终端回滚区），
      // 未完成的一行留在 streamingTail（动态区实时刷新）。
      // 代码围栏状态跨 action 由 streamFenceOpen 维持。
      // 表格/公式块在 pendingBlock 中缓冲，完整后整体冻结为一个静态项。
      const nextPhase = state.phase !== 'idle' && state.phase !== 'confirming'
        ? 'streaming'
        : state.phase;
      const { completed, tail } = splitStreaming(state.streamingTail + action.token);
      let fenceOpen = state.streamFenceOpen;
      let pendingBlock = state.pendingBlock;
      const newLines: HistoryItem[] = [];
      for (const line of completed) {
        // 代码围栏由 ingestStreamLine 缓冲为整块（assistant-block code），
        // 围栏内不再逐行冻结；streamFenceOpen 用于标记尾行处于代码块内
        const res = ingestStreamLine(line, pendingBlock);
        pendingBlock = res.pendingBlock;
        fenceOpen = pendingBlock?.kind === 'code';
        for (const item of res.flush) {
          if (item.role === 'assistant-line') {
            newLines.push({
              key: `line-${state.history.length + newLines.length}`,
              role: 'assistant-line' as const,
              content: item.content,
              code: false,
            });
          } else {
            newLines.push({
              key: `block-${state.history.length + newLines.length}`,
              role: 'assistant-block' as const,
              content: item.content,
              blockKind: item.blockKind,
              lang: item.lang,
            });
          }
        }
      }
      return {
        ...state,
        phase: nextPhase,
        streamingTail: tail,
        streamFenceOpen: fenceOpen,
        pendingBlock,
        history: newLines.length > 0 ? [...state.history, ...newLines] : state.history,
      };
    }

    case 'THINKING_END': {
      return { ...state, phase: 'streaming' };
    }

    case 'TOOL_START': {
      return {
        ...state,
        phase: 'tools',
        toolStatuses: [...state.toolStatuses.filter(status => !status.grouped || status.state === 'running'), {
          grouped: action.grouped,
          id: action.id,
          name: action.name,
          detail: action.detail,
          state: 'running' as const,
          startTime: Date.now(),
        }],
      };
    }

    case 'TOOL_DONE': {
      return finalizeToolStep(state, action.id, 'done', action.detail, undefined, action.recordHistory !== false);
    }

    case 'TOOL_RESULT': {
      return {
        ...state,
        history: [...state.history, {
          key: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'tool' as const,
          content: action.content,
          ts: Date.now(),
          toolError: action.isError || undefined,
          fileChange: action.fileChange,
        }],
      };
    }

    case 'TOOL_GROUP_RESULT': {
      const ts = Date.now();
      return {
        ...state,
        toolStatuses: state.toolStatuses.filter(status => !status.grouped || status.state === 'running'),
        history: [
          ...state.history,
          {
            key: `tool-group-step-${action.id}`,
            role: 'tool-step' as const,
            content: '',
            toolStep: {
              id: action.id,
              name: action.name,
              detail: action.detail,
              outcome: action.outcome,
              durationMs: action.durationMs,
              runs: action.runs,
            },
          },
          {
            key: `tool-group-result-${action.id}`,
            role: 'tool' as const,
            content: action.content,
            ts,
            toolError: action.outcome === 'error' || undefined,
          },
        ],
      };
    }

    case 'TOOL_ERROR': {
      return finalizeToolStep(state, action.id, 'error', undefined, action.error);
    }

    case 'BG_TASK_START': {
      return {
        ...state,
        bgTasks: [...state.bgTasks, { id: action.id, goal: action.goal, startTime: Date.now() }],
      };
    }

    case 'BG_TASK_DONE': {
      return {
        ...state,
        bgTasks: state.bgTasks.filter(b => b.id !== action.id),
        notice: action.success
          ? `✓ bg: ${action.goal} done`
          : `✗ bg: ${action.goal} failed: ${action.summary.split('\n')[0]!.slice(0, 60)}`,
      };
    }

    case 'TODOS': {
      return { ...state, todos: action.todos, taskListSource: 'todos' };
    }

    case 'PLAN': {
      return { ...state, plan: action.plan, taskListSource: 'plan' };
    }

    case 'CONFIRM_PROMPT': {
      return {
        ...state,
        phase: 'confirming',
        confirmPrompt: action.prompt,
      };
    }

    case 'CONFIRM_RESULT': {
      // “No, and tell me what to do differently” → 进入反馈输入模式（弹窗保持）
      if (action.result === 'feedback' && state.confirmPrompt) {
        return {
          ...state,
          confirmPrompt: { ...state.confirmPrompt, feedbackMode: true, feedbackText: '' },
        };
      }
      resolveConfirmResult(action.result);
      // 确认结束：未完成 tail 与未闭合块统一落为静态项
      const flushed = flushStreamState(state);
      return {
        ...state,
        ...flushed,
        phase: 'idle',
        confirmPrompt: null,
      };
    }

    case 'CONFIRM_FEEDBACK_INPUT': {
      if (!state.confirmPrompt?.feedbackMode) return state;
      return {
        ...state,
        confirmPrompt: { ...state.confirmPrompt, feedbackText: action.text },
      };
    }

    case 'CLEAR_CONTEXT': {
      return {
        ...state,
        messages: [],
        history: [],
        inputHistory: [],
        todos: [],
        plan: [],
        error: null,
        phase: 'idle',
        toolStatuses: [],
        bgTasks: [],
        mcpPanel: null,
        skillsPanel: null,
        modelPanel: null,
        keysPanel: null,
        securityPanel: null,
        configPanel: null,
        onboarding: null,
        goal: null,
        slashSuggestions: null,
        notice: null,
      };
    }

    case 'CLEAR_SESSION': {
      // /clear 单动作：清会话 + Static 重挂载 + 确认提示一次完成，
      // 只触发一次渲染，与 resetViewportToTop 的同步视图重置配合，
      // 保证新会话 logo 画在窗口顶部、输入框紧随其下
      return {
        ...state,
        messages: [],
        history: [],
        inputHistory: [],
        todos: [],
        plan: [],
        error: null,
        phase: 'idle',
        toolStatuses: [],
        bgTasks: [],
        mcpPanel: null,
        skillsPanel: null,
        modelPanel: null,
        keysPanel: null,
        securityPanel: null,
        configPanel: null,
        onboarding: null,
        goal: null,
        slashSuggestions: null,
        staticEpoch: state.staticEpoch + 1,
        notice: 'Context cleared — 新会话，输入继续',
      };
    }

    case 'STATIC_RESET': {
      return { ...state, staticEpoch: state.staticEpoch + 1 };
    }

    case 'SET_NOTICE': {
      return { ...state, notice: action.text };
    }

    case 'SET_MODEL': {
      return { ...state, model: action.model };
    }

    case 'CONFIRM_NAVIGATE': {
      if (!state.confirmPrompt) return state;
      const optCount = state.confirmPrompt.options.length;
      let newSel = state.confirmPrompt.selected + action.direction;
      if (newSel < 0) newSel = optCount - 1;
      if (newSel >= optCount) newSel = 0;
      return {
        ...state,
        confirmPrompt: { ...state.confirmPrompt, selected: newSel },
      };
    }

    case 'MCP_PANEL_OPEN': {
      return {
        ...state,
        mcpPanel: {
          servers: action.servers,
          selected: 0,
          busy: false,
          detail: null,
          detailMenu: 0,
          toolsView: false,
        },
        skillsPanel: null,
      };
    }

    case 'MCP_PANEL_UPDATE': {
      if (!state.mcpPanel) return state;
      // 选中项保持：删除/重连后仍指向同名 server（若已不存在则收敛到列表末尾）
      const currentName = state.mcpPanel.servers[state.mcpPanel.selected]?.name;
      let selected = state.mcpPanel.selected;
      if (action.servers.length === 0) {
        selected = 0;
      } else if (action.servers.length <= selected || action.servers[selected]?.name !== currentName) {
        const idx = currentName ? action.servers.findIndex(s => s.name === currentName) : -1;
        selected = idx >= 0 ? idx : Math.max(0, Math.min(selected, action.servers.length - 1));
      }
      // 详情视图：按 name 同步最新状态；server 被删除则退回列表
      let detail = state.mcpPanel.detail;
      let toolsView = state.mcpPanel.toolsView;
      if (detail) {
        detail = action.servers.find(s => s.name === detail!.name) ?? null;
        if (!detail) toolsView = false;
      }
      let detailMenu = state.mcpPanel.detailMenu;
      if (detail) {
        const menuLen = mcpMenuFor(detail).length;
        if (detailMenu >= menuLen) detailMenu = 0;
      }
      return {
        ...state,
        mcpPanel: {
          servers: action.servers,
          selected,
          busy: action.busy ?? false,
          notice: action.notice ?? state.mcpPanel.notice,
          detail,
          detailMenu,
          toolsView,
        },
      };
    }

    case 'MCP_PANEL_SELECT': {
      if (!state.mcpPanel || state.mcpPanel.detail || state.mcpPanel.servers.length === 0) return state;
      const count = state.mcpPanel.servers.length;
      const selected = Math.max(0, Math.min(action.index, count - 1));
      return {
        ...state,
        mcpPanel: { ...state.mcpPanel, selected },
      };
    }

    case 'MCP_PANEL_OPEN_DETAIL': {
      if (!state.mcpPanel) return state;
      return {
        ...state,
        mcpPanel: {
          ...state.mcpPanel,
          detail: action.server,
          detailMenu: 0,
          toolsView: false,
        },
      };
    }

    case 'MCP_PANEL_MENU_SELECT': {
      if (!state.mcpPanel?.detail) return state;
      const menuLen = mcpMenuFor(state.mcpPanel.detail).length;
      const detailMenu = Math.max(0, Math.min(action.index, menuLen - 1));
      return { ...state, mcpPanel: { ...state.mcpPanel, detailMenu } };
    }

    case 'MCP_PANEL_VIEW_TOOLS': {
      if (!state.mcpPanel?.detail) return state;
      return { ...state, mcpPanel: { ...state.mcpPanel, toolsView: true } };
    }

    case 'MCP_PANEL_BACK': {
      if (!state.mcpPanel) return state;
      if (state.mcpPanel.toolsView) {
        return { ...state, mcpPanel: { ...state.mcpPanel, toolsView: false } };
      }
      if (state.mcpPanel.detail) {
        return { ...state, mcpPanel: { ...state.mcpPanel, detail: null, detailMenu: 0 } };
      }
      return { ...state, mcpPanel: null };
    }

    case 'MCP_PANEL_CLOSE': {
      return { ...state, mcpPanel: null };
    }

    case 'SKILLS_PANEL_OPEN': {
      return {
        ...state,
        skillsPanel: { skills: action.skills, selected: 0 },
        mcpPanel: null,
      };
    }

    case 'SKILLS_PANEL_SELECT': {
      if (!state.skillsPanel || state.skillsPanel.skills.length === 0) return state;
      const count = state.skillsPanel.skills.length;
      const selected = Math.max(0, Math.min(action.index, count - 1));
      return { ...state, skillsPanel: { ...state.skillsPanel, selected } };
    }

    case 'SKILLS_PANEL_CLOSE': {
      return { ...state, skillsPanel: null };
    }

    case 'MODEL_PANEL_OPEN': {
      return {
        ...state,
        modelPanel: {
          models: action.models,
          selected: initialModelSelection(action.models),
        },
        mcpPanel: null,
        skillsPanel: null,
      };
    }

    case 'MODEL_PANEL_SELECT': {
      if (!state.modelPanel || state.modelPanel.models.length === 0) return state;
      const count = state.modelPanel.models.length;
      const selected = Math.max(0, Math.min(action.index, count - 1));
      return { ...state, modelPanel: { ...state.modelPanel, selected } };
    }

    case 'MODEL_PANEL_CLOSE': {
      return { ...state, modelPanel: null };
    }

    case 'KEYS_PANEL_OPEN': {
      return {
        ...state,
        keysPanel: {
          providers: action.providers,
          selected: 0,
          inputMode: false,
          inputText: '',
          scope: 'global',
          busy: false,
          customStep: null,
          customBaseUrl: '',
          customApiKey: '',
          customModels: [],
        },
        mcpPanel: null,
        skillsPanel: null,
        modelPanel: null,
        securityPanel: null,
      };
    }

    case 'KEYS_PANEL_SELECT': {
      if (!state.keysPanel || state.keysPanel.inputMode || state.keysPanel.providers.length === 0) return state;
      const count = state.keysPanel.providers.length;
      const selected = Math.max(0, Math.min(action.index, count - 1));
      return { ...state, keysPanel: { ...state.keysPanel, selected } };
    }

    case 'KEYS_PANEL_INPUT_MODE': {
      if (!state.keysPanel) return state;
      return {
        ...state,
        keysPanel: {
          ...state.keysPanel,
          inputMode: action.inputMode,
          inputText: action.inputText ?? '',
          notice: action.inputMode ? undefined : state.keysPanel.notice,
        },
      };
    }

    case 'KEYS_PANEL_INPUT': {
      if (!state.keysPanel?.inputMode) return state;
      return { ...state, keysPanel: { ...state.keysPanel, inputText: action.text } };
    }

    case 'KEYS_PANEL_SAVED': {
      // 首次引导：配置完 key → 进入快速上手 tips 页（一次性）
      if (state.onboarding?.step === 'keys') {
        return {
          ...state,
          keysPanel: null,
          onboarding: {
            ...state.onboarding,
            step: 'tips',
            saved: { provider: action.provider, masked: action.masked },
          },
        };
      }
      if (!state.keysPanel) return state;
      return {
        ...state,
        keysPanel: {
          ...state.keysPanel,
          inputMode: false,
          inputText: '',
          busy: false,
          customStep: null,
          customBaseUrl: '',
          customApiKey: '',
          customModels: [],
          notice: action.notice,
          providers: state.keysPanel.providers.map((p) =>
            p.id === action.provider ? { ...p, masked: action.masked, configured: true } : p,
          ),
        },
      };
    }

    case 'KEYS_PANEL_DELETED': {
      if (!state.keysPanel) return state;
      return {
        ...state,
        keysPanel: {
          ...state.keysPanel,
          inputMode: false,
          inputText: '',
          busy: false,
          notice: action.notice,
          providers: state.keysPanel.providers.map((p) =>
            p.id === action.provider ? { ...p, masked: '(未配置)', configured: false } : p,
          ),
        },
      };
    }

    case 'KEYS_PANEL_SCOPE': {
      if (!state.keysPanel) return state;
      return {
        ...state,
        keysPanel: { ...state.keysPanel, scope: action.scope, notice: undefined },
      };
    }

    case 'KEYS_PANEL_BUSY': {
      if (!state.keysPanel) return state;
      return {
        ...state,
        keysPanel: {
          ...state.keysPanel,
          busy: action.busy,
          notice: action.notice ?? state.keysPanel.notice,
        },
      };
    }

    case 'KEYS_PANEL_CUSTOM_STEP': {
      if (!state.keysPanel) return state;
      return {
        ...state,
        keysPanel: {
          ...state.keysPanel,
          customStep: (action.step as KeysPanelState['customStep']) ?? null,
          customBaseUrl: action.baseUrl ?? state.keysPanel.customBaseUrl,
          customApiKey: action.apiKey ?? state.keysPanel.customApiKey,
          customModels: [],
          inputText: '',
          notice: undefined,
        },
      };
    }

    case 'KEYS_PANEL_CUSTOM_PROBE': {
      // 第 2 步（API Key）后异步探测厂商 /v1/models 的结果回填：
      // 已离开三步录入（保存或取消）时忽略，避免迟到的响应污染面板状态。
      if (!state.keysPanel || state.keysPanel.customStep === null) return state;
      if (action.pending) {
        return {
          ...state,
          keysPanel: {
            ...state.keysPanel,
            customModels: [],
            notice: '正在探测厂商模型清单…',
          },
        };
      }
      const models = action.models ?? [];
      return {
        ...state,
        keysPanel: {
          ...state.keysPanel,
          customModels: models,
          notice: models.length > 0
            ? `发现 ${models.length} 个模型，可按序号选择（或直接输入模型名）`
            : '未获取到模型清单，请手动输入模型名',
        },
      };
    }

    case 'KEYS_PANEL_REFRESH': {
      if (!state.keysPanel) return state;
      return { ...state, keysPanel: { ...state.keysPanel, providers: action.providers } };
    }

    case 'KEYS_PANEL_CLOSE': {
      return { ...state, keysPanel: null };
    }

    case 'CONFIG_PANEL_OPEN': {
      return {
        ...state,
        configPanel: {
          rows: action.rows,
          selected: 0,
          editing: false,
          editText: '',
          scope: 'project',
        },
        mcpPanel: null,
        skillsPanel: null,
        modelPanel: null,
        keysPanel: null,
        securityPanel: null,
      };
    }

    case 'CONFIG_PANEL_SELECT': {
      if (!state.configPanel || state.configPanel.editing || state.configPanel.rows.length === 0) return state;
      const count = state.configPanel.rows.length;
      const selected = Math.max(0, Math.min(action.index, count - 1));
      return { ...state, configPanel: { ...state.configPanel, selected } };
    }

    case 'CONFIG_PANEL_EDIT_START': {
      if (!state.configPanel) return state;
      return { ...state, configPanel: { ...state.configPanel, editing: true, editText: action.text, notice: undefined } };
    }

    case 'CONFIG_PANEL_EDIT_INPUT': {
      if (!state.configPanel?.editing) return state;
      return { ...state, configPanel: { ...state.configPanel, editText: action.text } };
    }

    case 'CONFIG_PANEL_EDIT_CANCEL': {
      if (!state.configPanel) return state;
      return { ...state, configPanel: { ...state.configPanel, editing: false, editText: '' } };
    }

    case 'CONFIG_PANEL_NOTICE': {
      if (!state.configPanel) return state;
      return { ...state, configPanel: { ...state.configPanel, notice: action.text } };
    }

    case 'CONFIG_PANEL_SCOPE': {
      if (!state.configPanel) return state;
      return { ...state, configPanel: { ...state.configPanel, scope: action.scope, notice: undefined } };
    }

    case 'CONFIG_PANEL_REFRESH': {
      if (!state.configPanel) return state;
      return { ...state, configPanel: { ...state.configPanel, rows: action.rows } };
    }

    case 'CONFIG_PANEL_CLOSE': {
      return { ...state, configPanel: null };
    }

    case 'SECURITY_PANEL_OPEN': {
      return {
        ...state,
        securityPanel: {
          hook: action.hook,
          trackedSensitive: action.trackedSensitive,
          selected: 0,
          busy: false,
        },
        mcpPanel: null,
        skillsPanel: null,
        modelPanel: null,
        keysPanel: null,
      };
    }

    case 'SECURITY_PANEL_SELECT': {
      if (!state.securityPanel) return state;
      const max = securityMenuLength(state.securityPanel);
      const selected = Math.max(0, Math.min(action.index, Math.max(0, max - 1)));
      return { ...state, securityPanel: { ...state.securityPanel, selected } };
    }

    case 'SECURITY_PANEL_UPDATE': {
      if (!state.securityPanel) return state;
      return {
        ...state,
        securityPanel: {
          ...state.securityPanel,
          hook: action.hook ?? state.securityPanel.hook,
          busy: action.busy ?? state.securityPanel.busy,
          notice: action.notice ?? state.securityPanel.notice,
        },
      };
    }

    case 'SECURITY_PANEL_CLOSE': {
      return { ...state, securityPanel: null };
    }

    case 'ONBOARDING_OPEN': {
      return {
        ...state,
        onboarding: { step: 'welcome', providers: action.providers },
        mcpPanel: null,
        skillsPanel: null,
        modelPanel: null,
        keysPanel: null,
        securityPanel: null,
      };
    }

    case 'ONBOARDING_START': {
      if (!state.onboarding) return state;
      return {
        ...state,
        onboarding: { ...state.onboarding, step: 'keys' },
        keysPanel: {
          providers: state.onboarding.providers,
          selected: 0,
          inputMode: false,
          inputText: '',
          scope: 'global',
          busy: false,
          customStep: null,
          customBaseUrl: '',
          customApiKey: '',
          customModels: [],
        },
        mcpPanel: null,
        skillsPanel: null,
        modelPanel: null,
        securityPanel: null,
      };
    }

    case 'ONBOARDING_BACK': {
      if (!state.onboarding) return state;
      return {
        ...state,
        onboarding: { ...state.onboarding, step: 'welcome' },
        keysPanel: null,
      };
    }

    case 'ONBOARDING_SKIP': {
      return { ...state, onboarding: null, keysPanel: null };
    }

    case 'ONBOARDING_CLOSE': {
      return { ...state, onboarding: null, keysPanel: null };
    }

    case 'GOAL_SET': {
      return { ...state, goal: { text: action.text, status: 'active' } };
    }

    case 'GOAL_PAUSE': {
      if (!state.goal) return state;
      return { ...state, goal: { ...state.goal, status: 'paused' } };
    }

    case 'GOAL_RESUME': {
      if (!state.goal) return state;
      const goal = { ...state.goal, status: 'active' as const };
      const text = `继续执行目标：${goal.text}`;
      const userMsg: HistoryItem = {
        key: `user-${Date.now()}`,
        role: 'user',
        content: text,
        ts: Date.now(),
      };
      return {
        ...state,
        goal,
        history: [...state.history, userMsg],
        messages: [...state.messages, { role: 'user', content: text }],
        phase: 'thinking',
        toolStatuses: [],
        bgTasks: [],
        error: null,
        notice: null,
        submitSeq: state.submitSeq + 1,
      };
    }

    case 'GOAL_CLEAR': {
      return {
        ...state,
        goal: null,
        messages: state.messages.map((m) =>
          m.role === 'system' ? { ...m, content: stripGoalBlock(messageTextOf(m)) } : m,
        ),
      };
    }

    case 'GOAL_COMPLETE': {
      if (!state.goal) return state;
      return { ...state, goal: { ...state.goal, status: 'completed' } };
    }

    case 'COMPLETE': {
      // 完成：未闭合块与未完成 tail 统一落盘（已冻结的行不重复）
      const flushed = flushStreamState(state);
      // Sync messages from agent loop (has tool responses added by runAgentLoop)
      const synced = (globalThis as any).__shenlanAgentMessages || state.messages;
      // 任务结束清理本次任务的 todo/plan（plan 模式保留：计划是跨轮产物）
      const clearTransient = getMode() !== 'plan';

      return {
        ...state,
        ...flushed,
        phase: 'idle',
        toolStatuses: [],
        bgTasks: [],
        todos: clearTransient ? [] : state.todos,
        plan: clearTransient ? [] : state.plan,
        messages: synced,
        history: flushed.history,
      };
    }

    case 'ERROR': {
      const flushed = flushStreamState(state);
      const clearTransient = getMode() !== 'plan';
      return {
        ...state,
        ...flushed,
        phase: 'idle',
        error: action.error,
        todos: clearTransient ? [] : state.todos,
        plan: clearTransient ? [] : state.plan,
        history: flushed.history,
        toolStatuses: [],
        bgTasks: [],
      };
    }

    case 'CLEAR_ERROR': {
      return { ...state, error: null };
    }

    case 'SET_INPUT': {
      // 斜杠命令联想：`/` 开头且尚未输入参数（无空格）时，按已输入字母过滤命令列表
      const value = action.value;
      const trimmed = value.trim();
      let slashSuggestions: SlashSuggestions | null = null;
      if (trimmed.startsWith('/') && !/\s/.test(value)) {
        const matches = SLASH_COMMANDS.filter(c =>
          c.toLowerCase().startsWith(trimmed.toLowerCase()),
        );
        if (matches.length > 0) {
          const prevSelected = state.slashSuggestions?.selected ?? 0;
          slashSuggestions = {
            matches,
            selected: Math.min(prevSelected, matches.length - 1),
          };
        }
      }
      return { ...state, inputValue: value, slashSuggestions };
    }

    case 'SET_SLASH': {
      return { ...state, slashSuggestions: action.slashSuggestions };
    }

    case 'SLASH_SELECT': {
      if (!state.slashSuggestions || state.slashSuggestions.matches.length === 0) return state;
      const count = state.slashSuggestions.matches.length;
      const selected = Math.max(0, Math.min(action.index, count - 1));
      return { ...state, slashSuggestions: { ...state.slashSuggestions, selected } };
    }

    case 'DIFF_SHOW': {
      return { ...state, phase: 'diff' };
    }

    default:
      return state;
  }
}

/**
 * 工具终态同时写入动态状态与静态步骤。
 * 仅 running -> terminal 的第一次转换会追加 history，避免重复回调产生重复行。
 */
function finalizeToolStep(
  state: AppState,
  id: string,
  outcome: 'done' | 'error',
  detailOverride?: string,
  statusDetailOverride?: string,
  recordHistory = true,
): AppState {
  const active = state.toolStatuses.find(status => status.id === id);
  if (!active || active.state !== 'running') return state;

  const endTime = Date.now();
  const detail = detailOverride || active.detail;
  const step: HistoryItem = {
    key: `tool-step-${id}`,
    role: 'tool-step',
    content: '',
    toolStep: {
      id,
      name: active.name,
      detail,
      outcome,
      durationMs: Math.max(0, endTime - active.startTime),
    },
  };

  return {
    ...state,
    history: recordHistory ? [...state.history, step] : state.history,
    toolStatuses: state.toolStatuses.map(status =>
      status.id === id
        ? {
            ...status,
            state: outcome,
            detail: statusDetailOverride || detail,
            endTime,
          }
        : status
    ),
  };
}

/** 退出路径统一 flush：未闭合块先冻结为静态项，未完成 tail 落为最后一行 */
function flushStreamState(state: AppState): Pick<
  AppState,
  'history' | 'pendingBlock' | 'streamingTail' | 'streamFenceOpen'
> {
  const history = [...state.history];
  for (const item of flushPendingBlock(state.pendingBlock)) {
    history.push(flushItemToHistory(history, item));
  }
  if (state.streamingTail) {
    history.push({
      key: `line-${history.length}`,
      role: 'assistant-line' as const,
      content: state.streamingTail,
      code: state.streamFenceOpen,
    });
  }
  return { history, pendingBlock: null, streamingTail: '', streamFenceOpen: false };
}

function flushItemToHistory(history: HistoryItem[], item: FlushItem): HistoryItem {
  if (item.role === 'assistant-line') {
    return {
      key: `line-${history.length}`,
      role: 'assistant-line',
      content: item.content,
      code: false,
    };
  }
  return {
    key: `block-${history.length}`,
    role: 'assistant-block',
    content: item.content,
    blockKind: item.blockKind,
    lang: item.lang,
  };
}

// ===== Helpers =====

export function messagesToHistory(msgs: Array<import('@shenlan/core').Message>): HistoryItem[] {
  const history: HistoryItem[] = [];
  const shellCommandByCallId = new Map<string, string>();
  let lastShell: { command: string; output: string; itemIndex: number } | null = null;

  for (const [index, message] of msgs.entries()) {
    for (const call of message.tool_calls ?? []) {
      if (call.function.name !== 'shell') continue;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as { command?: unknown };
        if (typeof args.command === 'string') shellCommandByCallId.set(call.id, args.command.trim());
      } catch { /* malformed historical arguments remain ungrouped */ }
    }
    if (message.role === 'system' || !message.content) continue;

    const content = typeof message.content === 'string' ? message.content : messageTextOf(message);
    const shellCommand = message.role === 'tool' && message.tool_call_id
      ? shellCommandByCallId.get(message.tool_call_id)
      : undefined;
    if (shellCommand !== undefined) {
      const activities = shellActivities(shellCommand);
      if (activities.length) {
        lastShell = null;
        const result = shellActivityLines({ id: String(index), activities, phase: 'finished', output: content });
        for (const [lineIndex, line] of result.lines.entries()) {
          history.push({ key: `activity-${index}-${lineIndex}`, role: 'tool', content: line, toolError: result.failed || undefined });
        }
        continue;
      }
      const previous: { command: string; output: string; itemIndex: number } | null =
        lastShell && lastShell.command === shellCommand ? lastShell : null;
      const output = content;
      const renderedOutput = previous
        ? formatShellOutputChange(previous.output, output)
        : output.split('\n').find(line => line.trim())?.trim() || '(no output)';
      const shellItem: HistoryItem = {
        key: `tool-shell-${index}`,
        role: 'tool',
        content: `shell ${shellCommand}: ${renderedOutput}`,
      };
      let itemIndex: number;
      if (previous) {
        itemIndex = previous.itemIndex;
        history[itemIndex] = shellItem;
      } else {
        itemIndex = history.length;
        history.push(shellItem);
      }
      lastShell = { command: shellCommand, output, itemIndex };
      continue;
    }

    lastShell = null;
    history.push({
      key: `${message.role}-${index}`,
      role: message.role as HistoryItem['role'],
      content,
    });
  }
  return history;
}

// ===== /goal 辅助 =====

const GOAL_BLOCK_RE = /<!-- shenlan-goal -->[\s\S]*?<!-- \/shenlan-goal -->/;

/** 从 system 消息中提取 goal（--resume 时从 JSONL 恢复） */
export function extractGoalFromMessages(
  msgs: Array<import('@shenlan/core').Message>,
): AppState['goal'] {
  for (const m of msgs) {
    if (m.role !== 'system' || !m.content) continue;
    const sysContent = typeof m.content === 'string' ? m.content : '';
    const block = sysContent.match(GOAL_BLOCK_RE);
    if (!block) continue;
    const inner = block[0]
      .replace(/<!-- shenlan-goal -->/, '')
      .replace(/<!-- \/shenlan-goal -->/, '');
    // 目标文本在「## 当前目标（goal mode）」与固定指令行之间
    const goalMatch = inner.match(/## 当前目标（goal mode）\s*\n([\s\S]*?)\n?\s*持续执行直到目标达成/);
    const text = (goalMatch ? goalMatch[1] : inner.replace(/^## 当前目标（goal mode）\s*/, '').trim()).trim();
    if (text) return { text, status: 'active' };
  }
  return null;
}

/** 移除 system 消息里的 goal 段落（/goal clear） */
export function stripGoalBlock(content: string): string {
  return content.replace(GOAL_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}
