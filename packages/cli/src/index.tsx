#!/usr/bin/env node
/**
 * shenlan CLI — Ink-based full-screen TUI
 */
import { render } from 'ink';
import { loadConfig, loadDotEnvFiles, ensureProjectConfigFiles, registerAllTools, createSession, flushAllSessions, syncSessionMessages, writeSessionMeta, loadSession, listSessions, connectMcpServers, disconnectAll, isPriceTableExpired, hasAnyProviderKey, setAgentConfig, setSafetyConfig, setTranscribeRunner, whisperTranscribeRunner, checkDeepseekBalance, loadUserPrices, syncPrices, resolveApiKey, resolveModelProvider } from '@shenlan/core';
import { getEffectiveModel, initRoutingFromConfig } from './router.js';
import { formatSyncResult } from './commands/prices.js';
import { runWizard } from './wizard.js';
import { gitRoot, installPreCommitHook, hookStatus } from './security.js';
import { App } from './app.js';
import { setMode } from './mode.js';
import { installSuspendHandlers } from './signals.js';
import type { Message, Session } from '@shenlan/core';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VERSION } from './version.js';
import { printHelp } from './help.js';
import { capLine } from './streaming.js';
import { formatResumeCommand } from './resume-hint.js';
import {
  checkForUpdate,
  formatUpdateResult,
  shouldRunAutomaticUpdateCheck,
} from './update-check.js';

/**
 * 内存防线：React DEV 模式的 performance.measure 会把每次渲染的 props
 * （含 <Static> 的全量 items 数组）挂到 performance 时间线，Node 不自动清理；
 * 流式输出持续渲染时旧元素被无限保留，最终 JavaScript heap OOM（实测 4GB 崩溃）。
 * 每 2s 清空时间线，解除对旧 fiber/元素的引用（不影响 DevTools，其走 Observer）。
 */
const perfCleanupTimer = setInterval(() => {
  try {
    performance.clearMarks();
    performance.clearMeasures();
  } catch { /* 非浏览器环境忽略 */ }
}, 2000);
perfCleanupTimer.unref?.();

// ---- 统一退出例程（幂等） ----
let gracefulExited = false;

/**
 * 统一退出：全量落盘当前会话 → 恢复终端 → 打印 resume 提示 → 退出。
 * 所有退出路径（/exit、Ctrl+C/D、SIGTERM、SIGHUP、未捕获异常）都走这里，
 * 保证会话不丢、挂起后能 `shenlan --resume <id>` 找回。
 */
/**
 * 启动期异步告警的可用宽度：终端宽度 - 1（留一列防自动换行），
 * 无 TTY 信息时按 80 兜底。
 */
function noticeWidth(): number {
  return Math.max(1, (process.stdout.columns || 80) - 1);
}

function gracefulExit(code: number): void {
  if (gracefulExited) return;
  gracefulExited = true;
  // Cancel every pending timer and drain any session buffers before process.exit.
  try { flushAllSessions(); } catch { /* continue best-effort shutdown */ }
  // 断开全部 MCP 连接，避免 stdio 子进程残留
  try { disconnectAll(); } catch { /* ignore */ }
  let session: Session | undefined;
  const msgs: Message[] = (globalThis as any).__shenlanMessages || [];
  try {
    session = (globalThis as any).__shenlanSession as Session | undefined;
    if (session) {
      try {
        // 全量同步：flush 批量缓冲 + 截断重写为当前内存消息，
        // 保证最后一条尚未刷盘的消息也不丢，且文件内容与当前对话一致
        session.messages = msgs;
        syncSessionMessages(session.id, msgs);
        writeSessionMeta(session, { updatedAt: new Date().toISOString() });
      } catch { /* 落盘失败不阻塞退出 */ }
    }
  } catch { /* ignore */ }
  // 先卸载 Ink：恢复被 patch 的 console + 擦除动态帧。
  // 否则 console.log 会被 Ink 拦截进帧重绘（提示与残留 TUI 纠缠），
  // 且 process.exit 立即打断，导致 resume 提示在终端上看不到。
  try {
    const ink = (globalThis as any).__shenlanInk;
    if (ink?.clear) ink.clear();
    if (ink?.unmount) ink.unmount();
  } catch { /* 终端已失效等场景忽略 */ }
  if (session && msgs.length > 0) {
    try {
      console.log('');
      console.log(`  会话已保存 (id: ${session.id})`);
      console.log(`  继续上次会话：${formatResumeCommand(session.id)}`);
      // 与 shell 提示符之间留空行
      console.log('');
    } catch { /* SIGHUP 等 stdout 失效场景忽略 */ }
  }
  try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  try { process.stdout.write('\x1b[?25h'); } catch { /* ignore */ }
  process.exit(code);
}

