import { describe, expect, it } from 'vitest';
import type { AppState, ModelOption } from '../context.js';
import { reducer, extractGoalFromMessages, stripGoalBlock } from '../app.js';
import { setMode } from '../mode.js';
import type { McpServerStatus, SkillEntry } from '@shenlan/core';
import type { ConfigRow } from '../commands/config.js';

function baseState(overrides: Partial<AppState> = {}): AppState {
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
    model: 'deepseek-v4-flash',
    sessionId: 'test',
    submitSeq: 0,
    staticEpoch: 0,
    ...overrides,
  };
}

describe('reducer 后台任务 UI 状态（BG_TASK_START / BG_TASK_DONE）', () => {
  it('BG_TASK_START 追加运行中后台任务', () => {
    const s = reducer(baseState(), { type: 'BG_TASK_START', id: 'bg-1', goal: '研究定价' });
    expect(s.bgTasks).toEqual([{ id: 'bg-1', goal: '研究定价', startTime: expect.any(Number) }]);
  });

  it('BG_TASK_DONE 移除任务并设成功瞬态通知', () => {
    let s = reducer(baseState(), { type: 'BG_TASK_START', id: 'bg-1', goal: 'g' });
    s = reducer(s, { type: 'BG_TASK_DONE', id: 'bg-1', goal: 'g', success: true, summary: '结论' });
    expect(s.bgTasks).toHaveLength(0);
    expect(s.notice).toBe('✓ bg: g done');
  });

  it('BG_TASK_DONE 失败通知含失败标记与摘要首行', () => {
    let s = reducer(baseState(), { type: 'BG_TASK_START', id: 'bg-2', goal: 'g2' });
    s = reducer(s, {
      type: 'BG_TASK_DONE', id: 'bg-2', goal: 'g2', success: false,
      summary: '第一行原因\n第二行',
    });
    expect(s.bgTasks).toHaveLength(0);
    expect(s.notice).toBe('✗ bg: g2 failed: 第一行原因');
  });

  it('CLEAR_SESSION 清空 bgTasks', () => {
    let s = reducer(baseState(), { type: 'BG_TASK_START', id: 'bg-1', goal: 'g' });
    s = reducer(s, { type: 'CLEAR_SESSION' });
    expect(s.bgTasks).toHaveLength(0);
  });
});

describe('reducer THINKING_START（新一轮 LLM 请求的 working 提示）', () => {
  it('冻结遗留 tail 并进入 thinking，spinner 可显示', () => {
    const state = baseState({
      phase: 'tools',
      streamingTail: '我先看看这个项目的当前状态',
    });
    const next = reducer(state, { type: 'THINKING_START' });

    expect(next.phase).toBe('thinking');
    expect(next.streamingTail).toBe('');
    expect(
      next.history.some(
        h => h.role === 'assistant-line' && h.content === '我先看看这个项目的当前状态',
      ),
    ).toBe(true);
  });

  it('无遗留 tail 时仅切换 phase，不产生新历史项', () => {
    const state = baseState({ phase: 'tools', streamingTail: '' });
    const next = reducer(state, { type: 'THINKING_START' });

    expect(next.phase).toBe('thinking');
    expect(next.history).toHaveLength(0);
  });
});

describe('reducer TOOL_DONE（工具步骤固化）', () => {
  it('先固化一次工具步骤，再追加结果摘要', () => {
    const started = reducer(baseState(), {
      type: 'TOOL_START', id: 'call-1', name: 'read', detail: 'src/a.ts',
    });
    const withElapsed = {
      ...started,
      toolStatuses: started.toolStatuses.map(status => ({
        ...status,
        startTime: Date.now() - 250,
      })),
    };
    const done = reducer(withElapsed, {
      type: 'TOOL_DONE', id: 'call-1', name: 'read', detail: 'src/a.ts',
    });

    expect(done.history).toHaveLength(1);
    expect(done.history[0]).toMatchObject({
      key: 'tool-step-call-1',
      role: 'tool-step',
      toolStep: {
        id: 'call-1',
        name: 'read',
        detail: 'src/a.ts',
        outcome: 'done',
      },
    });
    expect(done.history[0]?.toolStep?.durationMs).toBeGreaterThanOrEqual(200);

    const duplicate = reducer(done, {
      type: 'TOOL_DONE', id: 'call-1', name: 'read', detail: 'src/a.ts',
    });
    expect(duplicate).toBe(done);

    const withResult = reducer(done, {
      type: 'TOOL_RESULT',
      id: 'call-1',
      name: 'read',
      detail: 'src/a.ts',
      content: 'read a.ts: 12 lines',
      isError: false,
    });
    expect(withResult.history.map(item => item.role)).toEqual(['tool-step', 'tool']);
  });

  it('未知或已结束的调用不重复固化，TOOL_ERROR 保留错误终态', () => {
    const untouched = reducer(baseState(), {
      type: 'TOOL_DONE', id: 'missing', name: 'read', detail: 'x',
    });
    expect(untouched.history).toEqual([]);

    const started = reducer(baseState(), {
      type: 'TOOL_START', id: 'call-2', name: 'shell', detail: 'exit 1',
    });
    const failed = reducer(started, {
      type: 'TOOL_ERROR', id: 'call-2', name: 'shell', error: 'code 1',
    });
    expect(failed.history[0]?.toolStep).toMatchObject({
      id: 'call-2',
      name: 'shell',
      detail: 'exit 1',
      outcome: 'error',
    });
    expect(failed.toolStatuses[0]).toMatchObject({ state: 'error', detail: 'code 1' });
  });
});

