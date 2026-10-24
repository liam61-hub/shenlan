/**
 * 分层规则发现 + 路径条件匹配（C3）
 *
 * 四层，优先级从高到低：
 *   org（SHENLAN_POLICY_DIR 环境变量，opt-in，绝不自动发现）→
 *   user（~/.shenlan/SHENLAN.md + rules/，SHENLAN_CONFIG_DIR 可重定向）→
 *   project（SHENLAN.md + .shenlan/rules/，从 cwd 向上递归到 git root）→
 *   personal（cwd 下的 SHENLAN.local.md，必须被 gitignore）
 *
 * 硬边界（向上递归会走出项目读父目录/兄弟项目文件并送进模型 API，是真实
 * 数据外泄形状，不是理论风险 —— 以下约束第一行代码就要有）：
 *   - 停在 git root（stopAtGitRoot，默认开）
 *   - 向上硬上限 5 层（RULE_MAX_DEPTH）
 *   - 绝不越过 homedir()
 *   - 单文件字节上限 + 每层字符上限
 *   - 注入前过 token 预算（buildRulesSection，与 C1 同机制）
 *
 * paths: 条件规则：frontmatter 声明 paths: 的规则不进 system prompt，
 * 由 repl.ts 的 pre-tool 钩子按本轮触及文件动态匹配注入（matchPathsRule）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { globToRegExp } from './tools/glob.js';
import { expandImports } from './memory-import.js';
import { estimateTokens } from './compression.js';
import { expandHome } from './tools/paths.js';

export type RuleLevel = 'org' | 'user' | 'project' | 'personal';

/** 单条规则文件（content 已展开 @import、剥掉 frontmatter） */
export interface RuleFile {
  /** 绝对路径 */
  path: string;
  level: RuleLevel;
  /** 展示标签（SHENLAN.md / rules/xxx.md / SHENLAN.local.md） */
  label: string;
  content: string;
  /** paths: 条件规则（有值 = 不进 system prompt，按轮匹配注入） */
  paths?: string[];
}

export interface RuleDiscovery {
  /** 按优先级排序（org → user → project 近→远 → personal） */
  rules: RuleFile[];
  /** 被硬边界拒绝的文件（可见，不静默） */
  skipped: { path: string; reason: string }[];
}

/** 向上递归硬上限 */
export const RULE_MAX_DEPTH = 5;
/** 单文件字节上限 */
export const RULE_MAX_FILE_BYTES = 32 * 1024;
/** 每层字符上限（分层子上限） */
export const RULE_LEVEL_MAX_CHARS: Record<RuleLevel, number> = {
  org: 8 * 1024,
  user: 8 * 1024,
  project: 16 * 1024,
  personal: 4 * 1024,
};

export interface DiscoverRuleFilesOptions {
  maxDepth?: number;
  stopAtGitRoot?: boolean;
  maxFileBytes?: number;
}

/** 解析 frontmatter 的 paths: 列表（`paths: a/** b/*.ts` 或 `paths: [a, b]`）；无 frontmatter 返回 undefined */
function parsePaths(raw: string): string[] | undefined {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return undefined;
  const line = fm[1]!.match(/^paths:\s*(.+)$/m);
  if (!line) return undefined;
  const val = line[1]!.trim();
  const items = val.startsWith('[')
    ? val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    : val.split(/[\s,]+/);
  return items.filter(Boolean);
}

/** 读取并解析单个规则文件；越界/读取失败进 skipped 并返回 null */
function parseRuleFile(
  filePath: string,
  level: RuleLevel,
  label: string,
  maxFileBytes: number,
  skipped: RuleDiscovery['skipped'],
): RuleFile | null {
  if (!existsSync(filePath)) return null;
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    skipped.push({ path: filePath, reason: '无法读取文件信息' });
    return null;
  }
  if (size > maxFileBytes) {
    skipped.push({ path: filePath, reason: `文件超限（>${maxFileBytes} 字节）` });
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    skipped.push({ path: filePath, reason: '读取失败' });
    return null;
  }
  const paths = parsePaths(raw);
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (!body) return null; // 空规则文件不算错误，静默跳过
  return {
    path: filePath,
    level,
    label,
    content: expandImports(body, dirname(filePath)).text,
    paths,
  };
}