/** 安装信号/异常兜底：SIGTERM/SIGHUP/SIGINT 优雅退出，未捕获异常先保存再退出 */
function installGracefulExitHandlers(): void {
  process.on('SIGTERM', () => gracefulExit(0));
  process.on('SIGHUP', () => gracefulExit(0));
  // raw 模式下 Ctrl+C 是普通字节（InputBox 处理），真实 SIGINT 仅来自外部 kill -INT
  process.on('SIGINT', () => gracefulExit(0));
  process.on('uncaughtException', () => gracefulExit(1));
  process.on('unhandledRejection', () => gracefulExit(1));
}

function reportSessionRecovery(session: Session): void {
  if (!session.recovery) return;
  console.log(`  ⚠ Session data for ${session.projectPath || 'unknown project'} is incomplete at line ${session.recovery.line}; restored ${session.messages.length} valid messages. Original session file was kept unchanged.\n`);
}

function sameProjectPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function startInteractive(options: { continueLast?: boolean; resumeId?: string } = {}): Promise<void> {
  const projectPath = gitRoot(process.cwd()) || resolve(process.cwd());
  let resumedSession: Session | null = null;
  if (options.resumeId) {
    resumedSession = loadSession(options.resumeId);
    if (!resumedSession) throw new Error(`Cannot resume session "${options.resumeId}": session ID is invalid or the session file does not exist.`);
    if (!resumedSession.projectPath) throw new Error(`Cannot resume session "${options.resumeId}": project identity is missing from its metadata.`);
    if (!sameProjectPath(resumedSession.projectPath, projectPath)) {
      throw new Error(`Cannot resume session "${options.resumeId}": it belongs to another project (${resumedSession.projectPath}).`);
    }
  }

  // 首次运行懒生成：项目 .shenlan 目录 + 配置样例（全局目录由 loadConfig 生成）
  ensureProjectConfigFiles(process.cwd());
  // .env 加载（项目 cwd/.env + 全局 ~/.shenlan/.env），先于配置合并与引导判断
  loadDotEnvFiles(process.cwd());
  const config = loadConfig();
  // 恢复持久化的路由策略 / 手动锁定模型（/model 写入全局配置）
  initRoutingFromConfig(config);
  // 启动时用配置里的权限模式初始化运行时模式（此后 Shift+Tab 切换即时生效）
  setMode(config.permissions.mode);
  await registerAllTools();

  // 首次引导判定：无任何 provider key 且引导未完成（fresh user）
  const firstRun = !hasAnyProviderKey(config) && !config.onboarding?.done;

  // 加载本地价格表：无效条目/解析失败在启动时打印警告（不阻塞）。
  // 首次引导时抑制这些噪音输出，让欢迎页保持干净（对齐 Codex 首次运行）。
  const loadedPrices = loadUserPrices();
  if (!firstRun) {
    for (const w of loadedPrices.warnings) console.log(`  ⚠ ${w}`);
    if (loadedPrices.parseError) console.log(`  ⚠ ${loadedPrices.parseError}`);
  }

  // Connect MCP servers
  if (config.mcpServers?.length) {
    try { await connectMcpServers(config.mcpServers); } catch { /* MCP failure non-blocking */ }
  }

  // 提交时安全检查：检测到 git 仓库且 pre-commit 不存在 → 静默安装本产品钩子；
  // 已存在非本产品钩子不覆盖，打印提示交 /security 处理
  if (gitRoot(process.cwd())) {
    const st = hookStatus(process.cwd());
    if (!st.hookExists) {
      installPreCommitHook(process.cwd(), { silent: true });
    } else if (!st.ours) {
      console.log('  ⚠ 检测到已有非 shenlan pre-commit 钩子，未覆盖；可用 /security 查看');
    }
  }

  // Session management
  let messages: Message[] = [];

  if (options.resumeId) {
    messages.push(...resumedSession!.messages);
    reportSessionRecovery(resumedSession!);
    console.log(`  Resumed session ${options.resumeId} for ${projectPath} (${resumedSession!.messages.length} messages)\n`);
  } else if (options.continueLast) {
    const sessions = listSessions().filter((candidate) =>
      candidate.projectPath && sameProjectPath(candidate.projectPath, projectPath),
    );
    if (sessions.length > 0) {
      const prev = loadSession(sessions[0].id);
      if (prev) {
        messages.push(...prev.messages);
        reportSessionRecovery(prev);
        console.log(`  Continued session ${sessions[0].id} for ${projectPath} (${prev.messages.length} messages)\n`);
      }
    } else {
      console.log(`  No saved session found for ${projectPath}; starting a new session.\n`);
    }
  }

  const session = createSession(undefined, projectPath);
  writeSessionMeta(session);
  (globalThis as any).__shenlanSession = session;

  // 首次引导：无 key、未完成引导且是全新会话 → App 挂载后打开欢迎流程；
  // 恢复会话（--resume/--continue）不打断已有上下文。
  const onboarding = firstRun && messages.length === 0;

  // 引导已完成但无 key：给一行轻提示（/keys 随时可配），不打断使用
  if (!onboarding && !hasAnyProviderKey(config)) {
    console.log('  ⚠ 未配置 API Key — 输入 /keys 配置（或运行 shenlan --setup）\n');
  }

  if (!firstRun && isPriceTableExpired()) {
    console.log('  ⚠ Price table may be outdated. Check official pricing.\n');
  }

  // Save terminal dimensions before Ink patches stdout
  const termWidth = process.stdout.columns || process.stderr.columns || 200;
  const termHeight = process.stdout.rows || process.stderr.rows || 24;
  // Write width to a temp file so components can read it
  // (Ink's stdout wrapper returns column position, not terminal width)
  const widthFile = join(process.cwd(), '.shenlan', '.term-width');
  try { writeFileSync(widthFile, String(termWidth)); } catch {}

  // Inject config for agent tool (sub-agent spawning)
  setAgentConfig(config, getEffectiveModel());
  // 动作安全网依赖（protectedPaths 等）
  setSafetyConfig(config);
  // 转写管线默认 runner（whisper CLI；可替换实现）
  setTranscribeRunner(whisperTranscribeRunner);

  // DeepSeek 余额启动预检（默认开，§21 L2；无 key 静默跳过，失败不阻断启动）。
  // 触发收紧（#13）：主力模型不在 deepseek 上时不查——余额是 deepseek 路由/故障转移
  // 的信用前置，配了 deepseek key 但主力 openai/qwen 时该检查无决策价值（噪音）。
  if (
    config.balanceCheck?.enabled !== false
    && resolveApiKey(config, 'deepseek')
    && resolveModelProvider(config, getEffectiveModel()) === 'deepseek'
  ) {
    checkDeepseekBalance(config).then((r) => {
      if (!r.checked) return;
      // 预检是 fire-and-forget，回调可能在 Ink 已渲染后触发（patchConsole 将其并入帧上方）。
      // 这类异步告警必须按终端宽度 - 1 截断：满宽行会让终端自动换行、多出一行幻影，
      // 使 Ink 行计数错位（Windows/Wave 打字界面左移的成因之一）。
      const notice = (text: string) => console.log(capLine(text, noticeWidth()));
      if (!r.available) {
        notice(`  ⚠ DeepSeek 余额不可用${r.error ? `（${r.error}）` : '（余额不足）'}——请求可能被 402 拒绝，建议充值或 /keys 更换 key`);
      } else if (
        r.balanceCny !== undefined
        && r.balanceCny < (config.balanceCheck?.lowBalanceWarnThreshold ?? 1)
      ) {
        notice(`  ⚠ DeepSeek 余额偏低：¥${r.balanceCny.toFixed(2)}（阈值 ¥${config.balanceCheck?.lowBalanceWarnThreshold ?? 1}）`);
      }
    }).catch(() => { /* 预检失败不影响启动 */ });
  }

  // 信号兜底（会话创建后即可安装；挂起透明化只针对交互模式）
  installGracefulExitHandlers();
  installSuspendHandlers();

  // Launch Ink TUI
  const inkInstance = render(
    <App
      config={config}
      model={getEffectiveModel()}
      version={VERSION}
      termWidth={termWidth}
      termHeight={termHeight}
      initialMessages={messages}
      session={session}
      onboarding={onboarding}
    />,
    // 主屏渲染：历史/流式整行经 <Static> 写入终端原生回滚区，
    // 动态帧有界（见 dynamic-budget.ts）避免 Ink 整屏清空模式
    { patchConsole: true, exitOnCtrlC: false },
  );
  // 退出时先 clear+unmount 恢复原生 console 并擦除帧，再打印 resume 提示
  (globalThis as any).__shenlanInk = inkInstance;

  // 启动版本检查：只在交互 TTY、非首次引导、未显式关闭时触发。
  // 直接请求 registry，24 小时缓存；完全异步，失败/已是最新均静默。
  // 通知写入 Static 历史，且逐行按 termWidth 留足系统消息前缀与最后一列。
  if (!firstRun && shouldRunAutomaticUpdateCheck({ enabled: config.updateCheck?.enabled })) {
    checkForUpdate(VERSION).then((result) => {
      if (result.status !== 'update') return;
      const dispatch = (globalThis as any).__shenlanDispatch;
      if (!dispatch) return;
      const content = formatUpdateResult(result)
        .split('\n')
        .map(line => capLine(line, Math.max(1, termWidth - 5)))
        .join('\n');
      dispatch({ type: 'ADD_SYSTEM_MSG', content });
    }).catch(() => { /* 更新检查失败不影响启动 */ });
  }

  // 启动异步联网核对一次官方价格（3-8 秒超时、不阻塞输入、失败不打扰）：
  // 发现差异全自动写入 ~/.shenlan/prices.json（manual 条目跳过），完成后经
  // __shenlanDispatch 发系统消息提示；App 已挂载，dispatch 可用。
  syncPrices(['qwen', 'deepseek'], { config }).then((result) => {
    const dispatch = (globalThis as any).__shenlanDispatch;
    if (dispatch && result.updated.length > 0) {
      dispatch({ type: 'ADD_SYSTEM_MSG', content: formatSyncResult(result) });
    }
  }).catch(() => { /* 启动同步失败不打扰用户 */ });

  // Don't rely on Ink's waitUntilExit (it exits prematurely on Windows)
  // Instead, keep process alive ourselves, with clean exit via global handler
  await new Promise<void>((resolve) => {
    (globalThis as any).__shenlanExit = () => {
      gracefulExit(0);
    };
  });
}

