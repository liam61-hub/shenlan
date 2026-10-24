/**
 * Shell 命令执行工具
 *
 * 超时语义对齐 Claude Code / Codex：
 *  - 默认超时 120s（单次可调 timeout，上限 600s，对齐 BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS）
 *  - 命令超过超时后**不杀进程**：自动转入后台继续运行，工具立即返回
 *    "Command timed out after N seconds — still running in the background (id: bg-xxx)"
 *    + 已捕获的部分输出（不再输出 "Command exited with code null" 这种误导性错误）
 *  - 配套 shell_status（按 id 查询后台命令状态/输出，对齐 BashOutput）与
 *    shell_kill（按 id 终止，对齐 KillBash）
 *  - 用户中止（abort）时按进程组整体终止，避免子进程泄漏（对齐 Codex #4337 教训）
 *
 * Windows 编码处理：cmd.exe 输出为 GBK（代码页 936），Node.js 默认 UTF-8 解码会乱码。
 * 使用原始 Buffer 累积 + 检测到 UTF-8 解码失败时自动回退到 GBK。
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { maskSensitive } from '../security.js';
import { registerTool } from './index.js';

/** 默认超时（对齐 Claude Code BASH_DEFAULT_TIMEOUT_MS = 120s） */
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
/** 单次命令最大超时（对齐 Claude Code BASH_MAX_TIMEOUT_MS = 600s） */
export const SHELL_MAX_TIMEOUT_MS = 600_000;
/** 单任务保留输出上限（超出丢旧保新，避免后台任务长期挂机撑爆内存） */
const TASK_OUTPUT_CAP = 10 * 1024 * 1024;
/** 单次返回的最大输出长度 */
const MAX_RETURN_CHARS = 8000;
/** 后台任务完成后保留时长（超出即清理，防止长会话内存膨胀） */
const BG_TASK_RETENTION_MS = 10 * 60 * 1000;

/** 高危命令模式表（独立于权限模式，始终生效；shell 执行内拦截与 CLI 预检共用） */
export const HIGH_RISK_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/i,  // rm -rf / rm -fr
  /\bdd\s+if=/i,                                                // dd 写设备
  /\bmkfs\./,                                                   // mkfs 格式化
  /\bformat\s+[a-z]:/i,                                         // Windows format C: 等
  /\bdel\s+\/[sfq]\s+.*[\*\\]/i,                               // Windows 强制删除通配符
  /\bgit\s+push\s+--force\b/i,                                  // force push
  /\bgit\s+reset\s+--hard\b/i,                                  // hard reset
  /\bchmod\s+(-R\s+)?777\b/i,                                   // chmod 777
  /\bsudo\s+(rm|dd|mkfs|shutdown|reboot)\b/i,                   // sudo + 危险命令
  />\s*\/dev\/sd[a-z]/i,                                        // 写磁盘设备
  /\brmdir\s+\/[a-z]/i,                                         // 删除系统目录
  /\bdel\s+\/[a-z]\s+%[A-Z]+%/i,                                // Windows 删除环境变量路径
];

/** 高危命令检测：命中返回对应 pattern（供错误提示），否则 null */
export function isHighRiskCommand(command: string): RegExp | null {
  if (!command) return null;
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(command)) return pattern;
  }
  return null;
}

/** 后台任务（超时后继续运行，可 shell_status / shell_kill） */
export interface BackgroundTask {
  id: string;
  command: string;
  startedAt: number;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode: number | null;
  chunks: Buffer[];
  totalBytes: number;
  child?: ChildProcess;
}

/** 进程级后台任务注册表（模块内共享，TUI / headless / sub-agent 共用） */
const backgroundTasks = new Map<string, BackgroundTask>();