describe('reducer SET_INPUT（输入框多行值）', () => {
  it('更新 inputValue（含换行）', () => {
    const next = reducer(baseState(), {
      type: 'SET_INPUT',
      value: 'const a = 1;\nconst b = 2;',
    });

    expect(next.inputValue).toBe('const a = 1;\nconst b = 2;');
    expect(next.slashSuggestions).toBeNull();
  });

  it('覆盖旧输入值', () => {
    const next = reducer(
      baseState({ inputValue: 'old' }),
      { type: 'SET_INPUT', value: 'new' },
    );

    expect(next.inputValue).toBe('new');
  });
});

describe('reducer MODEL_PANEL（/model 面板）', () => {
  const models: ModelOption[] = [
    { kind: 'auto', model: 'Default', provider: 'auto', group: '自动路由', contextWindow: 0, available: true, current: true, tag: '自动路由', priceText: '' },
    { kind: 'model', model: 'a', provider: 'x', group: 'X', contextWindow: 128_000, available: false, current: false, tag: '快速', priceText: '' },
    { kind: 'model', model: 'b', provider: 'x', group: 'X', contextWindow: 128_000, available: true, current: false, tag: '均衡', priceText: '' },
  ];

  it('MODEL_PANEL_OPEN 打开面板并关闭其他面板，初始选中当前项', () => {
    const next = reducer(baseState({ skillsPanel: { skills: [], selected: 0 } }), {
      type: 'MODEL_PANEL_OPEN',
      models,
    });
    expect(next.modelPanel).toEqual({ models, selected: 0 });
    expect(next.skillsPanel).toBeNull();
  });

  it('MODEL_PANEL_OPEN 无当前项时初始选中首个可用项', () => {
    const noCurrent: ModelOption[] = [
      { kind: 'model', model: 'a', provider: 'x', group: 'X', contextWindow: 128_000, available: false, current: false, tag: '快速', priceText: '' },
      { kind: 'model', model: 'b', provider: 'x', group: 'X', contextWindow: 128_000, available: true, current: false, tag: '均衡', priceText: '' },
    ];
    const next = reducer(baseState(), { type: 'MODEL_PANEL_OPEN', models: noCurrent });
    expect(next.modelPanel?.selected).toBe(1);
  });

  it('MODEL_PANEL_SELECT 越界钳制', () => {
    const state = baseState({ modelPanel: { models, selected: 0 } });
    expect(reducer(state, { type: 'MODEL_PANEL_SELECT', index: 99 }).modelPanel?.selected).toBe(2);
    expect(reducer(state, { type: 'MODEL_PANEL_SELECT', index: -5 }).modelPanel?.selected).toBe(0);
  });

  it('MODEL_PANEL_CLOSE 关闭面板', () => {
    const state = baseState({ modelPanel: { models, selected: 1 } });
    expect(reducer(state, { type: 'MODEL_PANEL_CLOSE' }).modelPanel).toBeNull();
  });
});

describe('reducer 斜杠命令联想', () => {
  it('按已输入字母过滤命令，带空格（进入参数）后隐藏', () => {
    const next = reducer(baseState(), { type: 'SET_INPUT', value: '/m' });
    expect(next.slashSuggestions?.matches).toContain('/model');
    expect(next.slashSuggestions?.matches).toContain('/mcp');
    expect(next.slashSuggestions?.matches).toContain('/memory');

    const exact = reducer(next, { type: 'SET_INPUT', value: '/mcp' });
    expect(exact.slashSuggestions?.matches).toEqual(['/mcp']);

    expect(reducer(exact, { type: 'SET_INPUT', value: '/mcp add demo' }).slashSuggestions).toBeNull();
    // 输入参数前的空格即隐藏联想
    expect(reducer(exact, { type: 'SET_INPUT', value: '/mcp ' }).slashSuggestions).toBeNull();
    expect(reducer(exact, { type: 'SET_INPUT', value: '普通输入' }).slashSuggestions).toBeNull();
    // 绝对路径不是命令
    expect(reducer(exact, { type: 'SET_INPUT', value: '/Users/edy/x' }).slashSuggestions).toBeNull();
  });

  it('SLASH_SELECT 选择并收敛越界下标', () => {
    const withSlash = reducer(baseState(), { type: 'SET_INPUT', value: '/m' });
    const next = reducer(withSlash, { type: 'SLASH_SELECT', index: 2 });
    expect(next.slashSuggestions?.selected).toBe(2);
    const clamped = reducer(next, { type: 'SLASH_SELECT', index: 99 });
    const count = clamped.slashSuggestions!.matches.length;
    expect(clamped.slashSuggestions?.selected).toBe(count - 1);
  });

  it('SET_SLASH 手动设置/清除，SUBMIT_INPUT 清空', () => {
    const set = reducer(baseState(), {
      type: 'SET_SLASH',
      slashSuggestions: { matches: ['/mcp'], selected: 0 },
    });
    expect(set.slashSuggestions?.matches).toEqual(['/mcp']);
    expect(reducer(set, { type: 'SET_SLASH', slashSuggestions: null }).slashSuggestions).toBeNull();

    const submitted = reducer(set, { type: 'SUBMIT_INPUT', input: '/mcp' });
    expect(submitted.slashSuggestions).toBeNull();
  });
});