// ---- Entry ----
const a = process.argv.slice(2);
if (a.includes('--version') || a.includes('-v')) { console.log(`shenlan v${VERSION}`); process.exit(0); }
if (a.includes('--help') || a.includes('-h')) {
  printHelp();
  process.exit(0);
}

// MCP / skills 管理子命令（非交互）
if (a[0] === 'mcp') {
  import('./mcp.js').then(async ({ runMcpCommand }) => {
    const code = await runMcpCommand(a.slice(1));
    process.exit(code);
  }).catch(e => { console.error(`mcp: ${(e as Error).message}`); process.exit(2); });
} else if (a[0] === 'skills') {
  import('./skills.js').then(async ({ runSkillsCommand }) => {
    const code = await runSkillsCommand(a.slice(1));
    process.exit(code);
  }).catch(e => { console.error(`skills: ${(e as Error).message}`); process.exit(2); });
} else if (a[0] === 'security') {
  import('./security.js').then(async ({ runSecurityCommand }) => {
    const code = await runSecurityCommand(a.slice(1));
    process.exit(code);
  }).catch(e => { console.error(`security: ${(e as Error).message}`); process.exit(2); });
} else if (a[0] === 'audit') {
  import('./commands/audit.js').then(async ({ runAuditCommand }) => {
    const code = await runAuditCommand(a.slice(1));
    process.exit(code);
  }).catch(e => { console.error(`audit: ${(e as Error).message}`); process.exit(2); });
} else if (a[0] === 'config') {
  import('./commands/config.js').then(({ configCommand }) => {
    console.log(configCommand(a.slice(1).join(' ')));
    process.exit(0);
  }).catch(e => { console.error(`config: ${(e as Error).message}`); process.exit(2); });
}

