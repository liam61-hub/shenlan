/**
 * 输入框 — useInput + usePaste (Ink 原生，保持 app 存活)
 */
import { Text, Box } from 'ink';
import { useInput, usePaste } from 'ink';
import { useContext, useEffect, useRef, useState } from 'react';
import { AppContext, mcpMenuFor, securityMenuLength } from '../context.js';
import { modeLabel, getMode, setMode, type RunMode } from '../mode.js';
import { triggerStop, compactContext, getCompressionHistory, resetCompressionState, clearSessionApprovals } from '../repl.js';
import { resetAgentLoopState, abortActiveLoop } from '../hooks/useAgentLoop.js';
import { isSlashCommand, SLASH_COMMANDS, SLASH_COMMAND_DESCRIPTIONS } from '../slash-commands.js';
import {
  expandInputEvents,
  normalizePastedText,
  insertAt,
  cursorToLineCol,
  inputWindow,
  displayCol,
  inputWindowH,
  sliceToDisplayWidth,
  shouldCollapsePaste,
  storePasteContent,
  expandPasteTokens,
  expandPasteTokensAt,
  hasPastePlaceholder,
  clearPasteStore,
  type ExpandedKey,
} from '../input-events.js';
import { maxInputLines, SLASH_MAX, slashWindowStart } from '../dynamic-budget.js';
import { debugLog } from '@shenlan/core';
import { resetViewportToTop } from '../screen-reset.js';
import { runAgents } from '../agents.js';
import { runMcpSlashCommand } from '../mcp.js';
import { getAllSkills } from '../skills.js';
import {
  listMcpServers,
  setMcpServerEnabled,
  connectMcpServer,
  refreshMcpServers,
  type McpServerStatus,
} from '@shenlan/core';
import { dividerText } from './Divider.js';
import { buildConfirmTitle, buildConfirmOptions } from '../confirm-options.js';
import { approvalLanguage } from '../approval-policy.js';
import {
  listSessions, listTrash, emptyTrash,
  snapshotCount, undoS,
  formatCost,
  clearTodos, clearPlan, clearBackgroundTasks,
  getSessionCost, resetSessionCost, savePlan,
  updateConfig,
  describePermissionMode, projectMemoryDir, loadConfig, messageTextOf,
  setSafetyConfig, setAgentConfig,
} from '@shenlan/core';
import { modelCommand, buildModelOptions } from '../commands/model.js';
import {
  configCommand,
  completeConfigKey,
  buildConfigRows,
  configPanelSet,
  configPanelUnset,
  reloadConfigInPlace,
} from '../commands/config.js';
import { auditReport } from '../commands/audit.js';
import { buildContextReport } from '../commands/context-report.js';
import { pitfallReport, pitfallAdd, importPitfallsFromAgentDocs } from '../commands/pitfall.js';
import {
  buildKeyProviders,
  saveProviderKey,
  saveProviderModels,
  saveCustomProvider,
  deleteProviderKey,
  deleteProviderBaseUrl,
  testConnectivity,
  providerDef,
  resolveModelChoice,
  maskKey,
} from '../keys.js';
import {
  hookStatus,
  installPreCommitHook,
  uninstallPreCommitHook,
  scanStaged,
  trackedSensitiveFiles,
  formatHits,
} from '../security.js';
import { securityMenu } from './SecurityPanel.js';
import { UI, langOf } from '../i18n.js';
import { formatPricesReport, runPricesCheck } from '../commands/prices.js';
import {
  memoryAutoSave,
  setMemoryAutoSave,
  listMemories,
  removeMemory,
  openMemoryDir,
  editMemory,
} from '../commands/memory.js';
import { getModelContextWindow, getEffectiveModel, lockModel, resetSessionSticky, initRoutingFromConfig } from '../router.js';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { formatTokens } from '../render.js';
import { capLine } from '../streaming.js';
import { displayWidth } from '../markdown-utils.js';
import { checkForUpdate, formatUpdateResult } from '../update-check.js';
import { VERSION } from '../version.js';

const PROMPT = '❯ ';

/** /memory rm 确认弹窗的待删条目（确认后执行删除） */
let pendingMemoryDelete: { name: string; scope: 'project' | 'global' } | null = null;

/**
 * 超宽时只截断尾部（保留右侧部分），左侧补 …。
 * 按显示宽度（displayWidth）预算：CJK/emoji 占 2 列、组合符 0 列，
 * 逐码点累加绝不拆代理对。maxLen ≤ 1 时退化为单个省略号（极窄终端兜底）。
 */
function fitTail(text: string, maxLen: number): string {
  if (maxLen <= 1) return '…';
  if (displayWidth(text) <= maxLen) return text;
  const budget = maxLen - 1; // 留给左侧 …
  let width = 0;
  const tail: string[] = [];
  for (const ch of [...text].reverse()) {
    const cw = displayWidth(ch);
    if (width + cw > budget) break;
    width += cw;
    tail.push(ch);
  }
  return `…${tail.reverse().join('')}`;
}

/**
 * 组装输入框下方常驻状态行：`model · MODE · cwd`。
 * 总宽超过 width 时只截断 cwd——保留右侧（basename）部分，左侧补 …，
 * 如 `…/work/code/shenlan`；极窄宽度时整行退化为 …。
 */
export function buildStatusLine(
  model: string,
  mode: RunMode,
  cwd: string,
  width: number,
): string {
  const prefix = `${model} · ${modeLabel(mode)} · `;
  const cwdBudget = width - displayWidth(prefix);
  if (cwdBudget <= 1) return '…';
  return prefix + fitTail(cwd, cwdBudget);
}

