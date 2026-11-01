/**
 * 动态区 — 主屏渲染中唯一实时刷新的部分（历史/流式整行已进 <Static>）。
 *
 * 内容：运行中工具状态 / thinking spinner / 流式未完成 tail / 确认弹窗 / 错误。
 * 所有 section 用 fitDynamicBudget 分配行数并包在固定高度 overflow:hidden
 * 盒里，保证 Ink 动态帧总高 ≤ maxDynamicRows（配合 InputBox ≤ rows-1），
 * 永不触发 Ink 整屏清空（\x1b[2J\x1b[3J\x1b[H）。
 */
import { Box, Text, useAnimation } from 'ink';
import { useContext } from 'react';
import { AppContext } from '../context.js';
import type { ToolStatus, BgTaskStatus } from '../context.js';
import { visibleTaskItems, taskTreeRows, type TaskTreeRow } from '../task-tree.js';
import { ToolStatusItem } from './ToolStatusItem.js';
import { ConfirmPromptView } from './ConfirmPrompt.js';
import { McpPanelView } from './McpPanel.js';
import { SkillsPanelView } from './SkillsPanel.js';
import { ModelPanelView } from './ModelPanel.js';
import { KeysPanelView } from './KeysPanel.js';
import { SecurityPanelView } from './SecurityPanel.js';
import { ConfigPanelView } from './ConfigPanel.js';
import { OnboardingPanelView } from './OnboardingPanel.js';
import { Spinner } from './Spinner.js';
import { capLine } from '../streaming.js';
import { renderStreamingLine } from './StreamingLine.js';
import {
  maxDynamicRows,
  fitDynamicBudget,
  TOOL_STATUS_MAX,
  CONFIRM_MAX,
  ERROR_MAX,
  SLASH_MAX,
} from '../dynamic-budget.js';

const TAIL_PREFIX_WIDTH = 4; // 四列左缩进，与 AssistantFrame 正文起始列对齐
/** 计划步骤在动态区最多显示行数 */
export const PLAN_MAX = 5;