/** 收集某目录下的 SHENLAN.md + <rulesSubdir>/*.md（文件名排序保证顺序稳定） */
function collectFromDir(
  dir: string,
  rulesSubdir: string,
  level: 'org' | 'user' | 'project',
  rules: RuleFile[],
  skipped: RuleDiscovery['skipped'],
  opts: { maxFileBytes: number; levelChars: Record<RuleLevel, number> },
): void {
  let used = 0;
  const add = (filePath: string, label: string): void => {
    const rule = parseRuleFile(filePath, level, label, opts.maxFileBytes, skipped);
    if (!rule) return;
    if (used + rule.content.length > opts.levelChars[level]) {
      skipped.push({ path: filePath, reason: `层级超限（${level} ≤ ${opts.levelChars[level]} 字符）` });
      return;
    }
    used += rule.content.length;
    rules.push(rule);
  };

  add(join(dir, 'SHENLAN.md'), 'SHENLAN.md');
  const rulesDir = join(dir, rulesSubdir);
  let files: string[] = [];
  try {
    files = existsSync(rulesDir)
      ? readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort()
      : [];
  } catch {
    return; // 目录不可读
  }
  for (const f of files) add(join(rulesDir, f), `rules/${f}`);
}

/** 目录是否为 git root（.git 目录，或 worktree 的 .git 文件） */
function isGitRoot(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * 发现全部规则文件（四层）。
 *
 * project 层从 cwd 向上走：每层收集 SHENLAN.md + .shenlan/rules/*.md，
 * 遇到 git root / homedir / 文件系统根即停，层数 ≤ maxDepth。
 */
export function discoverRuleFiles(
  cwd: string,
  options: DiscoverRuleFilesOptions = {},
): RuleDiscovery {
  const maxDepth = options.maxDepth ?? RULE_MAX_DEPTH;
  const stopAtGitRoot = options.stopAtGitRoot ?? true;
  const maxFileBytes = options.maxFileBytes ?? RULE_MAX_FILE_BYTES;
  const skipped: RuleDiscovery['skipped'] = [];
  const rules: RuleFile[] = [];
  const opts = { maxFileBytes, levelChars: RULE_LEVEL_MAX_CHARS };

  // 1. org —— 只认显式环境变量，绝不自动发现
  const policyDir = process.env.SHENLAN_POLICY_DIR;
  if (policyDir) collectFromDir(policyDir, 'rules', 'org', rules, skipped, opts);

  // 2. user —— ~/.shenlan/（与全局 config.json / 记忆同目录，SHENLAN_CONFIG_DIR 可重定向）
  collectFromDir(
    process.env.SHENLAN_CONFIG_DIR || join(homedir(), '.shenlan'),
    'rules',
    'user',
    rules,
    skipped,
    opts,
  );

  // 3. project —— 从 cwd 向上递归（硬边界见文件头）
  const home = homedir();
  let dir = resolve(cwd);
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (dir === home) break; // 绝不越过 homedir()
    collectFromDir(dir, '.shenlan/rules', 'project', rules, skipped, opts);
    if (stopAtGitRoot && isGitRoot(dir)) break;
    const parent = dirname(dir);
    if (parent === dir) break; // 文件系统根
    dir = parent;
  }

  // 4. personal —— 只认 cwd 下的 SHENLAN.local.md（必须被 gitignore，向上不递归）
  const personal = parseRuleFile(
    join(resolve(cwd), 'SHENLAN.local.md'),
    'personal',
    'SHENLAN.local.md',
    maxFileBytes,
    skipped,
  );
  if (personal) rules.push(personal);

  return { rules, skipped };
}