describe('reducer TOOL_RESULT（文件变更卡片数据）', () => {
  it('携带 fileChange 时存入历史项', () => {
    const next = reducer(baseState(), {
      type: 'TOOL_RESULT',
      id: 'c1',
      name: 'write',
      detail: 'a.txt',
      content: 'write a.txt: done',
      isError: false,
      fileChange: { path: 'a.txt', kind: 'add', lines: ['x'], truncated: false },
    });

    expect(next.history).toHaveLength(1);
    expect(next.history[0].role).toBe('tool');
    expect(next.history[0].fileChange).toEqual({
      path: 'a.txt',
      kind: 'add',
      lines: ['x'],
      truncated: false,
    });
  });

  it('无 fileChange 时历史项不残留该字段（渲染路径与现状一致）', () => {
    const next = reducer(baseState(), {
      type: 'TOOL_RESULT',
      id: 'c1',
      name: 'read',
      detail: 'a.txt',
      content: 'read a.txt: 1 lines',
      isError: false,
    });

    expect(next.history).toHaveLength(1);
    expect(next.history[0].fileChange).toBeUndefined();
  });

  it('错误结果不带 fileChange（即使工具是 write）', () => {
    const next = reducer(baseState(), {
      type: 'TOOL_RESULT',
      id: 'c1',
      name: 'write',
      detail: 'a.txt',
      content: '✖ Failed to write file: EACCES',
      isError: true,
      fileChange: undefined,
    });

    expect(next.history[0].toolError).toBe(true);
    expect(next.history[0].fileChange).toBeUndefined();
  });
});

describe('reducer TODOS / PLAN（todo_write / update_plan 状态同步）', () => {
  it('TODOS 设置待办清单', () => {
    const next = reducer(baseState(), {
      type: 'TODOS',
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'pending' },
      ],
    });

    expect(next.todos).toEqual([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
    ]);
  });

  it('TODOS 整体覆盖旧清单', () => {
    const next = reducer(
      baseState({
        todos: [
          { content: 'old', status: 'pending' },
          { content: 'gone', status: 'completed' },
        ],
      }),
      { type: 'TODOS', todos: [{ content: 'new', status: 'completed' }] },
    );

    expect(next.todos).toEqual([{ content: 'new', status: 'completed' }]);
  });

  it('TODOS 空数组清空清单', () => {
    const next = reducer(
      baseState({ todos: [{ content: 'a', status: 'pending' }] }),
      { type: 'TODOS', todos: [] },
    );

    expect(next.todos).toEqual([]);
  });

  it('PLAN 设置/覆盖/清空计划', () => {
    const set = reducer(baseState(), {
      type: 'PLAN',
      plan: [
        { step: '1', status: 'in_progress' },
        { step: '2', status: 'pending' },
      ],
    });
    expect(set.plan).toEqual([
      { step: '1', status: 'in_progress' },
      { step: '2', status: 'pending' },
    ]);

    const overwrite = reducer(set, {
      type: 'PLAN',
      plan: [{ step: '1', status: 'completed' }],
    });
    expect(overwrite.plan).toEqual([{ step: '1', status: 'completed' }]);

    const cleared = reducer(overwrite, { type: 'PLAN', plan: [] });
    expect(cleared.plan).toEqual([]);
  });

  it('CLEAR_CONTEXT 同时清空 todos 与 plan', () => {
    const next = reducer(
      baseState({
        todos: [{ content: 'a', status: 'pending' }],
        plan: [{ step: 'b', status: 'in_progress' }],
        history: [{ key: 'u1', role: 'user', content: 'x' }],
      }),
      { type: 'CLEAR_CONTEXT' },
    );

    expect(next.todos).toEqual([]);
    expect(next.plan).toEqual([]);
  });

  it('CLEAR_SESSION 清空全部会话状态 + staticEpoch+1 + 设置确认提示（/clear 单动作）', () => {
    const next = reducer(
      baseState({
        staticEpoch: 1,
        history: [{ key: 'u1', role: 'user', content: 'x' }],
        messages: [{ role: 'user', content: 'x' }],
        inputHistory: ['旧输入'],
        todos: [{ content: 'a', status: 'pending' }],
        plan: [{ step: 'b', status: 'in_progress' }],
        toolStatuses: [{ id: 't1', name: 'shell', detail: '', state: 'running', startTime: 1 }],
        mcpPanel: { servers: [], selected: 0, busy: false, detail: null, detailMenu: 0, toolsView: false },
        slashSuggestions: { matches: ['/m'], selected: 0 },
        notice: '旧提示',
      }),
      { type: 'CLEAR_SESSION' },
    );

    expect(next.messages).toEqual([]);
    expect(next.history).toEqual([]);
    expect(next.inputHistory).toEqual([]);
    expect(next.todos).toEqual([]);
    expect(next.plan).toEqual([]);
    expect(next.toolStatuses).toEqual([]);
    expect(next.mcpPanel).toBeNull();
    expect(next.slashSuggestions).toBeNull();
    expect(next.staticEpoch).toBe(2);
    expect(next.notice).toBe('Context cleared — 新会话，输入继续');
  });

  it('STATIC_RESET 递增 staticEpoch（/clear 后 Static 重挂载）', () => {
    const next = reducer(baseState({ staticEpoch: 2 }), { type: 'STATIC_RESET' });
    expect(next.staticEpoch).toBe(3);
  });
});

function mkServer(name: string): McpServerStatus {
  return {
    name,
    transport: 'stdio',
    scope: 'project',
    configFile: `/proj/.shenlan/config.json`,
    enabled: true,
    connected: true,
    toolCount: 1,
    tools: ['tool'],
    capabilities: ['tools'],
  };
}

function mkSkill(name: string): SkillEntry {
  return { name, description: `${name} desc`, path: `/skills/${name}/SKILL.md`, dir: `/skills/${name}`, source: 'builtin' };
}