export function DynamicRegion() {
  const { state, termHeight, termWidth } = useContext(AppContext);
  // 输入框多行时预算同步收缩：总输出 = 动态区 + 输入区 + 状态行 ≤ rows-1
  const inputLines = Math.max(1, state.inputValue.split('\n').length);
  // 斜杠联想渲染在输入框下方，占用输入区高度，动态区预算同步收缩
  const slashLines = state.slashSuggestions && state.slashSuggestions.matches.length > 0
    ? Math.min(SLASH_MAX, state.slashSuggestions.matches.length)
      + (state.slashSuggestions.matches.length > SLASH_MAX ? 1 : 0)
    : 0;
  const maxRows = maxDynamicRows(termHeight, inputLines, slashLines);

  const runningTools = state.toolStatuses.filter(ts => ts.state === 'running' || ts.grouped);
  const runningBg = state.bgTasks;
  const tail = state.streamingTail;
  const showTools = runningTools.length > 0 || runningBg.length > 0;
  // 非 idle 的工作阶段必须始终有反馈：tail / 工具状态都不存在时用 working 兜底，
  // 覆盖流式整行刚冻结、工具刚结束而下一轮尚未开始的短暂空档。
  const showThinking = (
    state.phase === 'thinking'
    || state.phase === 'streaming'
    || state.phase === 'tools'
  ) && tail.length === 0 && !showTools;
  // tail 一旦存在就必须可见；即使 phase 已先切回 thinking，也不能留下空白帧。
  const showTail = tail.length > 0;
  const showConfirm = state.phase === 'confirming' && !!state.confirmPrompt;
  const showError = !!state.error;
  const taskItems = visibleTaskItems(state.todos, state.plan, state.taskListSource);
  const taskRows = taskTreeRows(taskItems, 10);

  // 确认弹窗渲染在最后一条消息下方（对话流内，对齐 Claude Code CLI），
  // 确认期间 InputBox 隐藏（组件返回 null，useInput/usePaste hooks 保留捕获按键），
  // 弹窗独占动态帧，可用高度 = rows-1（底部留白 1 行）。
  // 不做整高底部锚定：消息未填满窗口时弹窗仍紧贴消息，避免中间大片空白。
  // tools/tail/plan/todos 在确认期间暂隐，确认结束立即恢复（状态不变）。
  if (showConfirm) {
    const confirmMaxRows = Math.max(1, termHeight - 1);
    return (
      <Box flexDirection="column">
        <Box
          key="confirm"
          flexDirection="column"
          maxHeight={Math.min(CONFIRM_MAX, confirmMaxRows)}
          overflow="hidden"
          flexShrink={0}
        >
          <ConfirmPromptView prompt={state.confirmPrompt!} />
        </Box>
      </Box>
    );
  }

  // 管理面板（/mcp、/skills）：模态，独占动态帧，输入框隐藏。
  // 与确认弹窗一致：可用高度 = rows-1（底部留白 1 行），永不触发整屏清空。
  if (state.onboarding) {
    return (
      <Box flexDirection="column">
        <OnboardingPanelView onboarding={state.onboarding} keysPanel={state.keysPanel} />
      </Box>
    );
  }
  if (state.modelPanel) {
    return (
      <Box flexDirection="column">
        <ModelPanelView panel={state.modelPanel} />
      </Box>
    );
  }
  if (state.mcpPanel) {
    return (
      <Box flexDirection="column">
        <McpPanelView panel={state.mcpPanel} />
      </Box>
    );
  }
  if (state.skillsPanel) {
    return (
      <Box flexDirection="column">
        <SkillsPanelView panel={state.skillsPanel} />
      </Box>
    );
  }
  if (state.keysPanel) {
    return (
      <Box flexDirection="column">
        <KeysPanelView panel={state.keysPanel} />
      </Box>
    );
  }
  if (state.configPanel) {
    return (
      <Box flexDirection="column">
        <ConfigPanelView panel={state.configPanel} />
      </Box>
    );
  }
  if (state.securityPanel) {
    return (
      <Box flexDirection="column">
        <SecurityPanelView panel={state.securityPanel} />
      </Box>
    );
  }

  const sections: Array<{ key: string; priority: number; height: number }> = [];
  if (showTools) {
    // 工具与后台任务合计 ≤ TOOL_STATUS_MAX 行（§26.5），溢出折叠行计入预算
    const total = runningTools.length + runningBg.length;
    const overflowLine = total > TOOL_STATUS_MAX ? 1 : 0;
    sections.push({
      key: 'tools',
      priority: 4,
      height: Math.min(TOOL_STATUS_MAX, total) + overflowLine,
    });
  }
  if (showThinking) sections.push({ key: 'thinking', priority: 5, height: 1 });
  if (showTail) sections.push({ key: 'tail', priority: 3, height: 1 });
  if (showError) sections.push({ key: 'error', priority: 2, height: ERROR_MAX });
  // One bounded task tree replaces the independent plan and todo lists.
  if (taskRows.length) sections.push({ key: 'tasks', priority: 5, height: taskRows.length });

  if (sections.length === 0) return null;

  const allocated = fitDynamicBudget(sections, maxRows);
  const toolsRows = allocated.get('tools') ?? 0;
  const thinkingRows = allocated.get('thinking') ?? 0;
  const tailRows = allocated.get('tail') ?? 0;
  const errorRows = allocated.get('error') ?? 0;
  const tasksRows = allocated.get('tasks') ?? 0;

  return (
    <Box flexDirection="column">
      {showTools && renderTools(toolsRows, runningTools, runningBg)}
      {showThinking && thinkingRows > 0 && (
        <Box key="thinking" height={1} flexShrink={0}>
          <WorkingIndicator />
        </Box>
      )}
      {showTail && tailRows > 0 && renderTail(tail, termWidth, state.streamFenceOpen)}
      {showError && errorRows > 0 && renderError(state.error!, errorRows, termWidth)}
      {tasksRows > 0 && renderTaskTree(taskTreeRows(taskItems, tasksRows), termWidth)}
    </Box>
  );
}

