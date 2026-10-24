/**
 * 原生滚动回滚区集成测试 harness：
 * 把 TUI 布局（<Static> + DynamicRegion + InputBox）渲染到内存 TTY 流，
 * 用字节流断言「无整屏清屏序列 / 静态行只写一次 / 完成后不重复」。
 */
import React, { useCallback, useReducer } from 'react';
import { PassThrough } from 'node:stream';
import { Box, Static } from 'ink';
import { AppContext } from '../context.js';
import type { AppContextType, AppState, AppAction } from '../context.js';
import type { ShenlanConfig } from '@shenlan/core';
import { DynamicRegion } from '../components/DynamicRegion.js';
import { InputBox } from '../components/InputBox.js';
import { buildFrozenItems } from '../frozen-items.js';
import { reducer } from '../app.js';

export function baseState(partial: Partial<AppState> = {}): AppState {
  return {
    history: [],
    messages: [],
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
    goal: null,
    slashSuggestions: null,
    inputHistory: [],
    inputValue: '',
    error: null,
    notice: null,
    model: 'test-model',
    sessionId: 'test',
    submitSeq: 0,
    staticEpoch: 0,
    ...partial,
  };
}

const testConfig: ShenlanConfig = {
  model: { baseUrl: 'http://localhost', apiKey: 'test', model: 'test', maxTokens: 100 },
  permissions: { mode: 'default', allow: [], deny: [] },
  skills: [],
  mcpServers: [],
};

export function TuiHarness({ state, termHeight = 40, termWidth = 100 }: {
  state: AppState;
  termHeight?: number;
  termWidth?: number;
}) {
  const ctx: AppContextType = {
    config: testConfig,
    mode: 'default',
    model: 'test-model',
    termWidth,
    termHeight,
    state,
    dispatch: (() => {}) as unknown as React.Dispatch<AppAction>,
  };
  const frozen = buildFrozenItems(state, 'test', termWidth);
  return (
    <AppContext.Provider value={ctx}>
      <Box flexDirection="column">
        {/* 镜像 app.tsx：/clear 后 staticEpoch+1 重挂载，从 index 0 重绘 */}
        <Static key={state.staticEpoch} items={frozen}>{node => node}</Static>
        <DynamicRegion />
        <InputBox />
      </Box>
    </AppContext.Provider>
  );
}

/**
 * 带真实 reducer 的 live harness：输入事件/粘贴能真正派发 action 并驱动重渲染，
 * 用于验证「粘贴整段插入且不触发提交」等交互行为。
 */
export function LiveTuiHarness({ onAction }: { onAction?: (action: AppAction) => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => baseState());
  const wrapped = useCallback((action: AppAction) => {
    onAction?.(action);
    dispatch(action);
  }, [onAction]);
  const ctx: AppContextType = {
    config: testConfig,
    mode: 'default',
    model: 'test-model',
    termWidth: 100,
    termHeight: 40,
    state,
    dispatch: wrapped,
  };
  const frozen = buildFrozenItems(state, 'test', 100);
  return (
    <AppContext.Provider value={ctx}>
      <Box flexDirection="column">
        <Static key={state.staticEpoch} items={frozen}>{node => node}</Static>
        <DynamicRegion />
        <InputBox />
      </Box>
    </AppContext.Provider>
  );
}

/** 伪造 TTY 流（Ink 按 stdout.columns/rows + isTTY 决定交互渲染与帧高判断） */
export function makeTtyStream(type: 'stdout' | 'stdin') {
  const stream = new PassThrough();
  // stdout 与 stdin 都要 isTTY: true：Ink 的 isInteractive 默认推断会检查 stdin，
  // POSIX 下缺 isTTY 会被判非交互 → 主输出不渲染（model-panel 测试踩过）
  Object.assign(stream, { isTTY: true });
  if (type === 'stdout') {
    Object.assign(stream, { columns: 100, rows: 40 });
  } else {
    Object.assign(stream, {
      setRawMode: () => stream,
      ref: () => stream,
      unref: () => stream,
    });
  }
  return stream as unknown as NodeJS.WriteStream & NodeJS.ReadStream;
}