describe('reducer 管理面板（/mcp、/skills）', () => {
  it('MCP_PANEL_OPEN 打开面板并初始化选中项', () => {
    const next = reducer(baseState(), { type: 'MCP_PANEL_OPEN', servers: [mkServer('a'), mkServer('b')] });
    expect(next.mcpPanel?.servers).toHaveLength(2);
    expect(next.mcpPanel?.selected).toBe(0);
    expect(next.skillsPanel).toBeNull();
  });

  it('MCP_PANEL_SELECT 循环选择', () => {
    const opened = reducer(baseState(), { type: 'MCP_PANEL_OPEN', servers: [mkServer('a'), mkServer('b')] });
    const next = reducer(opened, { type: 'MCP_PANEL_SELECT', index: 1 });
    expect(next.mcpPanel?.selected).toBe(1);
    const clamped = reducer(next, { type: 'MCP_PANEL_SELECT', index: 5 });
    expect(clamped.mcpPanel?.selected).toBe(1);
  });

  it('MCP_PANEL_UPDATE 保留同名选中项并更新快照', () => {
    const opened = reducer(baseState(), { type: 'MCP_PANEL_OPEN', servers: [mkServer('a'), mkServer('b')] });
    const moved = reducer(opened, { type: 'MCP_PANEL_SELECT', index: 1 });
    const next = reducer(moved, {
      type: 'MCP_PANEL_UPDATE',
      servers: [mkServer('b'), mkServer('c')],
      busy: false,
      notice: '✓ done',
    });
    expect(next.mcpPanel?.selected).toBe(0); // b 仍在，索引收敛
    expect(next.mcpPanel?.servers.map(s => s.name)).toEqual(['b', 'c']);
    expect(next.mcpPanel?.notice).toBe('✓ done');
  });

  it('MCP_PANEL_CLOSE 关闭面板', () => {
    const opened = reducer(baseState(), { type: 'MCP_PANEL_OPEN', servers: [mkServer('a')] });
    expect(reducer(opened, { type: 'MCP_PANEL_CLOSE' }).mcpPanel).toBeNull();
  });

  it('MCP_PANEL_OPEN_DETAIL 进入详情，BACK 逐级返回', () => {
    const opened = reducer(baseState(), { type: 'MCP_PANEL_OPEN', servers: [mkServer('a')] });
    const detail = reducer(opened, { type: 'MCP_PANEL_OPEN_DETAIL', server: mkServer('a') });
    expect(detail.mcpPanel?.detail?.name).toBe('a');
    expect(detail.mcpPanel?.detailMenu).toBe(0);
    expect(detail.mcpPanel?.toolsView).toBe(false);

    const tools = reducer(detail, { type: 'MCP_PANEL_VIEW_TOOLS' });
    expect(tools.mcpPanel?.toolsView).toBe(true);
    const backToDetail = reducer(tools, { type: 'MCP_PANEL_BACK' });
    expect(backToDetail.mcpPanel?.toolsView).toBe(false);
    expect(backToDetail.mcpPanel?.detail?.name).toBe('a');
    const backToList = reducer(backToDetail, { type: 'MCP_PANEL_BACK' });
    expect(backToList.mcpPanel?.detail).toBeNull();
    const closed = reducer(backToList, { type: 'MCP_PANEL_BACK' });
    expect(closed.mcpPanel).toBeNull();
  });

  it('MCP_PANEL_MENU_SELECT 在详情菜单内选择', () => {
    const opened = reducer(baseState(), { type: 'MCP_PANEL_OPEN', servers: [mkServer('a')] });
    const detail = reducer(opened, { type: 'MCP_PANEL_OPEN_DETAIL', server: mkServer('a') });
    // 已连接 server 菜单：View tools / Reconnect / Disable（3 项）
    const next = reducer(detail, { type: 'MCP_PANEL_MENU_SELECT', index: 1 });
    expect(next.mcpPanel?.detailMenu).toBe(1);
    const clamped = reducer(next, { type: 'MCP_PANEL_MENU_SELECT', index: 9 });
    expect(clamped.mcpPanel?.detailMenu).toBe(2);
  });

  it('MCP_PANEL_UPDATE 同步详情最新状态，server 删除后退回列表', () => {
    const opened = reducer(baseState(), { type: 'MCP_PANEL_OPEN', servers: [mkServer('a'), mkServer('b')] });
    const detail = reducer(opened, { type: 'MCP_PANEL_OPEN_DETAIL', server: mkServer('a') });
    const updated = reducer(detail, {
      type: 'MCP_PANEL_UPDATE',
      servers: [{ ...mkServer('a'), enabled: false, connected: false }, mkServer('b')],
      busy: false,
      notice: '○ disabled',
    });
    expect(updated.mcpPanel?.detail?.enabled).toBe(false);

    const removed = reducer(updated, {
      type: 'MCP_PANEL_UPDATE',
      servers: [mkServer('b')],
      busy: false,
      notice: '✕ removed',
    });
    expect(removed.mcpPanel?.detail).toBeNull();
    expect(removed.mcpPanel?.servers.map(s => s.name)).toEqual(['b']);
  });

  it('SKILLS_PANEL_OPEN/SELECT/CLOSE', () => {
    const opened = reducer(baseState(), { type: 'SKILLS_PANEL_OPEN', skills: [mkSkill('x'), mkSkill('y')] });
    expect(opened.skillsPanel?.skills).toHaveLength(2);
    expect(opened.mcpPanel).toBeNull();
    const moved = reducer(opened, { type: 'SKILLS_PANEL_SELECT', index: 1 });
    expect(moved.skillsPanel?.selected).toBe(1);
    expect(reducer(moved, { type: 'SKILLS_PANEL_CLOSE' }).skillsPanel).toBeNull();
  });
});