/** working 指示：braille spinner + 英文 working 与动态省略号 */
function WorkingIndicator() {
  const { frame } = useAnimation();
  const dots = '.'.repeat(frame % 4);
  return (
    <Box>
      <Text>  </Text>
      <Spinner />
      <Text dimColor>{` working${dots}`}</Text>
    </Box>
  );
}

/** 运行中工具 + 后台任务：合计最多 TOOL_STATUS_MAX 行，溢出折叠（纯工具溢出保持原文案） */
function renderTools(lines: number, tools: ToolStatus[], bgTasks: BgTaskStatus[]) {
  if (lines <= 0) return null;
  const total = tools.length + bgTasks.length;
  const extra = total > lines ? total - (lines - 1) : 0;
  const shownCount = extra > 0 ? lines - 1 : Math.min(lines, total);
  const shownTools = Math.min(shownCount, tools.length);
  const shownBg = Math.min(shownCount - shownTools, bgTasks.length);
  const toolOverflow = tools.length - shownTools;
  const bgOverflow = bgTasks.length - shownBg;
  return (
    <Box key="tools" flexDirection="column" height={lines} overflow="hidden" flexShrink={0}>
      {tools.slice(0, shownTools).map(ts => (
        <ToolStatusItem key={ts.id} status={ts} />
      ))}
      {bgTasks.slice(0, shownBg).map(b => (
        <BgTaskRow key={b.id} task={b} />
      ))}
      {extra > 0 && (
        <Text dimColor>  … +{bgOverflow === 0 ? `${toolOverflow} 个工具运行中` : `${[toolOverflow > 0 ? `${toolOverflow} 个工具` : '', bgOverflow > 0 ? `${bgOverflow} 个后台任务` : ''].filter(Boolean).join(' / ')} 运行中`}</Text>
      )}
    </Box>
  );
}

/** 运行中后台任务行：⏳ bg: <goal> (Ns)（§26.5） */
function BgTaskRow({ task }: { task: BgTaskStatus }) {
  const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
  return (
    <Box key={task.id} flexDirection="row">
      <Text color="cyan">  ⏳ bg: {capLine(task.goal, 60)}</Text>
      <Text dimColor> ({elapsed}s)</Text>
    </Box>
  );
}

/** 流式未完成 tail：单行，按终端宽度截断；与冻结行同款 markdown 渲染（代码块内原样 dim） */
function renderTail(tail: string, termWidth: number, inCode: boolean) {
  const maxWidth = Math.max(8, termWidth - TAIL_PREFIX_WIDTH - 1);
  return (
    <Box key="tail" flexDirection="row" height={1} flexShrink={0}>
      <Text>{'    '}</Text>
      {inCode
        ? <Text dimColor>{capLine(tail, maxWidth)}</Text>
        : renderStreamingLine(capLine(tail, maxWidth))}
    </Box>
  );
}

/** 错误信息：最多 ERROR_MAX 行，逐行按宽度截断 */
function renderError(error: string, lines: number, termWidth: number) {
  const maxWidth = Math.max(8, termWidth - 3);
  const textLines = error.split('\n').slice(0, lines).map(l => capLine(l, maxWidth));
  return (
    <Box key="error" flexDirection="column" height={lines} overflow="hidden" flexShrink={0}>
      {textLines.map((line, i) => (
        <Text key={i} color="red">  {line}</Text>
      ))}
    </Box>
  );
}

/** Render parent subtasks with their own development items directly beneath them. */
function renderTaskTree(rows: TaskTreeRow[], termWidth: number) {
  return (
    <Box key="tasks" flexDirection="column" height={rows.length} overflow="hidden" flexShrink={0}>
      {rows.map(row => (
        <Text key={row.key} dimColor={row.status === 'pending'} color={row.status === 'completed' ? 'green' : row.status === 'in_progress' ? 'yellow' : undefined}>
          {capLine(`${'  '.repeat(row.depth + 1)}${row.key === 'overflow' ? '' : row.status === 'completed' ? '✔ ' : row.status === 'in_progress' ? '▶ ' : '☐ '}${row.text}`, Math.max(1, termWidth - 1))}
        </Text>
      ))}
    </Box>
  );
}
