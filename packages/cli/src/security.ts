/**
 * 提交时安全检查 — `shenlan security` 子命令 + pre-commit 钩子管理
 *
 * 与 /security 面板共享逻辑。规则扫描在 core（security-scan.ts），
 * 这里负责 git 集成（暂存内容读取、钩子安装/卸载、已跟踪敏感文件提示）。
 *
 * 暂存扫描只看**本次新增行**：整文件扫描会让历史内容里的测试夹具、
 * `apiKey = 某个变量` 之类普通赋值永久卡住该文件的提交，用户只能改用
 * --no-verify，安全门反而不起作用。`scan --path` 仍为整文件语义。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  scanForSecrets,
  isBlockedPath,
  type SecretMatch,
} from '@shenlan/core';

export const PRE_COMMIT_MARKER = '# shenlan-security-hook';

const HOOK_TEMPLATE = `#!/bin/sh
${PRE_COMMIT_MARKER} — shenlan 提交时安全检查（自动安装，可运行 /security 卸载）
# 只拦截疑似密钥；无 shenlan 环境的机器不阻塞提交。
# 20s 超时保护：旧版 shenlan 无 security 子命令时可能进入 TUI，绝不能挂起提交。
run_scan() {
  if command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift; exec @ARGV' 10 "$@" 2>/dev/null
    code=$?
    if [ "$code" -eq 142 ] || [ "$code" -eq 124 ]; then
      echo "shenlan-security-hook: scan timed out (10s) - skip check" >&2
      return 0
    fi
    return $code
  fi
  "$@"
  return $?
}
if command -v shenlan >/dev/null 2>&1; then
  run_scan shenlan security scan --staged
  exit $?
fi
if command -v shenlan-dev >/dev/null 2>&1; then
  run_scan shenlan-dev security scan --staged
  exit $?
fi
echo "shenlan-security-hook: shenlan not found - skip check (run /security to inspect)" >&2
exit 0
`;

/** 查找 git 仓库根（含 .git 目录），非仓库返回 null */
export function gitRoot(cwd = process.cwd()): string | null {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const root = r.stdout.trim();
  return root || null;
}

export interface HookStatus {
  gitRepo: boolean;
  hookExists: boolean;
  ours: boolean;
  path: string;
}

export function hookStatus(cwd = process.cwd()): HookStatus {
  const root = gitRoot(cwd);
  if (!root) return { gitRepo: false, hookExists: false, ours: false, path: '' };
  const path = join(root, '.git', 'hooks', 'pre-commit');
  if (!existsSync(path)) return { gitRepo: true, hookExists: false, ours: false, path };
  let ours = false;
  try {
    ours = readFileSync(path, 'utf-8').includes(PRE_COMMIT_MARKER);
  } catch { /* 读取失败按非本产品钩子处理 */ }
  return { gitRepo: true, hookExists: true, ours, path };
}

/**
 * 安装 pre-commit 钩子（幂等）：
 *   - 钩子不存在 → 写入模板并 chmod +x
 *   - 钩子存在且带本产品标记 → 覆盖重装（reinstall）
 *   - 钩子存在且无标记 → 不覆盖，返回 reason='existing-hook'
 */
export function installPreCommitHook(
  cwd = process.cwd(),
  opts: { silent?: boolean } = {},
): { installed: boolean; overwritten: boolean; reason?: string; path?: string } {
  const root = gitRoot(cwd);
  if (!root) {
    if (!opts.silent) console.log('  Not a git repository — pre-commit hook skipped.');
    return { installed: false, overwritten: false, reason: 'no-git' };
  }
  const hooksDir = join(root, '.git', 'hooks');
  const path = join(hooksDir, 'pre-commit');
  let existed = false;
  let existedOurs = false;

  if (existsSync(path)) {
    existed = true;
    const content = readFileSync(path, 'utf-8');
    existedOurs = content.includes(PRE_COMMIT_MARKER);
    if (!content.includes(PRE_COMMIT_MARKER)) {
      if (!opts.silent) {
        console.log(`  ⚠ ${path} 已存在非 shenlan 钩子，未覆盖。`);
        console.log('  可在 shenlan 内运行 /security 查看，或手动合并安全检查。');
      }
      return { installed: false, overwritten: false, reason: 'existing-hook', path };
    }
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path, HOOK_TEMPLATE, { encoding: 'utf-8', mode: 0o755 });
  try { chmodSync(path, 0o755); } catch { /* Windows 忽略 chmod */ }
  if (!opts.silent) {
    console.log(`  ✓ shenlan pre-commit hook installed: ${path}`);
  }
  return { installed: true, overwritten: existed && existedOurs, path };
}