describe('reducer KEYS_PANEL（/keys 密钥面板）', () => {
  const providers = [
    { id: 'deepseek', name: 'DeepSeek', masked: '****abcd', configured: true, envSet: false, envVar: 'DEEPSEEK_API_KEY' },
    { id: 'qwen', name: 'qwen', masked: '(未配置)', configured: false, envSet: false, envVar: 'QWEN_API_KEY' },
  ];

  it('KEYS_PANEL_OPEN 打开面板并关闭其他面板，默认全局作用域', () => {
    const next = reducer(baseState({ modelPanel: { models: [], selected: 0 } }), {
      type: 'KEYS_PANEL_OPEN',
      providers,
    });
    expect(next.keysPanel).toMatchObject({
      providers,
      selected: 0,
      inputMode: false,
      scope: 'global',
      busy: false,
    });
    expect(next.modelPanel).toBeNull();
  });

  it('KEYS_PANEL_SELECT 输入模式下忽略选择，越界钳制', () => {
    const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
    expect(reducer(opened, { type: 'KEYS_PANEL_SELECT', index: 1 }).keysPanel?.selected).toBe(1);
    expect(reducer(opened, { type: 'KEYS_PANEL_SELECT', index: 99 }).keysPanel?.selected).toBe(1);
    const moved = reducer(opened, { type: 'KEYS_PANEL_SELECT', index: 1 });
    const inputMode = reducer(moved, { type: 'KEYS_PANEL_INPUT_MODE', inputMode: true });
    expect(reducer(inputMode, { type: 'KEYS_PANEL_SELECT', index: 0 }).keysPanel?.selected).toBe(1);
  });

  it('KEYS_PANEL_INPUT_MODE / INPUT 输入文本', () => {
    const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
    const mode = reducer(opened, { type: 'KEYS_PANEL_INPUT_MODE', inputMode: true });
    expect(mode.keysPanel?.inputMode).toBe(true);
    const typed = reducer(mode, { type: 'KEYS_PANEL_INPUT', text: 'sk-abc' });
    expect(typed.keysPanel?.inputText).toBe('sk-abc');
    // 非输入模式下 INPUT 忽略
    expect(reducer(opened, { type: 'KEYS_PANEL_INPUT', text: 'x' }).keysPanel?.inputText).toBe('');
  });

  it('KEYS_PANEL_SAVED 更新掩码与配置态并退出输入模式', () => {
    const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
    const next = reducer(opened, {
      type: 'KEYS_PANEL_SAVED',
      provider: 'qwen',
      masked: '****wxyz',
      notice: 'qwen 已保存（全局，0600）',
    });
    expect(next.keysPanel?.providers[1]).toMatchObject({ masked: '****wxyz', configured: true });
    expect(next.keysPanel?.inputMode).toBe(false);
    expect(next.keysPanel?.notice).toContain('已保存');
  });

  it('KEYS_PANEL_DELETED 恢复未配置态', () => {
    const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
    const next = reducer(opened, {
      type: 'KEYS_PANEL_DELETED',
      provider: 'deepseek',
      notice: 'deepseek 已删除',
    });
    expect(next.keysPanel?.providers[0]).toMatchObject({ masked: '(未配置)', configured: false });
  });

  it('KEYS_PANEL_SCOPE 切换作用域', () => {
    const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
    expect(reducer(opened, { type: 'KEYS_PANEL_SCOPE', scope: 'project' }).keysPanel?.scope).toBe('project');
  });

  it('KEYS_PANEL_CLOSE 关闭面板', () => {
    const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
    expect(reducer(opened, { type: 'KEYS_PANEL_CLOSE' }).keysPanel).toBeNull();
  });

  describe('KEYS_PANEL_CUSTOM_PROBE（第 2 步探测厂商模型清单）', () => {
    /** 打开面板并推进到三步录入的第 3 步（模型名/序号） */
    const atStep2 = () => {
      const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
      const mode = reducer(opened, { type: 'KEYS_PANEL_INPUT_MODE', inputMode: true });
      return reducer(mode, { type: 'KEYS_PANEL_CUSTOM_STEP', step: 2, apiKey: 'sk-gw-1' });
    };

    it('pending 清空清单并提示探测中', () => {
      const next = reducer(atStep2(), { type: 'KEYS_PANEL_CUSTOM_PROBE', pending: true });
      expect(next.keysPanel?.customModels).toEqual([]);
      expect(next.keysPanel?.notice).toContain('正在探测');
    });

    it('成功回填清单并按数量提示可按序号选择', () => {
      const next = reducer(atStep2(), {
        type: 'KEYS_PANEL_CUSTOM_PROBE',
        models: ['glm-4-plus', 'glm-4-air'],
      });
      expect(next.keysPanel?.customModels).toEqual(['glm-4-plus', 'glm-4-air']);
      expect(next.keysPanel?.notice).toContain('可按序号选择');
    });

    it('空清单提示手动输入模型名', () => {
      const next = reducer(atStep2(), { type: 'KEYS_PANEL_CUSTOM_PROBE', models: [] });
      expect(next.keysPanel?.customModels).toEqual([]);
      expect(next.keysPanel?.notice).toContain('手动输入模型名');
    });

    it('已离开三步录入（customStep=null）时忽略迟到的探测结果', () => {
      const opened = reducer(baseState(), { type: 'KEYS_PANEL_OPEN', providers });
      const next = reducer(opened, {
        type: 'KEYS_PANEL_CUSTOM_PROBE',
        models: ['late-model'],
      });
      expect(next.keysPanel?.customModels).toEqual([]);
      expect(next).toBe(opened);
    });

    it('KEYS_PANEL_CUSTOM_STEP 重入时清空上一轮发现的清单', () => {
      const probed = reducer(atStep2(), { type: 'KEYS_PANEL_CUSTOM_PROBE', models: ['m-1'] });
      const reopened = reducer(probed, { type: 'KEYS_PANEL_CUSTOM_STEP', step: 1, baseUrl: 'https://gw.example.com' });
      expect(reopened.keysPanel?.customModels).toEqual([]);
    });

    it('KEYS_PANEL_SAVED 保存后清空清单与三步暂存', () => {
      const probed = reducer(atStep2(), { type: 'KEYS_PANEL_CUSTOM_PROBE', models: ['m-1'] });
      const saved = reducer(probed, {
        type: 'KEYS_PANEL_SAVED',
        provider: 'llama',
        masked: '****gw-1',
        notice: 'llama 已保存',
      });
      expect(saved.keysPanel?.customModels).toEqual([]);
      expect(saved.keysPanel?.customStep).toBeNull();
      expect(saved.keysPanel?.customApiKey).toBe('');
    });
  });
});

