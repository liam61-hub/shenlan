/**
 * 安全模块 — 路径限制 + 敏感信息脱敏
 */
import { resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import type { ShenlanConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';
import { expandHome } from './tools/paths.js';

/** 安全配置注入（CLI 启动时与 setAgentConfig 同点调用；未注入回退 DEFAULT_CONFIG） */
let safetyConfig: ShenlanConfig | null = null;

/** 设置动作安全网依赖的配置（传 null 清除注入） */
export function setSafetyConfig(config: ShenlanConfig | null): void {
  safetyConfig = config;
}

/** 简易 glob 转正则：** → 任意段、* → 段内任意、? → 单字符 */
function globToRegex(pattern: string): RegExp {
  const src = pattern
    .split('/').map(seg => seg
      .replace(/\*\*/g, '')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(//g, '.*'),
    ).join('/');
  return new RegExp(`(^|/)${src}($|/)`);
}

/** Resolve a missing destination through its closest existing ancestor. */
function realPathWithExistingAncestor(filePath: string): string {
  let current = resolve(filePath);
  const missingSegments: string[] = [];

  while (true) {
    let exists = false;
    try {
      lstatSync(current);
      exists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      missingSegments.unshift(basename(current));
      current = parent;
    }
    if (exists) return resolve(realpathSync(current), ...missingSegments);
  }
}

function isWithinPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 保护路径拦截（write/edit 前置）：命中 actionSafety.protectedPaths 返回 blocked。
 * 路径经 expandHome + resolve 规范化，存在时用 realpath；glob 模式 + 字面子串双匹配。
 */
export function isProtectedPath(filePath: string): { blocked: boolean; pattern?: string } {
  const config = safetyConfig ?? DEFAULT_CONFIG;
  const patterns = config.actionSafety?.protectedPaths ?? [];
  if (patterns.length === 0) return { blocked: false };

  let real: string;
  try {
    real = realPathWithExistingAncestor(expandHome(filePath));
  } catch {
    // If the destination cannot be canonicalized, fail closed when protection is configured.
    return { blocked: true, pattern: patterns[0] };
  }
  // 统一正斜杠，跨平台可比较
  const normalized = real.replace(/\\/g, '/');

  for (const pattern of patterns) {
    const expanded = expandHome(pattern).replace(/\\/g, '/');
    // glob 匹配（含路径结构）或字面子串匹配（如 '.git' 片段）
    if (globToRegex(expanded).test(normalized) || normalized.includes(expanded.replace(/^\.\//, ''))) {
      return { blocked: true, pattern };
    }
  }
  return { blocked: false };
}

/** 获取项目根 */
function getProjectRoot(): string {
  return resolve(process.cwd());
}

/** 项目根的 realpath 规范化形式（异常时回落字面路径） */
function realProjectRoot(): string {
  const root = getProjectRoot();
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** 检查路径安全性（防 symlink 逃逸） */
export function isPathSafe(filePath: string): { safe: boolean; reason?: string } {
  const resolved = resolve(filePath);

  // symlink 逃逸检测：仅对 cwd 内的路径检查（外部路径由用户显式传入，不拦截）
  const root = getProjectRoot();
  const isWithinProject = isWithinPath(root, resolved);

  if (isWithinProject) {
    try {
      const real = realPathWithExistingAncestor(resolved);
      // Normalize the root too (for example, macOS /var → /private/var).
      const canonicalRoot = realProjectRoot();
      if (!isWithinPath(canonicalRoot, real)) {
        return { safe: false, reason: `Symlink escape detected: "${filePath}" → "${real}"` };
      }
    } catch (err) {
      return { safe: false, reason: `Unable to resolve path safely: "${filePath}" (${(err as Error).message})` };
    }
  }

  return { safe: true };
}

/** 敏感信息脱敏 */
export function maskSensitive(text: string): string {
  return text
    // API keys
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, '***API_KEY***')
    // Bearer tokens
    .replace(/\b(Bearer\s+)[a-zA-Z0-9._\-]{20,}\b/gi, '$1***TOKEN***')
    // Passwords in connection strings
    .replace(/(password|passwd|pwd)=[^\s;&]+/gi, '$1=***')
    // AWS-style keys
    .replace(/\b(AKIA[A-Z0-9]{16})\b/g, '***AWS_KEY***')
    // Generic long random strings that look like secrets
    .replace(/\b[a-f0-9]{40,}\b/gi, '***HASH***');
}