/** 卸载钩子：仅移除带本产品标记的文件；其他钩子不动 */
export function uninstallPreCommitHook(
  cwd = process.cwd(),
  opts: { silent?: boolean } = {},
): { removed: boolean; reason?: string; path?: string } {
  const st = hookStatus(cwd);
  if (!st.gitRepo) return { removed: false, reason: 'no-git' };
  if (!st.hookExists) return { removed: false, reason: 'no-hook' };
  if (!st.ours) return { removed: false, reason: 'not-ours', path: st.path };
  try {
    unlinkSync(st.path);
    if (!opts.silent) console.log(`  ✓ shenlan pre-commit hook removed: ${st.path}`);
    return { removed: true, path: st.path };
  } catch (err) {
    return { removed: false, reason: (err as Error).message, path: st.path };
  }
}

/** 已跟踪的敏感文件（.shenlan/config.json / .env*），命中给出 git rm --cached 建议 */
export function trackedSensitiveFiles(cwd = process.cwd()): string[] {
  const root = gitRoot(cwd);
  if (!root) return [];
  const r = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).filter((p) => isBlockedPath(p));
}

/** 格式化扫描命中：文件:行号:规则（掩码） */
export function formatHits(hits: SecretMatch[]): string {
  return hits.map((h) => `${h.file}:${h.line}:${h.rule} (${h.matched})`).join('\n');
}

/** 单次提交新增的行区间（+ 侧行号，闭区间） */
interface LineRange {
  start: number;
  end: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析暂存内容本次新增的行区间（按文件）。
 *
 * 提交时检查只该看「这次带进来的行」：整文件扫描会让历史内容里的测试夹具、
 * `apiKey = 某个变量` 之类普通赋值永久卡住该文件的提交，逼用户改用 --no-verify，
 * 安全门反而失效。解析失败返回 null，调用方回退整文件扫描（不因异常放宽）。
 */
function stagedAddedLines(cwd: string): Map<string, LineRange[]> | null {
  // quotePath=false 保证非 ASCII 路径不被转义，与 --name-status -z 的文件名可比对
  const diff = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '-U0', '--no-color'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (diff.status !== 0) return null;

  const ranges = new Map<string, LineRange[]>();
  let file: string | null = null;
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file && !ranges.has(file)) ranges.set(file, []);
      continue;
    }
    if (!file) continue;
    const m = HUNK_HEADER.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.get(file)!.push({ start, end: start + count - 1 });
  }
  return ranges;
}

/**
 * 只保留本次新增行上的命中。
 * 硬禁止路径不看行号一律拦截；纯重命名/复制本就没有新行；
 * 其余解析不出区间的文件回退整文件扫描（不因解析异常放宽）。
 */
function keepNewLines(
  fileHits: SecretMatch[],
  ctx: { file: string; status: string; ranges?: LineRange[]; parsed: boolean },
): SecretMatch[] {
  if (!ctx.parsed || isBlockedPath(ctx.file)) return fileHits;
  if (!ctx.ranges) return ctx.status === 'R' || ctx.status === 'C' ? [] : fileHits;
  const ranges = ctx.ranges;
  return fileHits.filter((h) => ranges.some((r) => h.line >= r.start && h.line <= r.end));
}