describe('reducer CONFIG_PANEL（/config 交互面板）', () => {
  const rows: ConfigRow[] = [
    { key: 'agent.maxSteps', kind: 'number', display: '80', raw: '80', source: 'default', description: 'Agent loop max steps', secret: false },
    { key: 'costGuardrails.enabled', kind: 'boolean', display: 'true', raw: 'true', source: 'default', description: 'Cost guardrails master switch', secret: false },
    { key: 'permissions.mode', kind: 'enum', display: 'default', raw: 'default', source: 'default', description: 'Permission mode', allowedValues: ['default', 'acceptEdits', 'bypassPermissions'], secret: false },
  ];

  it('CONFIG_PANEL_OPEN 打开面板并关闭其他面板，默认项目作用域', () => {
    const next = reducer(baseState({ modelPanel: { models: [], selected: 0 } }), {
      type: 'CONFIG_PANEL_OPEN',
      rows: [...rows],
    });
    expect(next.configPanel).toMatchObject({ rows, selected: 0, editing: false, scope: 'project' });
    expect(next.modelPanel).toBeNull();
  });

  it('CONFIG_PANEL_SELECT 编辑模式下忽略选择，越界钳制', () => {
    const opened = reducer(baseState(), { type: 'CONFIG_PANEL_OPEN', rows: [...rows] });
    expect(reducer(opened, { type: 'CONFIG_PANEL_SELECT', index: 1 }).configPanel?.selected).toBe(1);
    expect(reducer(opened, { type: 'CONFIG_PANEL_SELECT', index: 99 }).configPanel?.selected).toBe(2);
    const moved = reducer(opened, { type: 'CONFIG_PANEL_SELECT', index: 1 });
    const editing = reducer(moved, { type: 'CONFIG_PANEL_EDIT_START', text: '120' });
    expect(reducer(editing, { type: 'CONFIG_PANEL_SELECT', index: 0 }).configPanel?.selected).toBe(1);
  });

  it('CONFIG_PANEL_EDIT_START / EDIT_INPUT / EDIT_CANCEL 编辑文本流转', () => {
    const opened = reducer(baseState(), { type: 'CONFIG_PANEL_OPEN', rows: [...rows] });
    const started = reducer(opened, { type: 'CONFIG_PANEL_EDIT_START', text: '80' });
    expect(started.configPanel).toMatchObject({ editing: true, editText: '80' });
    const typed = reducer(started, { type: 'CONFIG_PANEL_EDIT_INPUT', text: '120' });
    expect(typed.configPanel?.editText).toBe('120');
    const cancelled = reducer(typed, { type: 'CONFIG_PANEL_EDIT_CANCEL' });
    expect(cancelled.configPanel).toMatchObject({ editing: false, editText: '' });
    // 非编辑模式下 EDIT_INPUT 忽略
    expect(reducer(opened, { type: 'CONFIG_PANEL_EDIT_INPUT', text: 'x' }).configPanel?.editText).toBe('');
  });

  it('CONFIG_PANEL_NOTICE / SCOPE / REFRESH', () => {
    const opened = reducer(baseState(), { type: 'CONFIG_PANEL_OPEN', rows: [...rows] });
    expect(reducer(opened, { type: 'CONFIG_PANEL_NOTICE', text: '已写入' }).configPanel?.notice).toBe('已写入');
    expect(reducer(opened, { type: 'CONFIG_PANEL_SCOPE', scope: 'global' }).configPanel?.scope).toBe('global');
    const refreshed = reducer(opened, { type: 'CONFIG_PANEL_REFRESH', rows: [...rows.slice(0, 2)] });
    expect(refreshed.configPanel?.rows).toHaveLength(2);
  });

  it('CONFIG_PANEL_CLOSE 关闭面板', () => {
    const opened = reducer(baseState(), { type: 'CONFIG_PANEL_OPEN', rows: [...rows] });
    expect(reducer(opened, { type: 'CONFIG_PANEL_CLOSE' }).configPanel).toBeNull();
  });
});