export function InputBox() {
  const {
    state, dispatch, mode, config, model, termWidth, termHeight,
  } = useContext(AppContext);
  const phase = state.phase;
  const doExit = () => { (globalThis as any).__shenlanExit?.(); };
  const isConfirming = phase === 'confirming';
  const panelOpen = !!state.mcpPanel || !!state.skillsPanel || !!state.modelPanel || !!state.keysPanel || !!state.securityPanel || !!state.configPanel || !!state.onboarding;
  const recentApprovalLanguage = () => {
    const last = [...state.messages].reverse().find(m => m.role === 'user');
    return approvalLanguage(last ? messageTextOf(last) : '', langOf(config.language));
  };

  /** 引导完成/跳过：持久化到全局配置（0600），下次启动不再自动弹出 */
  const markOnboardingDone = (tipsSeen: boolean) => {
    try {
      updateConfig({ onboarding: { done: true, tipsSeen } }, { scope: 'global' });
    } catch { /* 写失败不阻塞本次使用 */ }
    config.onboarding = { done: true, tipsSeen };
  };

  const [cursor, setCursor] = useState(0);
  const [historyIdx, setHistoryIdx] = useState(-1);
  // 面板选中项 ref：Ink 把同一块输入拆成多次 useInput 回调且共用同一批
  // React 状态（dispatch 异步），连续按键（如 ↓+Enter）会读到旧快照；
  // ref 在 dispatch 时同步更新，跨回调保持最新值，render 后再与 state 对齐。
  const mcpListSelRef = useRef(0);
  const mcpMenuSelRef = useRef(0);
  const skillsSelRef = useRef(0);
  const slashSelRef = useRef(0);
  const modelSelRef = useRef(0);
  const keysSelRef = useRef(0);
  const securitySelRef = useRef(0);
  const configSelRef = useRef(0);

  useEffect(() => {
    mcpListSelRef.current = state.mcpPanel?.selected ?? 0;
    mcpMenuSelRef.current = state.mcpPanel?.detailMenu ?? 0;
    skillsSelRef.current = state.skillsPanel?.selected ?? 0;
    slashSelRef.current = state.slashSuggestions?.selected ?? 0;
    modelSelRef.current = state.modelPanel?.selected ?? 0;
    keysSelRef.current = state.keysPanel?.selected ?? 0;
    securitySelRef.current = state.securityPanel?.selected ?? 0;
    configSelRef.current = state.configPanel?.selected ?? 0;
  }, [state.mcpPanel, state.skillsPanel, state.slashSuggestions, state.modelPanel, state.keysPanel, state.securityPanel, state.configPanel]);

  // ===== Slash commands =====
  function handleSlash(cmd: string): boolean {
    const [name, ...rest] = cmd.trim().split(/\s+/);
    const args = rest.join(' ');
    function reply(s: string) { dispatch({ type: 'ADD_SYSTEM_MSG', content: s }); }
    // modelCommand 返回 chalk 着色文本，system 消息渲染器不做 ANSI 剥离，这里去掉颜色码
    function replyPlain(s: string) {
      reply(`  ${s.replace(/\u001b\[[0-9;]*m/g, '')}`);
    }

    switch (name.toLowerCase()) {
      case '/quit': case '/exit': case '/q': doExit(); return true;
      case '/help': case '/h':
        reply('  /mcp  /skills  /model  /keys  /security  /goal  /memory  /config\n  /permissions  /plan  /agents  /sessions  /cost  /prices  /update\n  /context  /compact  /undo  /pitfall  /trash  /cleanup  /clear  /stop\n  /help  /quit'); return false;
      case '/update': {
        reply('  Checking for updates...');
        checkForUpdate(VERSION, { force: true }).then(result => {
          dispatch({ type: 'ADD_SYSTEM_MSG', content: `  ${formatUpdateResult(result)}` });
        }).catch(err => {
          dispatch({ type: 'ADD_SYSTEM_MSG', content: `  Update check failed: ${(err as Error).message}` });
        });
        return false;
      }
      case '/config': {
        if (!args.trim()) {
          dispatch({ type: 'CONFIG_PANEL_OPEN', rows: buildConfigRows(config, process.cwd()) });
          return false;
        }
        replyPlain(configCommand(args, process.cwd()));
        return false;
      }
      case '/model': {
        if (!args.trim()) {
          dispatch({ type: 'MODEL_PANEL_OPEN', models: buildModelOptions(config) });
          return false;
        }
        const out = modelCommand(args);
        replyPlain(out);
        // 状态行/顶部头部与实际生效模型同步（/model 会重置会话粘性）
        dispatch({ type: 'SET_MODEL', model: getEffectiveModel() });
        return false;
      }
      case '/mcp': {
        if (!args.trim()) {
          dispatch({ type: 'MCP_PANEL_OPEN', servers: listMcpServers(process.cwd()) });
          return false;
        }
        runMcpSlashCommand(args, reply, process.cwd()).catch(err => {
          dispatch({ type: 'ADD_SYSTEM_MSG', content: `  MCP error: ${(err as Error).message}` });
        });
        return false;
      }
      case '/skills': {
        dispatch({ type: 'SKILLS_PANEL_OPEN', skills: getAllSkills(process.cwd()) });
        return false;
      }
      case '/keys': {
        dispatch({ type: 'KEYS_PANEL_OPEN', providers: buildKeyProviders(config) });
        return false;
      }
      case '/security': {
        dispatch({
          type: 'SECURITY_PANEL_OPEN',
          hook: hookStatus(process.cwd()),
          trackedSensitive: trackedSensitiveFiles(process.cwd()),
        });
        return false;
      }
      case '/goal': {
        const arg = args.trim();
        if (!arg) {
          if (state.goal) {
            const st = state.goal.status === 'active' ? '执行中' : state.goal.status === 'paused' ? '已暂停' : '已完成';
            reply(`  goal: ${st} — ${state.goal.text}\n  /goal pause|resume|clear`);
          } else {
            reply('  未设置目标。用法：/goal <可验证目标>；/goal pause|resume|clear');
          }
          return false;
        }
        if (arg === 'pause') {
          if (!state.goal) { reply('  未设置目标'); return false; }
          dispatch({ type: 'GOAL_PAUSE' });
          reply(`  目标已暂停（在途任务可 Esc 中断，/goal resume 继续）`);
          return false;
        }
        if (arg === 'resume') {
          if (!state.goal) { reply('  未设置目标'); return false; }
          if (state.goal.status === 'active') { reply('  目标已在执行中'); return false; }
          dispatch({ type: 'GOAL_RESUME' });
          return false;
        }
        if (arg === 'clear') {
          abortActiveLoop();
          dispatch({ type: 'GOAL_CLEAR' });
          reply('  目标已清除');
          return false;
        }
        if (phase !== 'idle') {
          reply('  当前任务运行中，任务结束后再设置目标');
          return false;
        }
        // 设置新目标：作为用户消息提交，触发 agent 循环（goal 模式）
        dispatch({ type: 'GOAL_SET', text: arg });
        dispatch({ type: 'SUBMIT_INPUT', input: arg });
        return false;
      }
      case '/plan':
        if (args === 'save' || args.startsWith('save ')) {
          const explicitTitle = args.slice(4).trim();
          const firstUser = state.messages.find(m => m.role === 'user')
            ? messageTextOf(state.messages.find(m => m.role === 'user')!) : '';
          try {
            const saved = savePlan(join(process.cwd(), '.shenlan', 'plans'), {
              title: explicitTitle || firstUser,
              sessionId: state.sessionId,
              model,
              cwd: process.cwd(),
            });
            reply(`  Plan saved: ${saved.filename} (${saved.steps} steps)`);
          } catch (e) {
            reply(`  ${(e as Error).message}`);
          }
          return false;
        }
        if (args === 'off') {
          if (getMode() === 'plan') {
            const language = recentApprovalLanguage();
            // 已处于 plan 模式：询问是否进入实施（Codex CLI 的 Implement this plan?）
            dispatch({
              type: 'CONFIRM_PROMPT',
              prompt: {
                kind: 'plan',
                language,
                title: buildConfirmTitle('plan', language),
                detail: [language === 'zh-CN' ? '计划已就绪，要切换到实施吗？' : 'Your plan is ready. Switch to implementation?'],
                toolName: 'plan',
                description: 'Exit plan mode',
                options: buildConfirmOptions('plan', {}, language),
                selected: 0,
                feedbackMode: false,
                feedbackText: '',
              },
            });
          } else {
            dispatch({ type: 'SET_MODE', mode: 'default' as any });
            reply('  Mode: NORMAL');
          }
          return false;
        }
        dispatch({ type: 'SET_MODE', mode: 'plan' as any });
        reply('  PLAN MODE');
        return false;
      case '/memory': {
        const arg = args.trim().toLowerCase();
        if (arg === 'on' || arg === 'off') {
          const enabled = arg === 'on';
          try {
            const { file } = setMemoryAutoSave(enabled, process.cwd());
            // 立即影响下次 LLM 调用的工具可见性：同步内存中的 config 对象
            config.memory = { autoSave: enabled };
            reply(`  Auto memory: ${enabled ? 'ON' : 'OFF'}（已写入 ${file}）`);
          } catch (err) {
            reply(`  ${(err as Error).message}`);
          }
          return false;
        }
        if (arg.startsWith('rm ')) {
          const target = arg.slice(3).trim();
          if (!target) {
            reply('  Usage: /memory rm <name>');
            return false;
          }
          const entry = listMemories(process.cwd()).find((e) => e.name === target);
          if (!entry) {
            reply(`  Memory not found: ${target}`);
            return false;
          }
          pendingMemoryDelete = entry;
          const language = recentApprovalLanguage();
          dispatch({
            type: 'CONFIRM_PROMPT',
            prompt: {
              kind: 'delete',
              language,
              title: buildConfirmTitle('delete', language),
              detail: [`${language === 'zh-CN' ? (entry.scope === 'project' ? '项目' : '全局') + '记忆：' : (entry.scope === 'project' ? 'Project memory: ' : 'Global memory: ')}${entry.name}.md`],
              toolName: 'memory_save',
              description: `Delete memory ${entry.name}`,
              options: buildConfirmOptions('delete', {}, language),
              selected: 0,
              feedbackMode: false,
              feedbackText: '',
            },
          });
          return false;
        }
        if (arg === 'open') {
          reply('  ⬡ Opening memory dir...');
          openMemoryDir(process.cwd()).then((r) => {
            dispatch({
              type: 'ADD_SYSTEM_MSG',
              content: r.opened
                ? `  Opened memory dir: ${projectMemoryDir(process.cwd())}`
                : `  Failed to open memory dir: ${r.message || 'unknown error'}`,
            });
          });
          return false;
        }
        if (arg.startsWith('edit ')) {
          const target = arg.slice(5).trim();
          if (!target) {
            reply('  Usage: /memory edit <name>');
            return false;
          }
          reply(`  ⬡ Opening memory "${target}"...`);
          editMemory(target, process.cwd()).then((r) => {
            dispatch({
              type: 'ADD_SYSTEM_MSG',
              content: r.opened
                ? `  Opened memory: ${target}（外部编辑后下一条消息生效）`
                : `  Failed to open memory: ${r.message || 'unknown error'}`,
            });
          });
          return false;
        }
        try {
          const auto = memoryAutoSave(config);
          const entries = listMemories(process.cwd());
          const lines = [`  Auto memory: ${auto ? 'ON' : 'OFF'}（/memory on|off 切换）`];
          if (entries.length > 0) {
            lines.push(...entries.map((e) => `  ${e.name} — ${e.description} (${e.scope})`));
          } else {
            lines.push('  No memories');
            lines.push('  全局: ~/.shenlan/memory/（.md）');
            lines.push('  项目: .shenlan/memory/（.md）');
          }
          reply(lines.join('\n'));
        } catch { reply('  Error'); }
        return false;
      }
      case '/permissions': {
        const p = config.permissions;
        const mode = getMode();
        const modeDesc = mode === 'plan'
          ? '只读规划态（write/edit/shell 拒绝）'
          : describePermissionMode(mode);
        reply(
          `  Mode: ${modeLabel(mode)}（${mode} · ${modeDesc}）\n` +
          `  Config allow: ${p.allow.length ? p.allow.join(', ') : '(none)'}\n` +
          `  Config deny: ${p.deny.length ? p.deny.join(', ') : '(none)'}`,
        );
        return false;
      }
      case '/sessions': {
        const ss = listSessions(); reply(ss.length ? ss.slice(0,10).map(s => `  ${s.id} ${(s.title||'').slice(0,40)}`).join('\n') : '  None'); return false;
      }
      case '/cost': {
        const c = getSessionCost();
        if (c.calls > 0) {
          const lines = [`  本会话：${formatTokens(c.promptTokens)} 输入 + ${formatTokens(c.completionTokens)} 输出 = ${formatTokens(c.promptTokens + c.completionTokens)} tokens · ${c.calls} 次调用`];
          for (const item of c.byModel) {
            const amount = item.estimatedCostCny === null
              ? '费用未知'
              : `${item.hasFallbackEstimate ? '本地估算（回退价）' : '本地估算'} ${formatCost(item.estimatedCostCny)}`;
            lines.push(`  ${item.model}：${formatTokens(item.promptTokens)} 输入 + ${formatTokens(item.completionTokens)} 输出 · ${item.calls} 次 · ${amount}`);
          }
          lines.push('  金额为本地价格估算，不代表供应商实际账单。');
          reply(lines.join('\n'));
        } else {
          reply('  本会话尚无 API 返回的 token usage。');
        }
        return false;
      }
      case '/context': {
        reply(buildContextReport({
          messages: state.messages,
          config,
          model,
          contextWindow: getModelContextWindow(model),
          history: getCompressionHistory(),
        }).join('\n'));
        return false;
      }
      case '/compact': {
        if (phase !== 'idle') {
          reply('  Agent 运行中，任务结束后再压缩');
          return false;
        }
        const focusArg = args.trim() || undefined;
        reply('  ⬡ working...');
        compactContext(config, state.messages, focusArg).then(r => {
          if (r.method === 'none') {
            dispatch({ type: 'ADD_SYSTEM_MSG', content: '  无需压缩（无可压缩中间段，消息太少）' });
            return;
          }
          dispatch({
            type: 'ADD_SYSTEM_MSG',
            content: `  上下文已压缩（${r.method === 'llm' ? 'LLM 摘要' : '规则摘要'}，释放 ~${formatTokens(r.savedTokens)} tokens），/context 查看`,
          });
        }).catch(err => {
          dispatch({ type: 'ADD_SYSTEM_MSG', content: `  压缩失败: ${(err as Error).message}` });
        });
        return false;
      }
      case '/undo': {
        const c = snapshotCount(); if(!c){reply('  None');return false;} const s=undoS(); reply(s?`  Restored: ${s.file}`:'  Failed'); return false;
      }
      case '/pitfall': {
        const pfArgs = args.trim();
        if (pfArgs.startsWith('add ')) {
          const title = pitfallAdd(process.cwd(), pfArgs.slice(4).trim());
          reply(title ? `  Added: ${title}` : '  Empty entry');
        } else if (pfArgs === 'import') {
          const r = importPitfallsFromAgentDocs(process.cwd());
          reply(`  Imported ${r.imported} pitfall(s)${r.skipped > 0 ? `, skipped ${r.skipped} (重复标题)` : ''} from CLAUDE.md/AGENTS.md`);
        } else {
          replyPlain(pitfallReport(process.cwd()));
        }
        return false;
      }
      case '/trash': {
        if(args==='empty'){reply(`  Emptied ${emptyTrash()} files`);}else{const ti=listTrash();reply(ti.length?`  ${ti.length} items\n  /trash empty`:'  Empty');} return false;
      }
      case '/cleanup': {
        const sd=join(process.cwd(),'.shenlan','snapshots');let c=0;if(existsSync(sd)){for(const f of readdirSync(sd)){try{unlinkSync(join(sd,f));c++;}catch{}}}
        reply(`  Cleaned ${c}`); return false;
      }
      case '/agents': case '/a': {
        if (!args) { reply('  Usage: /agents <task with numbered sub-tasks>'); return false; }
        reply(`  ⬡ Decomposing and running sub-agents...`);
        runAgents(args, config).then(result => {
          dispatch({ type: 'ADD_SYSTEM_MSG', content: result });
        }).catch(err => {
          dispatch({ type: 'ADD_SYSTEM_MSG', content: `  Agent error: ${err.message}` });
        });
        return false;
      }
      case '/stop': triggerStop(); reply('  Stopped'); return false;
      case '/clear': {
        resetCompressionState();
        resetAgentLoopState();
        // 终止在途任务：否则旧 run 完成后 COMPLETE 会用旧 messages 回填，清空被撤销
        abortActiveLoop();
        clearTodos();
        clearPlan();
        clearBackgroundTasks();
        clearPasteStore();
        resetSessionCost();
        clearSessionApprovals();
        // 视图重置（先于状态变更同步执行，仍不发 2J/3J）：换行推屏把旧内容压入
        // 滚动区 + 光标归位 + 重置 Ink 帧状态；随后单次 CLEAR_SESSION 渲染，
        // 新会话 logo 画在窗口顶部、输入框紧随其下，观感等同刚启动
        resetViewportToTop(termHeight);
        dispatch({ type: 'CLEAR_SESSION' });
        return false;
      }
      case '/prices': {
        if (args.trim() === 'check') {
          reply('  ⬡ Checking official prices...');
          runPricesCheck(config).then((text) => {
            dispatch({ type: 'ADD_SYSTEM_MSG', content: text });
          }).catch((err) => {
            dispatch({ type: 'ADD_SYSTEM_MSG', content: `  价格同步失败: ${(err as Error).message}` });
          });
          return false;
        }
        reply(formatPricesReport(config));
        return false;
      }
      case '/audit':
        reply(`  Sessions: ${listSessions().length}  Model: ${model}`);
        replyPlain(auditReport(process.cwd()));
        return false;
      case '/temp': {
        const td=join(process.cwd(),'.shenlan','snapshots'); reply(existsSync(td)?`  ${readdirSync(td).length} files`:'  None'); return false;
      }
      default: reply(`  Unknown: ${name}. /help`); return false;
    }
  }

  // ===== Input handling (Ink's useInput) =====
  useInput((rawInput, rawKey) => {
    // Ink 会把同一块到达的多个字符（含 \r\n 等控制字符）作为一次 paste 事件送达
    // （key.return 恒为 false）。拆成独立按键事件逐次处理，恢复回车/Tab/退格语义，
    // 避免快速键入或弹窗快捷键连发时「回车不生效 → 界面像挂起」。
    const events = expandInputEvents(rawInput, rawKey as ExpandedKey);
    // 多事件块内的本地镜像：同块内前一个事件对输入框/反馈文本的修改对后一个事件可见
    let value = state.inputValue;
    let pos = cursor;
    let fbText = state.confirmPrompt?.feedbackText ?? '';
    const commitInput = (v: string, p: number) => {
      value = v;
      pos = p;
      dispatch({ type: 'SET_INPUT', value: v });
      setCursor(p);
    };

    for (const ev of events) {
      const input = ev.input;
      const key = ev.key;

      // 管理面板模式（/mcp、/skills、/model）：按键由面板接管，输入框隐藏。
      // 每批只处理第一个事件后 break：dispatch 是异步的，同一批内的后续事件
      // 仍持旧状态快照，连续按键会误操作（如 ↓+Enter 会选中错菜单项）。
      if (state.mcpPanel || state.skillsPanel || state.modelPanel || state.keysPanel || state.securityPanel || state.configPanel || state.onboarding) {
        // 首次引导流程（welcome / tips）：Enter 推进，Esc 跳过/关闭
        if (state.onboarding) {
          const ob = state.onboarding;
          if (ob.step === 'welcome') {
            if (key.return) { dispatch({ type: 'ONBOARDING_START' }); break; }
            if (key.escape || input === 'q') {
              markOnboardingDone(false);
              dispatch({ type: 'ONBOARDING_SKIP' });
              break;
            }
            break;
          }
          if (ob.step === 'tips') {
            if (key.return || key.escape || input === 'q') {
              markOnboardingDone(true);
              dispatch({ type: 'ONBOARDING_CLOSE' });
              // 关闭后给一行常驻提示（下次提交清除）
              dispatch({ type: 'SET_NOTICE', text: '配置完成，欢迎使用 shenlan！输入 /help 查看全部命令' });
              break;
            }
            break;
          }
          // step==='keys'：由下方 keysPanel 处理器接管
        }

        // 密钥面板（/keys）：输入模式接管键盘，列表模式支持选择/删除/作用域切换
        if (state.keysPanel) {
          const kp = state.keysPanel;
          if (kp.inputMode) {
            // 保存/连通性测试进行中：忽略除 Esc 外的按键，避免重复保存
            if (kp.busy) {
              if (key.escape) {
                if (kp.customStep !== null) dispatch({ type: 'KEYS_PANEL_CUSTOM_STEP', step: null });
                else dispatch({ type: 'KEYS_PANEL_INPUT_MODE', inputMode: false });
              }
              break;
            }
            // 自定义 provider 三步录入（baseUrl → API Key → 模型名）
            if (kp.customStep !== null) {
              const step = kp.customStep;
              if (key.escape) { dispatch({ type: 'KEYS_PANEL_CUSTOM_STEP', step: null }); break; }
              if (key.return) {
                if (step === 0) {
                  // baseUrl（允许留空 = 自动推导官方端点）
                  dispatch({ type: 'KEYS_PANEL_CUSTOM_STEP', step: 1, baseUrl: kp.inputText.trim() });
                  break;
                }
                if (step === 1) {
                  const keyText = kp.inputText.trim();
                  if (!keyText) {
                    dispatch({ type: 'KEYS_PANEL_CUSTOM_STEP', step: null });
                    dispatch({ type: 'KEYS_PANEL_BUSY', busy: false, notice: '未输入 API Key，已取消' });
                    break;
                  }
                  dispatch({ type: 'KEYS_PANEL_CUSTOM_STEP', step: 2, apiKey: keyText });
                  // 非阻塞探测厂商 /v1/models：拿到清单则第 3 步可按序号选择，失败退回手输模型名。
                  // 留空 baseUrl（走内置端点）时无法预知厂商，跳过探测。
                  if (kp.customBaseUrl.trim()) {
                    dispatch({ type: 'KEYS_PANEL_CUSTOM_PROBE', pending: true });
                    (async () => {
                      const res = await testConnectivity(providerDef('custom')!, keyText, kp.customBaseUrl);
                      dispatch({ type: 'KEYS_PANEL_CUSTOM_PROBE', models: res.models ?? [] });
                    })();
                  }
                  break;
                }
                // step 2：序号/模型名 → 保存 + 连通性测试 + 刷新列表（派生行立即可见）
                const choice = resolveModelChoice(kp.inputText, kp.customModels);
                if ('error' in choice) {
                  dispatch({ type: 'KEYS_PANEL_BUSY', busy: false, notice: choice.error });
                  break;
                }
                const model = choice.model;
                dispatch({ type: 'KEYS_PANEL_BUSY', busy: true, notice: '保存中...' });
                (async () => {
                  try {
                    const { provider } = saveCustomProvider(
                      { baseUrl: kp.customBaseUrl, apiKey: kp.customApiKey, model },
                      kp.scope,
                    );
                    const def = providerDef(provider) ?? providerDef('custom')!;
                    // 第 2 步已探测出清单 → 复用其结果并视为连通；否则此处补一次连通性测试
                    const probed = kp.customModels;
                    const test = probed.length > 0
                      ? { ok: true, models: probed }
                      : await testConnectivity(def, kp.customApiKey, kp.customBaseUrl || undefined);
                    const discovered = [...new Set([...(test.models ?? []), model])];
                    saveProviderModels(provider, discovered, kp.scope);
                    config.providerModels = { ...(config.providerModels ?? {}), [provider]: discovered };
                    const connText = test.ok ? '连通性 ✓' : `连通性 ⚠ ${test.status ?? test.error ?? 'unknown'}`;
                    dispatch({
                      type: 'KEYS_PANEL_SAVED',
                      provider,
                      masked: maskKey(kp.customApiKey),
                      notice: `${provider} 已保存（${kp.scope === 'global' ? '全局' : '项目级'}，0600） · ${connText}`,
                    });
                    dispatch({ type: 'KEYS_PANEL_REFRESH', providers: buildKeyProviders(loadConfig()) });
                  } catch (err) {
                    dispatch({
                      type: 'KEYS_PANEL_BUSY',
                      busy: false,
                      notice: `保存失败: ${(err as Error).message}`,
                    });
                  }
                })();
                break;
              }
              if (key.backspace || key.delete) {
                const text = kp.inputText.slice(0, -1);
                dispatch({ type: 'KEYS_PANEL_INPUT', text });
                break;
              }
              if (input && !key.ctrl && !key.meta) {
                dispatch({ type: 'KEYS_PANEL_INPUT', text: kp.inputText + input });
                break;
              }
              break;
            }
            if (key.escape) { dispatch({ type: 'KEYS_PANEL_INPUT_MODE', inputMode: false }); break; }
            if (key.return) {
              const provider = kp.providers[kp.selected];
              const keyText = kp.inputText.trim();
              if (!provider || !keyText) {
                dispatch({ type: 'KEYS_PANEL_INPUT_MODE', inputMode: false });
                break;
              }
              // 保存（0600 原子写）→ 连通性测试（失败仅黄色提示）
              dispatch({ type: 'KEYS_PANEL_BUSY', busy: true, notice: '保存中...' });
              (async () => {
                try {
                  saveProviderKey(provider.id, keyText, kp.scope);
                  const def = providerDef(provider.id);
                  const test = def ? await testConnectivity(def, keyText) : null;
                  if (test?.models?.length) {
                    saveProviderModels(provider.id, test.models, kp.scope);
                    config.providerModels = { ...(config.providerModels ?? {}), [provider.id]: test.models };
                  }
                  const connText = test
                    ? test.ok ? '连通性 ✓' : `连通性 ⚠ HTTP ${test.status ?? test.error ?? 'unknown'}`
                    : '';
                  dispatch({
                    type: 'KEYS_PANEL_SAVED',
                    provider: provider.id,
                    masked: maskKey(keyText),
                    notice: `${provider.name} 已保存（${kp.scope === 'global' ? '全局' : '项目级'}，0600）${connText ? ' · ' + connText : ''}`,
                  });
                } catch (err) {
                  dispatch({
                    type: 'KEYS_PANEL_BUSY',
                    busy: false,
                    notice: `保存失败: ${(err as Error).message}`,
                  });
                }
              })();
              break;
            }
            if (key.backspace || key.delete) {
              const text = kp.inputText.slice(0, -1);
              dispatch({ type: 'KEYS_PANEL_INPUT', text });
              break;
            }
            if (input && !key.ctrl && !key.meta) {
              dispatch({ type: 'KEYS_PANEL_INPUT', text: kp.inputText + input });
              break;
            }
            break;
          }
          // 列表模式
          if (key.escape || input === 'q') {
            // 首次引导的 keys 步：Esc 返回欢迎页；独立 /keys 面板：关闭
            if (state.onboarding?.step === 'keys') {
              dispatch({ type: 'ONBOARDING_BACK' });
            } else {
              dispatch({ type: 'KEYS_PANEL_CLOSE' });
            }
            break;
          }
          if (key.upArrow || key.downArrow) {
            const len = kp.providers.length;
            if (len > 0) {
              keysSelRef.current = (keysSelRef.current + (key.downArrow ? 1 : -1) + len) % len;
              dispatch({ type: 'KEYS_PANEL_SELECT', index: keysSelRef.current });
            }
            break;
          }
          if (input === 'g' || input === 'G') { dispatch({ type: 'KEYS_PANEL_SCOPE', scope: 'global' }); break; }
          if (input === 'p' || input === 'P') { dispatch({ type: 'KEYS_PANEL_SCOPE', scope: 'project' }); break; }
          if (Number.isInteger(Number(input))) {
            const n = Number(input);
            if (n >= 1 && n <= Math.min(9, kp.providers.length)) {
              const idx = n - 1;
              if (idx < kp.providers.length) {
                keysSelRef.current = idx;
                dispatch({ type: 'KEYS_PANEL_SELECT', index: idx });
              }
              break;
            }
          }
          if (input === 'd' || input === 'D') {
            const provider = kp.providers[kp.selected];
            if (provider?.configured) {
              (async () => {
                try {
                  deleteProviderKey(provider.id, kp.scope);
                  // 派生行（自定义录入）删除时连带清理 providerBaseUrls
                  if (provider.baseUrl) deleteProviderBaseUrl(provider.id, kp.scope);
                  dispatch({ type: 'KEYS_PANEL_DELETED', provider: provider.id, notice: `${provider.name} 已删除` });
                  if (provider.derived) {
                    dispatch({ type: 'KEYS_PANEL_REFRESH', providers: buildKeyProviders(loadConfig()) });
                  }
                } catch (err) {
                  dispatch({ type: 'KEYS_PANEL_BUSY', busy: false, notice: `删除失败: ${(err as Error).message}` });
                }
              })();
            } else {
              dispatch({ type: 'KEYS_PANEL_BUSY', busy: false, notice: `${provider?.name ?? ''} 未配置 key` });
            }
            break;
          }
          if (key.return) {
            const provider = kp.providers[kp.selected];
            if (provider?.id === 'custom') {
              // 自定义入口：三步录入（baseUrl → API Key → 模型名）
              dispatch({ type: 'KEYS_PANEL_CUSTOM_STEP', step: 0 });
            } else {
              dispatch({ type: 'KEYS_PANEL_INPUT_MODE', inputMode: true, inputText: '' });
            }
            break;
          }
          break;
        }

        // 配置面板（/config）：列表模式 ←/→ 切换布尔/枚举、Enter 编辑、d 恢复默认、g/p 作用域；
        // 编辑模式 Enter 保存（校验 → 写盘 → 会话内即时生效）、Esc 取消。
        if (state.configPanel) {
          const cp = state.configPanel;
          // 写盘后统一走 reloadConfigInPlace：permissions.mode 与 routing.* 有运行时同步钩子，
          // 其余键由 repl 每轮任务读 config 对象自然生效。
          const liveSync = (key: string) => {
            if (key === 'permissions.mode') setMode(config.permissions.mode);
            if (key.startsWith('routing.')) {
              initRoutingFromConfig(config);
              dispatch({ type: 'SET_MODEL', model: getEffectiveModel() });
            }
            setSafetyConfig(config);
            setAgentConfig(config, getEffectiveModel());
          };
          const ui = UI[langOf(config.language)];
          const scopeLabel = ui.scopeLabel(cp.scope);

          if (cp.editing) {
            if (key.escape) { dispatch({ type: 'CONFIG_PANEL_EDIT_CANCEL' }); break; }
            if (key.return) {
              const row = cp.rows[cp.selected];
              const raw = cp.editText.trim();
              if (!row) { dispatch({ type: 'CONFIG_PANEL_EDIT_CANCEL' }); break; }
              const result = configPanelSet(row.key, raw, cp.scope);
              if (!result.ok) {
                dispatch({ type: 'CONFIG_PANEL_NOTICE', text: result.error });
                break;
              }
              reloadConfigInPlace(config);
              liveSync(row.key);
              dispatch({ type: 'CONFIG_PANEL_EDIT_CANCEL' });
              dispatch({ type: 'CONFIG_PANEL_REFRESH', rows: buildConfigRows(config, process.cwd()) });
              {
                // 语言可能刚被切换：reload 后用新语言提示
                const uiAfter = UI[langOf(config.language)];
                dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${uiAfter.saved(uiAfter.scopeLabel(cp.scope))}` });
              }
              break;
            }
            if (key.backspace || key.delete) {
              dispatch({ type: 'CONFIG_PANEL_EDIT_INPUT', text: cp.editText.slice(0, -1) });
              break;
            }
            if (input && !key.ctrl && !key.meta) {
              dispatch({ type: 'CONFIG_PANEL_EDIT_INPUT', text: cp.editText + input });
              break;
            }
            break;
          }
          // 列表模式
          if (key.escape || input === 'q') { dispatch({ type: 'CONFIG_PANEL_CLOSE' }); break; }
          if (key.upArrow || key.downArrow) {
            const len = cp.rows.length;
            if (len > 0) {
              configSelRef.current = (configSelRef.current + (key.downArrow ? 1 : -1) + len) % len;
              dispatch({ type: 'CONFIG_PANEL_SELECT', index: configSelRef.current });
            }
            break;
          }
          // ←/→：布尔取反 / 枚举循环（直接写盘并即时生效）
          if (key.leftArrow || key.rightArrow) {
            const row = cp.rows[cp.selected];
            if (!row) break;
            if (row.source === 'env') {
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${ui.fromEnv}` });
              break;
            }
            let nextRaw: string | null = null;
            if (row.kind === 'boolean') nextRaw = String(!(row.raw === 'true'));
            else if (row.kind === 'enum' && row.allowedValues?.length) {
              const vals = row.allowedValues;
              const cur = vals.indexOf(row.raw);
              nextRaw = vals[(cur + (key.rightArrow ? 1 : -1) + vals.length) % vals.length]!;
            } else if (row.kind === 'array') {
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${ui.isArray}` });
              break;
            } else {
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: ui.enterToEdit });
              break;
            }
            const result = configPanelSet(row.key, nextRaw, cp.scope);
            if (!result.ok) {
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: result.error });
              break;
            }
            reloadConfigInPlace(config);
            liveSync(row.key);
            dispatch({ type: 'CONFIG_PANEL_REFRESH', rows: buildConfigRows(config, process.cwd()) });
            {
              // 语言可能刚被切换：reload 后用新语言提示
              const uiAfter = UI[langOf(config.language)];
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${uiAfter.saved(uiAfter.scopeLabel(cp.scope))}` });
            }
            break;
          }
          if (input === 'g' || input === 'G') { dispatch({ type: 'CONFIG_PANEL_SCOPE', scope: 'global' }); break; }
          if (input === 'p' || input === 'P') { dispatch({ type: 'CONFIG_PANEL_SCOPE', scope: 'project' }); break; }
          if (input === 'd' || input === 'D') {
            const row = cp.rows[cp.selected];
            if (!row) break;
            if (row.source === 'env') {
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${ui.fromEnv}` });
              break;
            }
            const removed = configPanelUnset(row.key, cp.scope);
            if (!removed) {
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${ui.notSet(scopeLabel)}` });
              break;
            }
            reloadConfigInPlace(config);
            liveSync(row.key);
            dispatch({ type: 'CONFIG_PANEL_REFRESH', rows: buildConfigRows(config, process.cwd()) });
            dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${ui.resetDefault(scopeLabel)}` });
            break;
          }
          if (key.return) {
            const row = cp.rows[cp.selected];
            if (!row) break;
            if (row.kind === 'array') {
              dispatch({ type: 'CONFIG_PANEL_NOTICE', text: `${row.key} ${ui.isArray}` });
            } else {
              dispatch({ type: 'CONFIG_PANEL_EDIT_START', text: row.raw });
            }
            break;
          }
          break;
        }

        // 安全检查面板（/security）：钩子安装/卸载/重扫
        if (state.securityPanel) {
          const sp = state.securityPanel;
          if (sp.busy) {
            if (key.escape || input === 'q') dispatch({ type: 'SECURITY_PANEL_CLOSE' });
            break;
          }
          if (key.escape || input === 'q') { dispatch({ type: 'SECURITY_PANEL_CLOSE' }); break; }
          if (key.upArrow || key.downArrow) {
            const len = securityMenuLength(sp);
            securitySelRef.current = (securitySelRef.current + (key.downArrow ? 1 : -1) + len) % len;
            dispatch({ type: 'SECURITY_PANEL_SELECT', index: securitySelRef.current });
            break;
          }
          if (key.return || input === '1' || input === '2' || input === '3') {
            const idx = key.return ? securitySelRef.current : Math.min(Number(input) - 1, securityMenuLength(sp) - 1);
            const op = securityMenu(sp).map(m => m.op)[idx];
            if (!op) break;
            const cwd = process.cwd();
            if (op === 'inspect') {
              dispatch({ type: 'SECURITY_PANEL_UPDATE', busy: false, notice: '已保留现有钩子（不覆盖），可手动合并安全检查逻辑' });
              break;
            }
            if (op === 'install') {
              dispatch({ type: 'SECURITY_PANEL_UPDATE', busy: true, notice: '安装中...' });
              (async () => {
                const r = installPreCommitHook(cwd, { silent: true });
                dispatch({
                  type: 'SECURITY_PANEL_UPDATE',
                  busy: false,
                  hook: hookStatus(cwd),
                  notice: r.installed
                    ? `✓ 钩子已${r.overwritten ? '重装' : '安装'}（${r.path}）`
                    : r.reason === 'existing-hook'
                      ? '⚠ 已有非 shenlan 钩子，未覆盖'
                      : `⚠ 安装失败: ${r.reason || 'unknown'}`,
                });
              })();
              break;
            }
            if (op === 'uninstall') {
              dispatch({ type: 'SECURITY_PANEL_UPDATE', busy: true, notice: '卸载中...' });
              (async () => {
                const r = uninstallPreCommitHook(cwd, { silent: true });
                dispatch({
                  type: 'SECURITY_PANEL_UPDATE',
                  busy: false,
                  hook: hookStatus(cwd),
                  notice: r.removed ? `✓ 钩子已卸载（${r.path}）` : `⚠ 未卸载: ${r.reason || 'unknown'}`,
                });
              })();
              break;
            }
            if (op === 'scan') {
              dispatch({ type: 'SECURITY_PANEL_UPDATE', busy: true, notice: '扫描暂存区...' });
              (async () => {
                const r = scanStaged(cwd);
                const notice = r.error
                  ? `⚠ ${r.error}`
                  : r.hits.length > 0
                    ? `⚠ 发现 ${r.hits.length} 处疑似密钥：${formatHits(r.hits).split('\n').slice(0, 3).join(' | ')}`
                    : '✓ 未发现疑似密钥';
                dispatch({ type: 'SECURITY_PANEL_UPDATE', busy: false, notice });
              })();
              break;
            }
            break;
          }
          break;
        }

        // 模型选择面板：↑/↓ 跳过无 key 项，数字键直选，
        // Enter 设为默认（全局持久化），s 仅本次会话，Esc/q 取消
        if (state.modelPanel) {
          const models = state.modelPanel.models;
          // useInput 作用域没有 handleSlash 的 reply，直接 dispatch 系统消息
          const panelReply = (s: string) => dispatch({
            type: 'ADD_SYSTEM_MSG',
            content: `  ${s.replace(/\u001b\[[0-9;]*m/g, '')}`,
          });
          const applyModel = (index: number, sessionOnly: boolean) => {
            const opt = models[index];
            if (!opt || !opt.available) return;
            if (opt.kind === 'auto') {
              panelReply(modelCommand('auto'));
            } else if (sessionOnly) {
              lockModel(opt.model);
              resetSessionSticky();
              panelReply(`switched to: ${opt.model} (this session only)`);
            } else {
              panelReply(modelCommand(opt.model));
            }
            dispatch({ type: 'SET_MODEL', model: getEffectiveModel() });
            dispatch({ type: 'MODEL_PANEL_CLOSE' });
          };
          if (key.escape || input === 'q') { dispatch({ type: 'MODEL_PANEL_CLOSE' }); break; }
          if (key.upArrow) {
            const len = models.length;
            for (let step = 1; step <= len; step++) {
              const idx = (modelSelRef.current - step + len) % len;
              if (models[idx]!.available) {
                modelSelRef.current = idx;
                dispatch({ type: 'MODEL_PANEL_SELECT', index: idx });
                break;
              }
            }
            break;
          }
          if (key.downArrow) {
            const len = models.length;
            for (let step = 1; step <= len; step++) {
              const idx = (modelSelRef.current + step) % len;
              if (models[idx]!.available) {
                modelSelRef.current = idx;
                dispatch({ type: 'MODEL_PANEL_SELECT', index: idx });
                break;
              }
            }
            break;
          }
          if (input >= '1' && input <= '9') {
            const idx = Number(input) - 1;
            if (idx < models.length) applyModel(idx, false);
            break;
          }
          if (input === 's' || input === 'S') { applyModel(modelSelRef.current, true); break; }
          if (key.return) { applyModel(modelSelRef.current, false); break; }
          break;
        }
        if (state.mcpPanel) {
          const p = state.mcpPanel;
          if (p.busy) {
            if (key.escape || input === 'q') dispatch({ type: 'MCP_PANEL_BACK' });
            break;
          }

          const runDetailOp = (server: McpServerStatus, op: 'enable' | 'disable' | 'connect') => {
            const cwd = process.cwd();
            const label = op === 'enable' ? 'Enabling...' : op === 'disable' ? 'Disabling...' : 'Reconnecting...';
            dispatch({ type: 'MCP_PANEL_UPDATE', servers: p.servers, busy: true, notice: label });
            (async () => {
              try {
                let notice: string;
                if (op === 'enable') {
                  const r = await setMcpServerEnabled(server.name, true, cwd);
                  notice = r.connected ? `✔ ${server.name} enabled (${r.toolCount} tools)` : `✗ ${server.name} enable failed: ${r.error || 'unknown error'}`;
                } else if (op === 'disable') {
                  await setMcpServerEnabled(server.name, false, cwd);
                  notice = `○ ${server.name} disabled for this session`;
                } else {
                  const r = await connectMcpServer(server.name, cwd);
                  notice = r.connected ? `✔ ${server.name} connected (${r.toolCount} tools)` : `✗ ${server.name} connect failed: ${r.error || 'unknown error'}`;
                }
                dispatch({ type: 'MCP_PANEL_UPDATE', servers: listMcpServers(cwd), busy: false, notice });
              } catch (err) {
                dispatch({
                  type: 'MCP_PANEL_UPDATE',
                  servers: listMcpServers(cwd),
                  busy: false,
                  notice: `✗ ${(err as Error).message}`,
                });
              }
            })();
          };

          const runRefreshAll = () => {
            const cwd = process.cwd();
            dispatch({ type: 'MCP_PANEL_UPDATE', servers: p.servers, busy: true, notice: 'Refreshing all MCP servers' });
            (async () => {
              try {
                const r = await refreshMcpServers(cwd);
                dispatch({
                  type: 'MCP_PANEL_UPDATE',
                  servers: listMcpServers(cwd),
                  busy: false,
                  notice: `⇄ refresh: ${r.connected}/${r.total} connected${r.errors.length ? ` (${r.errors.length} failed)` : ''}`,
                });
              } catch (err) {
                dispatch({
                  type: 'MCP_PANEL_UPDATE',
                  servers: listMcpServers(cwd),
                  busy: false,
                  notice: `✗ ${(err as Error).message}`,
                });
              }
            })();
          };

          // 工具列表视图：Esc/Enter 返回详情
          if (p.toolsView) {
            if (key.escape || input === 'q' || key.return) dispatch({ type: 'MCP_PANEL_BACK' });
            break;
          }

          // 详情视图：菜单导航 + Enter/数字选择
          if (p.detail) {
            const server = p.detail;
            const menu = mcpMenuFor(server);
            if (key.escape || input === 'q') { dispatch({ type: 'MCP_PANEL_BACK' }); break; }
            if (key.upArrow) {
              mcpMenuSelRef.current = (mcpMenuSelRef.current - 1 + menu.length) % menu.length;
              dispatch({ type: 'MCP_PANEL_MENU_SELECT', index: mcpMenuSelRef.current });
              break;
            }
            if (key.downArrow) {
              mcpMenuSelRef.current = (mcpMenuSelRef.current + 1) % menu.length;
              dispatch({ type: 'MCP_PANEL_MENU_SELECT', index: mcpMenuSelRef.current });
              break;
            }
            if (key.return || input === '1' || input === '2' || input === '3') {
              const idx = key.return ? mcpMenuSelRef.current : Math.min(Number(input) - 1, menu.length - 1);
              const item = menu[idx];
              if (!item) break;
              if (item.op === 'tools') { dispatch({ type: 'MCP_PANEL_VIEW_TOOLS' }); break; }
              runDetailOp(server, item.op);
              break;
            }
            break;
          }

          // 列表视图：选择 + Enter 进详情 + f 全部重连
          if (key.escape || input === 'q') { dispatch({ type: 'MCP_PANEL_CLOSE' }); break; }
          if (key.upArrow) {
            const len = p.servers.length;
            if (len > 0) {
              mcpListSelRef.current = (mcpListSelRef.current - 1 + len) % len;
              dispatch({ type: 'MCP_PANEL_SELECT', index: mcpListSelRef.current });
            }
            break;
          }
          if (key.downArrow) {
            const len = p.servers.length;
            if (len > 0) {
              mcpListSelRef.current = (mcpListSelRef.current + 1) % len;
              dispatch({ type: 'MCP_PANEL_SELECT', index: mcpListSelRef.current });
            }
            break;
          }
          if (key.return) {
            const server = p.servers[mcpListSelRef.current];
            if (server) dispatch({ type: 'MCP_PANEL_OPEN_DETAIL', server });
            break;
          }
          if (input === 'f' || input === 'F') { runRefreshAll(); break; }
          break;
        }
        // skills 面板：只读浏览
        if (key.escape || input === 'q') { dispatch({ type: 'SKILLS_PANEL_CLOSE' }); break; }
        if (key.upArrow || key.downArrow) {
          const len = state.skillsPanel!.skills.length;
          if (len > 0) {
            skillsSelRef.current = (skillsSelRef.current + (key.downArrow ? 1 : -1) + len) % len;
            dispatch({ type: 'SKILLS_PANEL_SELECT', index: skillsSelRef.current });
          }
          break;
        }
        break;
      }

      // ESC：关闭斜杠命令联想（空闲时）；否则停止运行中任务
      if (key.escape && state.slashSuggestions && phase === 'idle') {
        dispatch({ type: 'SET_SLASH', slashSuggestions: null });
        continue;
      }
      if (key.escape && !isConfirming && !panelOpen && phase !== 'idle') {
        debugLog('Input — ESC abort', { phase });
        triggerStop();
        abortActiveLoop();
        continue;
      }

      // Confirm mode
      if (isConfirming && state.confirmPrompt) {
        const p = state.confirmPrompt;
        // Ctrl+C 在确认期间 = 终止整个任务（替代旧版“终止任务”选项）
        if (key.ctrl && input === 'c') {
          pendingMemoryDelete = null;
          dispatch({ type: 'CONFIRM_RESULT', result: 'abort' });
          continue;
        }

        // plan 模式退出确认：1/2/3 直接选择，Enter 确认当前项
        if (p.kind === 'plan') {
          const resolvePlan = (result: string) => {
            if (result === 'allow') {
              dispatch({ type: 'SET_MODE', mode: 'default' as any });
              dispatch({ type: 'ADD_SYSTEM_MSG', content: '  Implement plan — mode: NORMAL' });
            } else if (result === 'allow_clear') {
              clearSessionApprovals();
              dispatch({ type: 'SET_MODE', mode: 'default' as any });
              dispatch({ type: 'CLEAR_CONTEXT' });
              dispatch({ type: 'ADD_SYSTEM_MSG', content: '  Implement plan with fresh context — mode: NORMAL' });
            } else {
              dispatch({ type: 'ADD_SYSTEM_MSG', content: '  Staying in PLAN mode' });
            }
            dispatch({ type: 'CONFIRM_RESULT', result });
          };
          if (input === '1' || input === '2' || input === '3') {
            resolvePlan(p.options[Number(input) - 1].value);
            continue;
          }
          if (key.upArrow) { dispatch({ type: 'CONFIRM_NAVIGATE', direction: -1 }); continue; }
          if (key.downArrow) { dispatch({ type: 'CONFIRM_NAVIGATE', direction: 1 }); continue; }
          if (key.escape || key.return) { resolvePlan(key.escape ? 'deny' : p.options[p.selected].value); continue; }
          continue;
        }

        // /memory rm 删除确认：y/Enter 执行删除，n/Esc 取消
        if (p.kind === 'delete') {
          const target = pendingMemoryDelete;
          if (key.escape) {
            pendingMemoryDelete = null;
            dispatch({ type: 'CONFIRM_RESULT', result: 'deny' });
            continue;
          }
          if (key.upArrow) { dispatch({ type: 'CONFIRM_NAVIGATE', direction: -1 }); continue; }
          if (key.downArrow) { dispatch({ type: 'CONFIRM_NAVIGATE', direction: 1 }); continue; }
          const confirmDelete = (): void => {
            if (target) {
              const r = removeMemory(target.name, process.cwd());
              dispatch({
                type: 'ADD_SYSTEM_MSG',
                content: r
                  ? `  Memory deleted: ${r.file} (${r.scope})`
                  : `  Memory not found: ${target.name}`,
              });
            }
            pendingMemoryDelete = null;
            dispatch({ type: 'CONFIRM_RESULT', result: 'allow' });
          };
          if (key.return) {
            if (p.selected === 0) confirmDelete();
            else {
              pendingMemoryDelete = null;
              dispatch({ type: 'CONFIRM_RESULT', result: 'deny' });
            }
            continue;
          }
          if (input === 'y' || input === 'Y' || input === '1') { confirmDelete(); continue; }
          if (input === 'n' || input === 'N' || input === '2') {
            pendingMemoryDelete = null;
            dispatch({ type: 'CONFIRM_RESULT', result: 'deny' });
            continue;
          }
          continue;
        }

        if (p.kind === 'high-risk' && key.escape) {
          dispatch({ type: 'CONFIRM_RESULT', result: 'deny' });
          continue;
        }

        // 反馈输入模式：“No, and tell me what to do differently” 之后
        if (p.feedbackMode) {
          if (key.backspace || key.delete) {
            fbText = fbText.slice(0, -1);
            dispatch({ type: 'CONFIRM_FEEDBACK_INPUT', text: fbText });
            continue;
          }
          if (key.return) {
            const text = fbText.trim();
            // high-risk 确认短语 → phrase: 前缀（repl 比对 confirmPhrase）；其余为 deny_feedback 语义
            const prefix = p.kind === 'high-risk' ? 'phrase' : 'deny_feedback';
            dispatch({ type: 'CONFIRM_RESULT', result: text ? `${prefix}:${text}` : 'deny' });
            continue;
          }
          if (key.escape) { dispatch({ type: 'CONFIRM_RESULT', result: 'deny' }); continue; }
          if (input && !key.ctrl && !key.meta && !key.shift) {
            fbText += input;
            dispatch({ type: 'CONFIRM_FEEDBACK_INPUT', text: fbText });
            continue;
          }
          continue;
        }

        // 快捷键直选：edit/command 用 y/a/p
        let matchedOption = false;
        for (const opt of p.options) {
          if (input === opt.key) {
            dispatch({ type: 'CONFIRM_RESULT', result: opt.value });
            matchedOption = true;
            break;
          }
        }
        if (matchedOption) continue;
        if (key.upArrow) { dispatch({ type: 'CONFIRM_NAVIGATE', direction: -1 }); continue; }
        if (key.downArrow) { dispatch({ type: 'CONFIRM_NAVIGATE', direction: 1 }); continue; }
        // Esc = 最后一个选项（“No, and tell me what to do differently” → 反馈输入）
        if (key.escape) {
          dispatch({ type: 'CONFIRM_RESULT', result: p.options[p.options.length - 1].value });
          continue;
        }
        if (key.return) {
          dispatch({ type: 'CONFIRM_RESULT', result: p.options[p.selected].value });
          continue;
        }
        // 其他按键忽略
        continue;
      }

      // Ctrl+C/D → exit（进程即将退出，块内后续事件无需处理）
      if (key.ctrl && (input === 'c' || input === 'd')) { doExit(); break; }
      // Arrows：斜杠联想可见时上下选择命令（对齐 Claude Code），否则走输入历史
      if (key.upArrow) {
        const s = state.slashSuggestions;
        if (s && s.matches.length > 0) {
          const len = s.matches.length;
          slashSelRef.current = (slashSelRef.current - 1 + len) % len;
          dispatch({ type: 'SLASH_SELECT', index: slashSelRef.current });
          continue;
        }
        if (!state.inputHistory.length) continue;
        const idx = historyIdx === -1 ? state.inputHistory.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(idx); commitInput(state.inputHistory[idx], state.inputHistory[idx].length); continue;
      }
      if (key.downArrow) {
        const s = state.slashSuggestions;
        if (s && s.matches.length > 0) {
          const len = s.matches.length;
          slashSelRef.current = (slashSelRef.current + 1) % len;
          dispatch({ type: 'SLASH_SELECT', index: slashSelRef.current });
          continue;
        }
        if (historyIdx === -1) continue;
        if (historyIdx < state.inputHistory.length - 1) { const idx = historyIdx + 1; setHistoryIdx(idx); commitInput(state.inputHistory[idx], state.inputHistory[idx].length); }
        else { setHistoryIdx(-1); commitInput('', 0); } continue;
      }

      // Shift+Tab → mode
      if (key.shift && key.tab) { dispatch({ type: 'CYCLE_MODE' }); continue; }

      // Tab → 斜杠命令联想：唯一匹配直接补全，多匹配循环选择
      if (key.tab && value.startsWith('/')) {
        // /config get|set|unset 的键路径补全（含空白，先于命令名联想处理）
        const completed = completeConfigKey(value);
        if (completed) {
          commitInput(completed, completed.length);
          continue;
        }
        // 基于当前输入值实时计算（批内 dispatch 异步，state.slashSuggestions 可能滞后一拍）
        const trimmed = value.trim();
        if (trimmed.startsWith('/') && !/\s/.test(value)) {
          const m = SLASH_COMMANDS.filter(c => c.toLowerCase().startsWith(trimmed.toLowerCase()));
          if (m.length === 1) {
            commitInput(m[0], m[0].length);
          } else if (m.length > 1) {
            const s = state.slashSuggestions;
            const sel = s && s.matches.length === m.length ? s.selected : 0;
            slashSelRef.current = (sel + 1) % m.length;
            dispatch({ type: 'SLASH_SELECT', index: slashSelRef.current });
          }
        }
        continue;
      }

      // Enter → submit
      if (key.return) {
        // 联想可见时直接执行当前选中命令（对齐 Claude Code）
        const s = state.slashSuggestions;
        if (s && s.matches.length > 0) {
          const cmd = s.matches[Math.min(slashSelRef.current, s.matches.length - 1)];
          handleSlash(cmd);
          commitInput('', 0);
          setHistoryIdx(-1);
          clearPasteStore();
          continue;
        }
        const raw = value.trim(); if (!raw) continue;
        // 大段粘贴占位符在提交时还原为完整内容（未知/破损 token 原样提交）
        const val = expandPasteTokens(raw);
        if (!val) continue;
        // 只有已注册命令才走斜杠命令处理；绝对路径等以 / 开头的普通输入直接提交给模型
        if (isSlashCommand(val)) {
          handleSlash(val);
          commitInput('', 0);
          setHistoryIdx(-1);
          clearPasteStore();
          continue;
        }
        debugLog('Input — user submitted', { inputLen: val.length });
        dispatch({ type: 'SUBMIT_INPUT', input: val });
        commitInput('', 0);
        setHistoryIdx(-1);
        clearPasteStore();
        continue;
      }

      // Backspace / Delete（按光标位置删除）
      if (key.backspace || key.delete) {
        if (key.delete) {
          if (pos < value.length) { commitInput(value.slice(0, pos) + value.slice(pos + 1), pos); }
        } else if (pos > 0) {
          commitInput(value.slice(0, pos - 1) + value.slice(pos), pos - 1);
        }
        continue;
      }

      // 光标移动
      if (key.leftArrow) { commitInput(value, Math.max(0, pos - 1)); continue; }
      if (key.rightArrow) { commitInput(value, Math.min(value.length, pos + 1)); continue; }
      if (key.home) { commitInput(value, 0); continue; }
      if (key.end) { commitInput(value, value.length); continue; }

      // Text input（插入到光标处，支持粘贴多字符）
      if (input?.length > 0) {
        commitInput(value.slice(0, pos) + input + value.slice(pos), pos + input.length);
        continue;
      }
    }
  });

  // 粘贴走 Ink 独立 paste 通道（bracketed paste）：整段插入光标处、保留换行，
  // 绝不触发提交；确认弹窗期间输入框隐藏，忽略粘贴。
  usePaste((text) => {
    if (isConfirming || panelOpen) return;
    const pasted = normalizePastedText(text);
    if (!pasted) return;
    // 已有占位符时先展开（再粘贴一次 = 展开占位符，CC v2.1.116 行为），再处理新粘贴
    let base = state.inputValue;
    let baseCursor = cursor;
    if (hasPastePlaceholder(base)) {
      // 光标随展开内容同步映射，避免落到展开后内容的中间
      const expanded = expandPasteTokensAt(base, baseCursor);
      base = expanded.text;
      baseCursor = expanded.cursor;
    }
    // 大段粘贴（≥ 20 行）折叠为占位符、完整内容存进程内存储；小段仍内联多行插入
    const insert = shouldCollapsePaste(pasted) ? storePasteContent(pasted) : pasted;
    const next = insertAt(base, baseCursor, insert);
    dispatch({ type: 'SET_INPUT', value: next.value });
    setCursor(next.cursor);
  });

  // 确认弹窗显示期间隐藏输入框（Codex CLI：ApprovalOverlay 接管输入区）。
  // hooks（useInput/usePaste）已全部执行，返回 null 不影响它们继续捕获
  // 确认按键；确认/终止后输入框恢复，已输入内容保留（state.inputValue）。
  if (isConfirming || panelOpen) return null;

  // Use termWidth from context (captured before Ink patches stdout)
  // Fallback to process.stdout.columns, then 200 (wide enough for most terminals)
  const w = termWidth || process.stdout.columns || 200;

  // 多行输入渲染：按行显示，光标定位到对应 (行, 列)，
  // 行数超预算时开窗口滚动并保证光标行可见（预算 maxInputLines(termHeight)）
  const lines = state.inputValue.split('\n');
  const { line: cursorLine, col: cursorCol } = cursorToLineCol(state.inputValue, cursor);
  const win = inputWindow(lines.length, cursorLine, maxInputLines(termHeight));
  const visibleLines: Array<{ index: number; line: string }> = [];
  for (let i = win.start; i < win.end; i++) {
    visibleLines.push({ index: i, line: lines[i] });
  }

  // 常驻状态行：模型 · 模式 · 工作目录（模式段着色，与顶部 StatusBar 一致）
  // 预算按显示宽度：w−1 余量 + GBK 下两个 · 各多占 1 列（−2），cwd 截断用 displayWidth
  const modeLabelText = modeLabel(mode);
  const modeColor =
    mode === 'plan' ? 'yellow' : mode === 'bypassPermissions' ? 'red' : 'green';
  const shownCwd = fitTail(
    process.cwd(),
    Math.max(1, w - 3 - displayWidth(`${model} · ${modeLabelText} · `)),
  );

  // 输入行水平开窗（Windows 左移修复）：帧内任何行显示宽都不得超过 w−1——
  // 满宽行把光标停在末列，帧间 \n 列错位时触发物理折行 → 逐帧漂移。
  // 光标行以显示列开窗保证 █ 恒可见，超宽部分左侧以 … 指示。
  const PROMPT_WIDTH = 3; // displayWidth('❯ ')=3（Ink string-width 按 2 计，取保守值防折行）
  const CURSOR_WIDTH = 1; // █
  const textBudget = Math.max(1, w - 1 - CURSOR_WIDTH); // 光标行正文可用列（含提示符/指示符）
  const renderedLines = visibleLines.map((row, i) => {
    const isFirst = i === 0;
    const promptW = isFirst ? PROMPT_WIDTH : 0;
    if (row.index !== cursorLine) {
      // 非光标行：尾部截断到 w−1（−提示符），无窗口无指示符
      const text = sliceToDisplayWidth(row.line, 0, Math.max(1, w - 1 - promptW)).text;
      return (
        <Box key={row.index}>
          {isFirst && <Text dimColor>{PROMPT}</Text>}
          <Text>{text}</Text>
        </Box>
      );
    }
    const lineW = displayWidth(row.line);
    const curD = displayCol(row.line, cursorCol);
    let budget = Math.max(1, textBudget - promptW);
    // 预留左指示符（GBK 下 … 占 2 列 → 预留 2）
    if (lineW > budget) budget = Math.max(1, budget - 2);
    const hw = inputWindowH(lineW, curD, budget);
    const left = sliceToDisplayWidth(row.line, hw.start, curD - hw.start);
    const right = sliceToDisplayWidth(row.line, curD, hw.end - curD);
    return (
      <Box key={row.index}>
        {isFirst && <Text dimColor>{PROMPT}</Text>}
        <Box flexDirection="row">
          {hw.hiddenLeft > 0 && <Text dimColor>…</Text>}
          <Text>{left.text}</Text>
          <Text>█</Text>
          <Text>{right.text}</Text>
        </Box>
      </Box>
    );
  });

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* 有消息内容时在输入框与消息区之间留一行呼吸空间；
          启动/清屏后无消息，logo 与输入框保持紧凑 */}
      {state.history.length > 0 && <Box height={1} />}
      {/* 瞬时提示（/clear 确认等）：紧贴输入框上方，提交后清除；capLine 按显示宽截断防折行 */}
      {state.notice && (
        <Text color="yellow">  ℹ {capLine(state.notice, Math.max(1, w - 5))}</Text>
      )}
      <Text color="cyan">{dividerText(w)}</Text>
      <Box flexDirection="column">{renderedLines}</Box>
      <Text color="cyan">{'─'.repeat(Math.max(0, w - 1))}</Text>
      {/* 斜杠命令联想：渲染在输入框下方（对齐 Claude Code），命令名 + 说明 */}
      {state.slashSuggestions && state.slashSuggestions.matches.length > 0 && (
        <Box flexDirection="column">
          {renderSlashSuggestions(state.slashSuggestions, w)}
        </Box>
      )}
      {/* 联想可见时隐藏常驻状态行（对齐 Claude Code：列表出现后状态行消失） */}
      {!state.slashSuggestions && (
        <Box>
          <Text dimColor>{model}</Text>
          <Text dimColor> · </Text>
          <Text color={modeColor}>{modeLabelText}</Text>
          <Text dimColor> · </Text>
          <Text dimColor>{shownCwd}</Text>
        </Box>
      )}
    </Box>
  );
}

/** 斜杠联想列表：`/命令  说明` 对齐展示，选中项高亮，超长截断。
 *  窗口渲染：以选中项为中心滚动（窗口 ≤ SLASH_MAX 行 + 1 行方向指示器），
 *  选中项深入列表时后段命令仍可见、高亮不消失。 */
function renderSlashSuggestions(
  slash: { matches: string[]; selected: number },
  termWidth: number,
) {
  const n = slash.matches.length;
  const start = slashWindowStart(n, slash.selected, SLASH_MAX);
  const shown = slash.matches.slice(start, start + SLASH_MAX);
  const cmdWidth = 16;
  const descMax = Math.max(8, termWidth - cmdWidth - 4);
  const rows = shown.map((cmd, i) => {
    const idx = start + i;
    const desc = SLASH_COMMAND_DESCRIPTIONS[cmd] || '';
    return (
      <Box key={cmd}>
        <Text inverse={idx === slash.selected}>
          {idx === slash.selected ? '  ›' : '   '} {cmd.padEnd(cmdWidth)}
        </Text>
        <Text dimColor={idx !== slash.selected}>{capLine(desc, descMax)}</Text>
      </Box>
    );
  });
  if (n > SLASH_MAX) {
    const above = start;
    const below = n - (start + SLASH_MAX);
    const indicator = [
      above > 0 ? `↑ 还有 ${above} 个` : '',
      below > 0 ? `↓ 还有 ${below} 个` : '',
    ].filter(Boolean).join(' · ');
    rows.push(
      <Text key="overflow" dimColor>  {indicator}</Text>,
    );
  }
  return rows;
}