/** 人类可读的超时时长（对齐 Codex "command timed out after X" 文案） */
export function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 1000) return `${timeoutMs}ms`;
  const seconds = timeoutMs / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10}s`;
}

/** 注册后台任务前清理过期/已完成任务 */
function pruneBackgroundTasks(): void {
  const cutoff = Date.now() - BG_TASK_RETENTION_MS;
  for (const [id, task] of backgroundTasks) {
    if (task.status !== 'running' && task.startedAt < cutoff) {
      backgroundTasks.delete(id);
    }
  }
}

/** 查询后台任务（供测试与诊断） */
export function listBackgroundTasks(): BackgroundTask[] {
  return Array.from(backgroundTasks.values());
}

/**
 * 将 Buffer 解码为字符串，自动处理 Windows GBK 编码
 */
function decodeBuffer(buf: Buffer): string {
  const utf8 = buf.toString('utf-8');
  // 检查是否有 UTF-8 解码失败的替换字符
  if (utf8.includes('\uFFFD')) {
    try {
      // 尝试 GBK（Windows 中文代码页 936）
      return buf.toString('gbk' as BufferEncoding);
    } catch {
      // 无 GBK 支持时回退
    }
  }
  return utf8;
}

/** 读取任务输出（脱敏 + 取末尾 N 字符，避免撑爆上下文） */
function readTaskOutput(task: BackgroundTask, maxChars: number): string {
  const text = decodeBuffer(Buffer.concat(task.chunks));
  return maskSensitive(text).slice(-maxChars);
}

/** 按进程组整体终止（Windows 用 taskkill /T，POSIX 用负 pid 发信号） */
function killProcessGroup(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch { /* 已退出 */ }
    return;
  }
  try {
    // detached 启动时 child 是进程组组长：负 pid 杀整组（含子进程树）
    process.kill(-child.pid, 'SIGTERM');
    return;
  } catch { /* 进程组已不存在 */ }
  try {
    child.kill('SIGTERM');
  } catch { /* 已退出 */ }
}

registerTool({
  name: 'shell',
  description:
    'Execute a shell command and return its stdout/stderr. ' +
    'Default timeout: 120s, max 600s. If the command exceeds the timeout it is NOT killed — ' +
    'it keeps running in the background and the result tells you its id; use shell_status to check its output and shell_kill to terminate it. ' +
    'Use for build, test, git, and file operations.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute (use PowerShell on Windows)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (optional)',
      },
      timeout: {
        type: 'integer',
        description: `Timeout in milliseconds (default: ${SHELL_DEFAULT_TIMEOUT_MS}, max: ${SHELL_MAX_TIMEOUT_MS}). On timeout the command keeps running in the background.`,
      },
    },
    required: ['command'],
  },
  async execute(params, signal?) {
    const command = params.command as string;
    const cwd = params.cwd as string | undefined;
    const timeoutParam = Number(params.timeout);
    const timeoutMs = Number.isFinite(timeoutParam) && timeoutParam > 0
      ? Math.min(timeoutParam, SHELL_MAX_TIMEOUT_MS)
      : SHELL_DEFAULT_TIMEOUT_MS;

    // 高危命令拦截（独立于权限模式，始终生效；检测函数提取供 CLI 预检复用）
    const hit = isHighRiskCommand(command);
    if (hit) {
      return {
        content: `HIGH RISK COMMAND BLOCKED: "${command.slice(0, 100)}" matched security pattern "${hit.source.slice(0, 40)}". This action is blocked regardless of permission mode.`,
        isError: true,
      };
    }

    return new Promise((resolve) => {
      const task: BackgroundTask = {
        id: `bg-${randomUUID().slice(0, 8)}`,
        command,
        startedAt: Date.now(),
        status: 'running',
        exitCode: null,
        chunks: [],
        totalBytes: 0,
      };
      let settled = false;
      let backgrounded = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (content: string, isError: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ content, isError });
      };

      const child = spawn(command, {
        shell: true,
        cwd,
        // POSIX：独立进程组，便于超时后整组 kill 与后台存活；Windows 用 taskkill 兜底
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      task.child = child;

      // 累积输出（丢旧保新，防后台任务无限增长）
      const pushChunk = (chunk: Buffer) => {
        let buf = chunk;
        if (task.totalBytes + buf.length > TASK_OUTPUT_CAP) {
          while (task.chunks.length > 1 && task.totalBytes + buf.length > TASK_OUTPUT_CAP) {
            task.totalBytes -= task.chunks.shift()!.length;
          }
          if (task.totalBytes + buf.length > TASK_OUTPUT_CAP && buf.length > 0) {
            buf = buf.slice(buf.length - (TASK_OUTPUT_CAP - task.totalBytes));
          }
        }
        task.chunks.push(buf);
        task.totalBytes += buf.length;
      };
      child.stdout?.on('data', pushChunk);
      child.stderr?.on('data', pushChunk);

      // 超时 → 转后台继续运行，不杀进程（Claude Code 方案）
      timer = setTimeout(() => {
        backgrounded = true;
        pruneBackgroundTasks();
        backgroundTasks.set(task.id, task);
        const partial = readTaskOutput(task, 4000);
        const notice =
          `Command timed out after ${formatTimeout(timeoutMs)} — still running in the background (id: ${task.id}).\n` +
          `Check its status with shell_status(id), or terminate with shell_kill(id).` +
          (partial ? `\n--- partial output ---\n${partial}` : '');
        finish(notice, false);
      }, timeoutMs);

      // 用户中止：整组终止（前台未超时场景）
      const onAbort = () => {
        if (settled) return;
        killProcessGroup(child);
        finish(`Command aborted: ${command.slice(0, 120)}`, true);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        finish(`Command failed to start: ${err.message}`, true);
      });

      child.on('close', (code, sig) => {
        if (!settled) {
          // 前台正常结束（未超时）
          const output = readTaskOutput(task, MAX_RETURN_CHARS);
          if (code === 0) {
            finish(output || '(no output)', false);
          } else {
            finish(
              `Command exited with code ${code}${sig ? ` (signal ${sig})` : ''}\n${output || `Command failed: ${command.slice(0, 100)}`}`,
              true,
            );
          }
          return;
        }
        // 已转后台：更新任务状态供 shell_status 查询
        if (backgrounded) {
          task.exitCode = code;
          if (task.status !== 'killed') {
            task.status = code === 0 ? 'completed' : 'failed';
          }
        }
      });
    });
  },
});

/** 查询后台命令状态与输出（对齐 Claude Code BashOutput） */
registerTool({
  name: 'shell_status',
  description:
    'Check the status and latest output of a background shell command (created when a shell command timed out). ' +
    'Pass the id returned in the timeout message (e.g. bg-xxxx).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background command id (bg-xxxx)' },
    },
    required: ['id'],
  },
  async execute(params) {
    const task = backgroundTasks.get(String(params.id || ''));
    if (!task) {
      return { content: `Unknown background command id: ${params.id}`, isError: true };
    }
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    const statusLine =
      `[${task.id}] ${task.status}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ''} — ${elapsed}s elapsed — ${task.command}`;
    const output = readTaskOutput(task, MAX_RETURN_CHARS);
    return { content: output ? `${statusLine}\n--- output ---\n${output}` : statusLine };
  },
});

/** 终止后台命令（对齐 Claude Code KillBash） */
registerTool({
  name: 'shell_kill',
  description: 'Terminate a background shell command by its id (bg-xxxx).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background command id (bg-xxxx)' },
    },
    required: ['id'],
  },
  async execute(params) {
    const task = backgroundTasks.get(String(params.id || ''));
    if (!task) {
      return { content: `Unknown background command id: ${params.id}`, isError: true };
    }
    if (task.status === 'running') {
      killProcessGroup(task.child);
      task.status = 'killed';
      task.exitCode = null;
      return { content: `Killed background command ${task.id}` };
    }
    return { content: `Background command ${task.id} is ${task.status}, not running` };
  },
});