describe('reducer SECURITY_PANEL（/security 面板）', () => {
  const hook = { gitRepo: true, hookExists: false, ours: false, path: '/repo/.git/hooks/pre-commit' };

  it('SECURITY_PANEL_OPEN 打开并初始化', () => {
    const next = reducer(baseState(), {
      type: 'SECURITY_PANEL_OPEN',
      hook,
      trackedSensitive: ['.env'],
    });
    expect(next.securityPanel).toMatchObject({ hook, trackedSensitive: ['.env'], selected: 0, busy: false });
  });

  it('SECURITY_PANEL_SELECT 按菜单长度钳制（未安装=3 项）', () => {
    const opened = reducer(baseState(), { type: 'SECURITY_PANEL_OPEN', hook, trackedSensitive: [] });
    expect(reducer(opened, { type: 'SECURITY_PANEL_SELECT', index: 1 }).securityPanel?.selected).toBe(1);
    expect(reducer(opened, { type: 'SECURITY_PANEL_SELECT', index: 99 }).securityPanel?.selected).toBe(2);
  });

  it('SECURITY_PANEL_SELECT 他人钩子菜单只有 2 项', () => {
    const opened = reducer(baseState(), {
      type: 'SECURITY_PANEL_OPEN',
      hook: { ...hook, hookExists: true, ours: false },
      trackedSensitive: [],
    });
    expect(reducer(opened, { type: 'SECURITY_PANEL_SELECT', index: 99 }).securityPanel?.selected).toBe(1);
  });

  it('SECURITY_PANEL_UPDATE 更新状态与提示', () => {
    const opened = reducer(baseState(), { type: 'SECURITY_PANEL_OPEN', hook, trackedSensitive: [] });
    const next = reducer(opened, {
      type: 'SECURITY_PANEL_UPDATE',
      hook: { ...hook, hookExists: true, ours: true },
      busy: false,
      notice: '✓ 钩子已安装',
    });
    expect(next.securityPanel?.hook.hookExists).toBe(true);
    expect(next.securityPanel?.notice).toBe('✓ 钩子已安装');
  });

  it('SECURITY_PANEL_CLOSE 关闭面板', () => {
    const opened = reducer(baseState(), { type: 'SECURITY_PANEL_OPEN', hook, trackedSensitive: [] });
    expect(reducer(opened, { type: 'SECURITY_PANEL_CLOSE' }).securityPanel).toBeNull();
  });
});

describe('reducer GOAL（/goal 状态机）', () => {
  it('GOAL_SET 设置目标并置 active', () => {
    const next = reducer(baseState(), { type: 'GOAL_SET', text: '把全部测试跑绿' });
    expect(next.goal).toEqual({ text: '把全部测试跑绿', status: 'active' });
  });

  it('GOAL_PAUSE / GOAL_RESUME 状态切换，resume 追加继续消息并触发新一轮', () => {
    const set = reducer(baseState(), { type: 'GOAL_SET', text: '写文档' });
    const paused = reducer(set, { type: 'GOAL_PAUSE' });
    expect(paused.goal?.status).toBe('paused');

    const resumed = reducer(paused, { type: 'GOAL_RESUME' });
    expect(resumed.goal?.status).toBe('active');
    expect(resumed.messages.at(-1)).toEqual({ role: 'user', content: '继续执行目标：写文档' });
    expect(resumed.submitSeq).toBe(set.submitSeq + 1);
    expect(resumed.phase).toBe('thinking');
  });

  it('GOAL_COMPLETE 置 completed', () => {
    const set = reducer(baseState(), { type: 'GOAL_SET', text: 'x' });
    expect(reducer(set, { type: 'GOAL_COMPLETE' }).goal?.status).toBe('completed');
  });

  it('GOAL_CLEAR 复位并移除 system 消息中的 goal 段落', () => {
    const withGoal = reducer(baseState(), { type: 'GOAL_SET', text: 'x' });
    const sys = {
      role: 'system' as const,
      content: 'base\n\n<!-- shenlan-goal -->\n## 当前目标（goal mode）\nx\n持续执行直到目标达成；完成时调用 goal_complete(reason) 工具结束。\n<!-- /shenlan-goal -->',
    };
    const state = reducer({ ...withGoal, messages: [sys] }, { type: 'GOAL_CLEAR' });
    expect(state.goal).toBeNull();
    expect(state.messages[0]?.content).not.toContain('shenlan-goal');
    expect(state.messages[0]?.content).toContain('base');
  });

  it('CLEAR_SESSION 清空 goal', () => {
    const set = reducer(baseState(), { type: 'GOAL_SET', text: 'x' });
    expect(reducer(set, { type: 'CLEAR_SESSION' }).goal).toBeNull();
  });
});