/**
 * 工具调用触及的路径（相对 cwd 与绝对路径两种形态都参与匹配，与 glob 工具同口径）。
 * 只对带 file_path 的 read/write/edit 生效；shell 命令无法可靠取路径，不参与。
 */
export function touchedPathsOfToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string[] {
  if (!['read', 'write', 'edit'].includes(toolName)) return [];
  const fp = args.file_path;
  if (typeof fp !== 'string' || !fp) return [];
  try {
    const resolved = resolve(cwd, expandHome(fp));
    return [resolved.replace(/\\/g, '/'), relative(cwd, resolved).replace(/\\/g, '/')];
  } catch {
    return [];
  }
}

/**
 * paths 规则匹配：任一 glob 命中任一触及路径即命中。
 * 无通配符的模式按目录前缀匹配（`src/api` 命中 `src/api/foo.ts`），
 * 便于按子树声明规则；含通配符走 glob 工具同一套 globToRegExp。
 */
export function matchPathsRule(globs: string[], touched: string[]): boolean {
  return globs.some((g) => {
    const hasWildcard = /[*?[]/.test(g);
    if (!hasWildcard) {
      const norm = g.replace(/\\/g, '/');
      return touched.some((p) => p === norm || p.startsWith(`${norm}/`));
    }
    const re = globToRegExp(g);
    return touched.some((p) => re.test(p));
  });
}

export interface RulesSection {
  /** 注入 system prompt 的规则段（空串 = 无规则） */
  text: string;
  tokens: number;
  /** 注入的规则文件数 */
  files: number;
  /** 被预算折叠掉的规则文件数 */
  folded: number;
  /** 折叠掉的规则标签（可见，可 read 补看） */
  foldedLabels: string[];
  /** paths: 条件规则条数（不进本段，按轮注入） */
  pathsCount: number;
}

export interface BuildRulesSectionOptions {
  /** token 预算；非正值回落 4096（与记忆段同档） */
  maxTokens?: number;
}

/**
 * 组装规则段并过 token 预算：从低优先级（personal → project 远 → 近 → user → org）
 * 逐条折叠，折叠掉的标签进提示 —— 模型可用 read 工具按需读回。
 */
export function buildRulesSection(
  cwd: string,
  options: BuildRulesSectionOptions = {},
): RulesSection {
  const budget = options.maxTokens && options.maxTokens > 0
    ? Math.floor(options.maxTokens)
    : 4096;
  const { rules } = discoverRuleFiles(cwd);
  const always = rules.filter((r) => !r.paths || r.paths.length === 0);
  const pathsCount = rules.length - always.length;
  if (always.length === 0) {
    return { text: '', tokens: 0, files: 0, folded: 0, foldedLabels: [], pathsCount };
  }

  const assemble = (keptCount: number): string => {
    const kept = always.slice(0, keptCount);
    const folded = always.length - keptCount;
    const lines = ['', '## 规则', ''];
    lines.push(kept.map((r) => `### ${r.label} (${r.level})\n${r.content}`).join('\n\n'));
    lines.push('');
    if (folded > 0) {
      const labels = always.slice(keptCount).map((r) => r.label);
      lines.push(`...(还有 ${folded} 条规则已折叠：${labels.join('、')}，可用 read 查看)`);
      lines.push('');
    }
    return lines.join('\n');
  };

  let keptCount = always.length;
  let text = assemble(keptCount);
  while (keptCount > 0 && estimateTokens(text) > budget) {
    keptCount--;
    text = assemble(keptCount);
  }

  return {
    text,
    tokens: estimateTokens(text),
    files: keptCount,
    folded: always.length - keptCount,
    foldedLabels: always.slice(keptCount).map((r) => r.label),
    pathsCount,
  };
}
