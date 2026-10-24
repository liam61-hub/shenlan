/**
 * 文件名模式搜索工具（glob）
 *
 * 防挂起/防 OOM 设计（2026-08-13 线上事故修复）：
 *  - 异步扫描 + 每 256 条让出事件循环（setImmediate），大目录不再冻结 UI/超时/中断
 *  - 扫描条目数上限（MAX_SCAN_ENTRIES）与目录深度上限（MAX_SCAN_DEPTH）
 *  - 匹配数达到上限即提前停止，不再全量收集
 *  - 不跟随符号链接（防循环 + 防扫出工作区）
 *  - 相对路径与绝对路径都参与匹配（修复绝对路径模式永远 no matches）
 */
import { registerTool } from './index.js';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expandHome } from './paths.js';

/** 单次扫描条目上限（防全盘扫描冻结/爆内存） */
const MAX_SCAN_ENTRIES = 100_000;
/** 最大目录深度 */
const MAX_SCAN_DEPTH = 24;
/** 最大返回匹配数（与历史 slice 上限一致） */
const MAX_MATCHES = 200;

/** 占位符：路径中不可能出现的字符序列 */
const GLOBSTAR = '\u0000GLOBSTAR\u0000';

/** glob → 正则：** 支持零级或多级目录（顶层文件也能被星号星号加斜杠的模式命中） */
export function globToRegExp(pattern: string): RegExp {
  let s = pattern
    .replace(/\\/g, '/')
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*');
  s = s.replace(new RegExp('/' + GLOBSTAR + '/', 'g'), '/(?:.*/)?');
  s = s.replace(new RegExp('/' + GLOBSTAR + '$'), '(?:/.*)?');
  s = s.replace(new RegExp('^' + GLOBSTAR + '/'), '(?:.*/)?');
  s = s.replace(new RegExp(GLOBSTAR, 'g'), '.*');
  return new RegExp('^' + s + '$', 'i');
}

/** 简易 glob 匹配（支持 ** 和 *；相对路径与绝对路径任一命中即可） */
function matchGlob(pattern: string, relPath: string, absPath: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(relPath) || re.test(absPath.replace(/\\/g, '/'));
}

/**
 * 绝对路径模式的静态前缀目录：模式 "/a/b/星号星号/x" → "/a/b"；"C:/a/星号星号/x" → "C:/a"。
 * 未显式传 path 时用它作为搜索目录，避免绝对模式在 cwd 里永远 no matches。
 */
function staticDirOf(pattern: string): string | undefined {
  // Windows 绝对路径是反斜杠，先归一化为 /，否则 lastIndexOf('/') 永远找不到
  const norm = pattern.replace(/\\/g, '/');
  let globIdx = -1;
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*' || c === '?' || c === '[') {
      globIdx = i;
      break;
    }
  }
  if (globIdx === -1) return undefined;
  const before = norm.slice(0, globIdx);
  const lastSlash = before.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  const dir = before.slice(0, lastSlash);
  // 绝对路径：POSIX `/` 开头，或 Windows 盘符 `C:/`
  return /^[A-Za-z]:\//.test(dir) || dir.startsWith('/') ? dir : undefined;
}

interface ScanState {
  pattern: string;
  matches: string[];
  /** 已扫描条目数（文件 + 目录） */
  entries: number;
  /** 达到上限（条目数 / 匹配数 / 中断）后停止 */
  truncated: boolean;
  signal?: AbortSignal;
}

/** 异步递归扫描：不跟随符号链接，深度/条目有上限，周期性让出事件循环 */
async function scanDir(dir: string, base: string, depth: number, state: ScanState): Promise<void> {
  if (state.truncated || depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 不可读目录跳过
  }
  for (const entry of entries) {
    if (state.truncated) return;
    if (state.signal?.aborted) {
      state.truncated = true;
      return;
    }
    if (++state.entries > MAX_SCAN_ENTRIES) {
      state.truncated = true;
      return;
    }
    // 每 256 条让出事件循环：大目录扫描时 UI / 超时 / 中断保持响应
    if (state.entries % 256 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await scanDir(full, base, depth + 1, state);
      }
    } else if (entry.isFile()) {
      const rel = relative(base, full).replace(/\\/g, '/');
      if (matchGlob(state.pattern, rel, full)) {
        state.matches.push(rel);
        if (state.matches.length >= MAX_MATCHES) {
          state.truncated = true;
          return;
        }
      }
    }
    // 符号链接（目录/文件）一律不跟随：Dirent.isDirectory/isFile 对链接为 false
  }
}

registerTool({
  name: 'glob',
  description:
    'Find files matching a glob pattern. Supports ** for recursive matching. ' +
    'Returns sorted file paths relative to search directory. ' +
    'Scan is bounded (100k entries / depth 24) and ignores symlinks and node_modules.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.ts", "*.json", or an absolute path pattern',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (default: current directory)',
      },
    },
    required: ['pattern'],
  },
  async execute(params, signal?) {
    const pattern = params.pattern as string;
    const explicitPath = params.path as string | undefined;
    const searchPath = explicitPath
      ? resolve(expandHome(explicitPath))
      : resolve(expandHome(staticDirOf(pattern) || process.cwd()));

    const state: ScanState = { pattern, matches: [], entries: 0, truncated: false, signal };
    await scanDir(searchPath, searchPath, 0, state);

    if (signal?.aborted) {
      return { content: 'Glob aborted', isError: true };
    }

    state.matches.sort();
    if (state.matches.length === 0) {
      const note = state.truncated
        ? ` (scan limit reached after ${MAX_SCAN_ENTRIES} entries)`
        : '';
      return { content: `No files matched pattern "${pattern}"${note}` };
    }

    const truncated = state.truncated && state.matches.length >= MAX_MATCHES;
    const head = truncated
      ? `${state.matches.length} file(s) matched (truncated):\n`
      : `${state.matches.length} file(s) matched:\n`;
    return {
      content: head + state.matches.map((f) => `  ${f}`).join('\n'),
    };
  },
});