/** 扫描暂存区：只扫本次新增行，跳过删除与二进制 */
export function scanStaged(cwd = process.cwd()): { hits: SecretMatch[]; error?: string } {
  const list = spawnSync('git', ['diff', '--cached', '--name-status', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (list.status !== 0) {
    return { hits: [], error: `git diff --cached failed: ${list.stderr.trim() || list.error?.message || 'unknown'}` };
  }

  const addedLines = stagedAddedLines(cwd);
  const parts = list.stdout.split('\0').filter(Boolean);
  const hits: SecretMatch[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = (parts[i] || '').charAt(0);
    const file = parts[i + 1];
    if (!file || status === 'D') continue; // 删除不扫描
    const show = spawnSync('git', ['show', `:${file}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (show.status !== 0) continue;
    const content = show.stdout;
    // 二进制（含 NUL）跳过
    if (content.includes('\0')) continue;
    hits.push(...keepNewLines(scanForSecrets(content, file), {
      file,
      status,
      ranges: addedLines?.get(file),
      parsed: addedLines !== null,
    }));
  }
  return { hits };
}

/** 扫描单个文件（工作区路径） */
export function scanPath(file: string, cwd = process.cwd()): { hits: SecretMatch[]; error?: string } {
  const abs = join(cwd, file);
  if (!existsSync(abs)) return { hits: [], error: `file not found: ${file}` };
  try {
    const content = readFileSync(abs, 'utf-8');
    if (content.includes('\0')) return { hits: [] };
    return { hits: scanForSecrets(content, file) };
  } catch (err) {
    return { hits: [], error: (err as Error).message };
  }
}

function printUsage(): void {
  console.error('Usage:');
  console.error('  shenlan security status');
  console.error('  shenlan security install');
  console.error('  shenlan security uninstall');
  console.error('  shenlan security scan --staged');
  console.error('  shenlan security scan --path <file>');
}

/** CLI 入口：shenlan security ... */
export async function runSecurityCommand(argv: string[]): Promise<number> {
  const op = argv[0]?.toLowerCase();
  switch (op) {
    case 'status': {
      const st = hookStatus();
      if (!st.gitRepo) {
        console.log('  Not a git repository — pre-commit hook not applicable.');
      } else {
        console.log(`  pre-commit hook: ${st.hookExists ? (st.ours ? '已安装 (shenlan)' : '已存在（非 shenlan）') : '未安装'}`);
        console.log(`  path: ${st.path}`);
      }
      const tracked = trackedSensitiveFiles();
      if (tracked.length > 0) {
        console.log('  ⚠ 仓库已跟踪敏感配置文件（建议 git rm --cached 移除）：');
        for (const f of tracked) console.log(`    ${f}`);
      } else {
        console.log('  tracked sensitive files: none');
      }
      return 0;
    }
    case 'install': {
      const r = installPreCommitHook();
      return r.installed ? 0 : r.reason === 'existing-hook' ? 1 : 0;
    }
    case 'uninstall': {
      const r = uninstallPreCommitHook();
      if (r.removed) return 0;
      if (r.reason === 'not-ours') {
        console.log(`  ⚠ ${r.path} 不是 shenlan 安装的钩子，未删除。`);
        return 1;
      }
      console.log(`  Nothing to uninstall (${r.reason || 'unknown'}).`);
      return 0;
    }
    case 'scan': {
      const rest = argv.slice(1);
      let result: { hits: SecretMatch[]; error?: string };
      if (rest.includes('--staged')) {
        result = scanStaged();
      } else {
        const pi = rest.indexOf('--path');
        const file = pi >= 0 ? rest[pi + 1] : undefined;
        if (!file) {
          printUsage();
          return 2;
        }
        result = scanPath(file);
      }
      if (result.error) {
        console.error(`  security scan: ${result.error}`);
        return 2;
      }
      if (result.hits.length > 0) {
        console.log(formatHits(result.hits));
        console.log('  ⚠ 疑似密钥被拦截 — 请移除后再提交（确认误报可用 git commit --no-verify 绕过）。');
        return 1;
      }
      console.log('  ✓ 未发现疑似密钥');
      return 0;
    }
    default:
      printUsage();
      return 2;
  }
}