// Setup wizard
else if (a.includes('--setup')) {
  runWizard().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  process.stdin.resume();
}

// Headless single-task mode
else if (a[0] === 'run') {
  (async () => {
    ensureProjectConfigFiles(process.cwd());
    loadDotEnvFiles(process.cwd());
    const config = loadConfig();
    // headless 不联网：只加载本地价格（manual/auto 覆盖生效，供本地估算与路由使用）
    loadUserPrices();
    // headless 同样恢复持久化路由状态（manual 锁定对 shenlan run 生效）
    initRoutingFromConfig(config);
    await registerAllTools();
    setAgentConfig(config, getEffectiveModel());
    setSafetyConfig(config);
    setTranscribeRunner(whisperTranscribeRunner);
    if (config.mcpServers?.length) {
      try { await connectMcpServers(config.mcpServers); } catch { /* skip */ }
    }

    const args = a.slice(1);
    let readonly = false;
    if (args[0] === '--readonly') { readonly = true; args.shift(); }
    const task = args.join(' ').trim();
    if (!task) {
      console.error('Usage: shenlan run <task description>');
      process.exit(2);
    }

    const { runTask } = await import('./run.js');
    const result = await runTask(task, config, { readonly });

    console.log(JSON.stringify({
      status: result.status,
      steps: result.steps,
      cost: result.cost,
      localEstimateCny: result.localEstimateCny,
      summary: result.summary,
      ...(result.error ? { error: result.error } : {}),
    }, null, 2));

    if (result.output) {
      console.log('\n' + result.output);
    }

    try { disconnectAll(); } catch { /* ignore */ }
    process.exit(result.status === 'completed' ? 0 : result.status === 'failed' ? 2 : 3);
  })().catch(e => { console.error(`Run failed: ${e.message}`); process.exit(2); });
} else {
  const continueLast = a.includes('--continue') || a.includes('-c');
  const resumeIdx = a.indexOf('--resume');
  const resumeId = resumeIdx >= 0 ? a[resumeIdx + 1] : undefined;
  if (resumeIdx >= 0 && (!resumeId || resumeId.startsWith('-'))) {
    console.error('Failed: --resume requires a session ID.');
    process.exit(1);
  }
  startInteractive({ continueLast, resumeId }).catch(e => { console.error(`Failed: ${e.message}`); process.exit(1); });
}