describe('extractGoalFromMessages / stripGoalBlock（--resume 恢复）', () => {
  const goalBlock =
    'base\n\n<!-- shenlan-goal -->\n## 当前目标（goal mode）\n把全部测试跑绿\n持续执行直到目标达成；完成时调用 goal_complete(reason) 工具结束。\n<!-- /shenlan-goal -->';

  it('从首条 system 消息提取目标文本并置 active', () => {
    const goal = extractGoalFromMessages([{ role: 'system', content: goalBlock }]);
    expect(goal).toEqual({ text: '把全部测试跑绿', status: 'active' });
  });

  it('无标记返回 null，非 system 消息忽略', () => {
    expect(extractGoalFromMessages([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(extractGoalFromMessages([{ role: 'system', content: 'plain' }])).toBeNull();
  });

  it('stripGoalBlock 只移除标记段', () => {
    expect(stripGoalBlock(goalBlock)).toBe('base');
  });
});

describe('reducer ONBOARDING（首次引导：欢迎 → 配 key → 快速上手）', () => {
  const providers = [
    { id: 'deepseek', name: 'DeepSeek', masked: '(未配置)', configured: false, envSet: false, envVar: 'DEEPSEEK_API_KEY' },
    { id: 'qwen', name: 'qwen', masked: '(未配置)', configured: false, envSet: false, envVar: 'QWEN_API_KEY' },
  ];

  it('ONBOARDING_OPEN 打开欢迎步并关闭其他面板', () => {
    const next = reducer(baseState({ modelPanel: { models: [], selected: 0 } }), {
      type: 'ONBOARDING_OPEN',
      providers,
    });
    expect(next.onboarding).toEqual({ step: 'welcome', providers });
    expect(next.keysPanel).toBeNull();
    expect(next.modelPanel).toBeNull();
  });

  it('ONBOARDING_START 进入 keys 步并初始化 keysPanel（默认全局）', () => {
    const opened = reducer(baseState(), { type: 'ONBOARDING_OPEN', providers });
    const next = reducer(opened, { type: 'ONBOARDING_START' });
    expect(next.onboarding?.step).toBe('keys');
    expect(next.keysPanel).toMatchObject({
      providers,
      selected: 0,
      inputMode: false,
      scope: 'global',
    });
  });

  it('keys 步保存 key → 进入 tips 并记录成功信息', () => {
    const opened = reducer(baseState(), { type: 'ONBOARDING_OPEN', providers });
    const started = reducer(opened, { type: 'ONBOARDING_START' });
    const next = reducer(started, {
      type: 'KEYS_PANEL_SAVED',
      provider: 'deepseek',
      masked: '****abcd',
      notice: 'saved',
    });
    expect(next.onboarding?.step).toBe('tips');
    expect(next.onboarding?.saved).toEqual({ provider: 'deepseek', masked: '****abcd' });
    expect(next.keysPanel).toBeNull();
  });

  it('ONBOARDING_BACK 从 keys 步返回欢迎页并清 keysPanel', () => {
    const opened = reducer(baseState(), { type: 'ONBOARDING_OPEN', providers });
    const started = reducer(opened, { type: 'ONBOARDING_START' });
    const back = reducer(started, { type: 'ONBOARDING_BACK' });
    expect(back.onboarding?.step).toBe('welcome');
    expect(back.keysPanel).toBeNull();
  });

  it('ONBOARDING_SKIP / ONBOARDING_CLOSE 关闭引导', () => {
    const opened = reducer(baseState(), { type: 'ONBOARDING_OPEN', providers });
    expect(reducer(opened, { type: 'ONBOARDING_SKIP' }).onboarding).toBeNull();
    const started = reducer(opened, { type: 'ONBOARDING_START' });
    expect(reducer(started, { type: 'ONBOARDING_CLOSE' }).onboarding).toBeNull();
    expect(reducer(started, { type: 'ONBOARDING_CLOSE' }).keysPanel).toBeNull();
  });

  it('CLEAR_SESSION 清空引导状态', () => {
    const opened = reducer(baseState(), { type: 'ONBOARDING_OPEN', providers });
    expect(reducer(opened, { type: 'CLEAR_SESSION' }).onboarding).toBeNull();
  });
});

describe('reducer 任务结束清理 todo/plan（上次任务列表残留修复）', () => {
  it('COMPLETE 清理 todos 与 plan（非 plan 模式）', () => {
    setMode('default');
    const next = reducer(baseState({
      todos: [{ content: 'a', status: 'pending' }],
      plan: [{ step: 'b', status: 'in_progress' }],
    }), { type: 'COMPLETE' });
    expect(next.todos).toEqual([]);
    expect(next.plan).toEqual([]);
  });

  it('ERROR 同样清理 todos 与 plan（非 plan 模式）', () => {
    setMode('default');
    const next = reducer(baseState({
      todos: [{ content: 'a', status: 'pending' }],
      plan: [{ step: 'b', status: 'in_progress' }],
    }), { type: 'ERROR', error: 'boom' });
    expect(next.todos).toEqual([]);
    expect(next.plan).toEqual([]);
  });

  it('plan 模式保留 todos 与 plan（跨轮产物）', () => {
    setMode('plan');
    try {
      const next = reducer(baseState({
        todos: [{ content: 'a', status: 'pending' }],
        plan: [{ step: 'b', status: 'in_progress' }],
      }), { type: 'COMPLETE' });
      expect(next.todos).toHaveLength(1);
      expect(next.plan).toHaveLength(1);
    } finally {
      setMode('default');
    }
  });
});

describe('reducer SET_NOTICE（/clear 确认提示：紧贴输入框，提交清除）', () => {
  it('SET_NOTICE 设置提示，CLEAR_CONTEXT 清空', () => {
    const set = reducer(baseState(), { type: 'SET_NOTICE', text: 'Context cleared — 新会话，输入继续' });
    expect(set.notice).toBe('Context cleared — 新会话，输入继续');
    const cleared = reducer(set, { type: 'CLEAR_CONTEXT' });
    expect(cleared.notice).toBeNull();
  });

  it('SUBMIT_INPUT 清除提示（进入新一轮对话）', () => {
    const next = reducer(baseState({ notice: 'Context cleared — 新会话，输入继续' }), {
      type: 'SUBMIT_INPUT',
      input: '新问题',
    });
    expect(next.notice).toBeNull();
  });
});

describe('reducer SET_MODEL（实际生效模型与状态行显示同步）', () => {
  it('SET_MODEL 更新 model 字段，CLEAR_CONTEXT 不影响', () => {
    const next = reducer(baseState(), { type: 'SET_MODEL', model: 'deepseek-v4-pro' });
    expect(next.model).toBe('deepseek-v4-pro');
    const cleared = reducer(next, { type: 'CLEAR_CONTEXT' });
    expect(cleared.model).toBe('deepseek-v4-pro');
  });
});

describe('reducer TOKEN（流式行冻结：跨行行内代码 span）', () => {
  it('未闭合反引号行先缓冲，闭合后整段冻结为一条 assistant-line', () => {
    const s1 = reducer(baseState(), {
      type: 'TOKEN',
      token: '`core/config/mod.r  ServerConfig.http2 字段 + 校验「启用 http2 须配置 tls」',
    });
    expect(s1.history).toEqual([]);

    const s2 = reducer(s1, { type: 'TOKEN', token: '\n    s`\n正文\n' });
    expect(s2.history).toEqual([
      {
        key: 'line-0',
        role: 'assistant-line',
        content: '`core/config/mod.r  ServerConfig.http2 字段 + 校验「启用 http2 须配置 tls」\n    s`',
        code: false,
      },
      { key: 'line-1', role: 'assistant-line', content: '正文', code: false },
    ]);
  });
});
