/**
 * 本地记忆 — 全局 + 项目级 Markdown 记忆文件
 *
 * 记忆文件格式（per-file）：
 *   ---
 *   name: <kebab-slug>
 *   description: <one-line-summary>
 *   ---
 *   <content>
 *
 * 索引文件 MEMORY.md 每行一个条目：- [Title](file.md) — hook
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { estimateTokens } from './compression.js';
import { expandImports } from './memory-import.js';

/** 记忆条目 */
export interface MemoryEntry {
  name: string;
  file: string;
  description: string;
  content: string;
  /** 来源作用域（预算折叠时全局先于项目被丢弃） */
  scope?: 'project' | 'global';
}

/** 索引行 + 来源作用域（预算折叠需要知道谁可以先丢） */
export interface MemoryIndexLine {
  text: string;
  scope: 'project' | 'global';
}

/** 合并去重后的记忆索引（MEMORY.md） */
export interface MemoryIndex {
  /** 合并去重后的索引文本（空串 = 无条目；有 MEMORY.md 但为空时也为空串） */
  text: string;
  /** 逐行 + 作用域（与 text 同序，text 是它按 200 行/25KB 截断后的 join） */
  lines: MemoryIndexLine[];
  /** 全局或项目目录是否存在 MEMORY.md（用于区分「有索引但空」与「无索引」） */
  hasIndex: boolean;
  /** 全局记忆目录（~/.shenlan/memory/，SHENLAN_CONFIG_DIR 可重定向） */
  globalDir: string;
  /** 项目记忆目录（<cwd>/.shenlan/memory/） */
  projectDir: string;
}

/** 索引注入上限：前 200 行 / 25KB，先到者为准（对齐 Claude Code） */
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25 * 1024;

/** 全局记忆目录（SHENLAN_CONFIG_DIR 重定向时跟随，供测试隔离） */
export function globalMemoryDir(): string {
  return join(process.env.SHENLAN_CONFIG_DIR || join(homedir(), '.shenlan'), 'memory');
}

/** 项目记忆目录 */
export function projectMemoryDir(projectDir?: string): string {
  return join(projectDir || process.cwd(), '.shenlan', 'memory');
}

/**
 * 解析单个 .md 记忆文件
 */
function parseMemoryFile(filePath: string): MemoryEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\nname:\s*(.+)\ndescription:\s*(.+)\n---\n(.*)/s);
    if (!match) return null;

    return {
      name: match[1].trim(),
      file: basename(filePath),
      description: match[2].trim(),
      // @import 展开发生在 token 预算之前（buildMemorySection 估算的是展开后的量）
      content: expandImports(match[3].trim(), dirname(filePath)).text,
    };
  } catch {
    return null;
  }
}

/**
 * 加载记忆目录下的所有记忆
 */
function loadMemoryDir(dir: string, scope: 'project' | 'global'): MemoryEntry[] {
  if (!existsSync(dir)) return [];

  const entries: MemoryEntry[] = [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of files) {
      const entry = parseMemoryFile(join(dir, file));
      if (entry) entries.push({ ...entry, scope });
    }
  } catch {
    // ignore
  }
  return entries;
}

/**
 * 加载所有记忆（全局 + 项目级）
 */
export function loadMemories(projectDir?: string): MemoryEntry[] {
  const globalDir = globalMemoryDir();
  const projectMemDir = projectMemoryDir(projectDir);

  const globalMemories = loadMemoryDir(globalDir, 'global');
  const projectMemories = loadMemoryDir(projectMemDir, 'project');

  // 项目级记忆可能覆盖全局（同名以项目为准）
  const seen = new Set(projectMemories.map((m) => m.name));
  const merged = [...projectMemories];
  for (const m of globalMemories) {
    if (!seen.has(m.name)) {
      merged.push(m);
    }
  }

  return merged;
}

/**
 * 解析索引行：- [name](file.md) — description
 * 返回 null 表示不是标准索引条目（如用户手写的标题/说明），原样保留。
 */
function parseIndexLine(line: string): { name: string; file: string; description: string } | null {
  const m = line.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*[—–-]\s*(.*))?$/);
  if (!m) return null;
  return {
    name: m[1].trim(),
    file: m[2].trim(),
    description: (m[3] || '').trim(),
  };
}

/** 原子写文本文件：先写临时文件再 rename，避免写一半崩溃留下残缺索引 */
function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

/**
 * 读取单个 MEMORY.md 的非空行；文件不存在或读取失败返回 null。
 */
function readIndexLines(filePath: string): string[] | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * 加载记忆索引：合并全局 + 项目 MEMORY.md（项目同名条目优先），
 * 按 name 去重后截断到前 200 行 / 25KB（先到者）。
 * 悬空索引行（主题文件被外部删除）不主动清理。
 */
export function loadMemoryIndex(projectDir?: string): MemoryIndex {
  const globalDir = globalMemoryDir();
  const projectMemDir = projectMemoryDir(projectDir);
  const globalIndexPath = join(globalDir, 'MEMORY.md');
  const projectIndexPath = join(projectMemDir, 'MEMORY.md');

  const hasIndex = existsSync(globalIndexPath) || existsSync(projectIndexPath);
  const globalLines = readIndexLines(globalIndexPath) ?? [];
  const projectLines = readIndexLines(projectIndexPath) ?? [];

  // 项目优先：先按项目行建 map，再补全局行（同名跳过）
  const map = new Map<string, MemoryIndexLine>();
  for (const line of projectLines) {
    const key = parseIndexLine(line)?.name || line;
    if (!map.has(key)) map.set(key, { text: line, scope: 'project' });
  }
  for (const line of globalLines) {
    const key = parseIndexLine(line)?.name || line;
    if (!map.has(key)) map.set(key, { text: line, scope: 'global' });
  }

  let lines = Array.from(map.values());
  if (lines.length > INDEX_MAX_LINES) lines = lines.slice(0, INDEX_MAX_LINES);

  let text = lines.map((l) => l.text).join('\n');
  if (Buffer.byteLength(text, 'utf-8') > INDEX_MAX_BYTES) {
    // 按行边界截断到 25KB，避免输出半行
    let acc = '';
    let kept = 0;
    for (const line of lines) {
      const next = acc ? `${acc}\n${line.text}` : line.text;
      if (Buffer.byteLength(next, 'utf-8') > INDEX_MAX_BYTES) break;
      acc = next;
      kept++;
    }
    text = acc;
    // lines 与 text 必须同序同内容（buildMemorySection 依赖 lines 做预算折叠，
    // 若这里只截 text 会让两者失同步、预算按未截断的行数算）
    lines = lines.slice(0, kept);
  }

  return { text, lines, hasIndex, globalDir, projectDir: projectMemDir };
}

/**
 * 更新某作用域记忆目录的 MEMORY.md 索引：
 * 同名条目原位更新行，否则在末尾追加 `- [name](name.md) — description`。
 */
export function updateMemoryIndex(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, 'MEMORY.md');
  const lines = readIndexLines(indexPath) ?? [];
  const newLine = `- [${name}](${name}.md) — ${description}`;

  const out: string[] = [];
  let updated = false;
  for (const line of lines) {
    const parsed = parseIndexLine(line);
    if (parsed && parsed.name === name) {
      out.push(newLine);
      updated = true;
    } else {
      out.push(line);
    }
  }
  if (!updated) out.push(newLine);

  writeFileAtomic(indexPath, `${out.join('\n')}\n`);
}

/**
 * 从某作用域记忆目录的 MEMORY.md 索引删除条目并清理空行；
 * 索引清空后删除 MEMORY.md 文件本身。
 */
export function removeMemoryIndex(dir: string, name: string): void {
  const indexPath = join(dir, 'MEMORY.md');
  if (!existsSync(indexPath)) return;
  const lines = readIndexLines(indexPath) ?? [];
  const out = lines.filter((line) => {
    const parsed = parseIndexLine(line);
    return !(parsed && parsed.name === name);
  });

  if (out.length === 0) {
    try {
      unlinkSync(indexPath);
    } catch { /* 文件可能已不存在 */ }
  } else {
    writeFileAtomic(indexPath, `${out.join('\n')}\n`);
  }
}

/** 索引尾部的用法提示（injectMemoryIndex 与 buildMemorySection 共用） */
function memoryHint(index: MemoryIndex, autoSave?: boolean): string {
  // 写入纪律刻意压到一句：这段文字进每一个请求，长了就是持续成本
  const saveHint = autoSave === false
    ? ''
    : ' 新记忆可用 memory_save 工具保存；纪律：任务自然边界再存，已有主题用 mode="append" 追加而不是另建近似条目，绝不存密钥/token，不存临时任务状态。';
  return `索引为记忆主题列表，详细内容可用 read 工具读取主题文件（项目记忆：${index.projectDir}；全局记忆：${index.globalDir}）。${saveHint}`;
}

/**
 * 将记忆索引注入 system prompt（Claude Code 风格：只注入索引列表，
 * 详细主题文件由模型用 read 工具按需读取）。
 */
export function injectMemoryIndex(
  index: MemoryIndex,
  options: { autoSave?: boolean } = {},
): string {
  const lines: string[] = ['', '## 记忆', ''];
  if (index.text) {
    lines.push(index.text);
    lines.push('');
  }
  lines.push(memoryHint(index, options.autoSave));
  return lines.join('\n');
}

/**
 * 将记忆注入 system prompt
 */
export function injectMemories(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  const lines: string[] = ['', '## 记忆', ''];
  for (const mem of memories) {
    lines.push(`### ${mem.name}`);
    lines.push(mem.content);
    lines.push('');
  }
  return lines.join('\n');
}

/** 记忆段 token 预算默认值（与 DEFAULT_CONFIG.context.maxMemoryTokens 一致） */
export const DEFAULT_MEMORY_TOKEN_BUDGET = 4096;

/**
 * 记忆段的稳定分隔符 —— system prompt 里定位记忆块用。
 *
 * system prompt 每会话只构建一次（repl.ts 用 system 消息是否存在做守卫），
 * 所以模型自己 memory_save 写下的记忆本会话内看不见。有了这对标记，
 * refreshMemorySection 就能只替换这一块、其余部分逐字节不变（对 provider
 * prompt 缓存很重要）。HTML 注释形式：模型会忽略，人读日志也不碍事。
 */
export const MEMORY_BLOCK_START = '<!-- shenlan:memory:start -->';
export const MEMORY_BLOCK_END = '<!-- shenlan:memory:end -->';

/** 记忆段构建结果（system prompt 注入 + /context 展示共用） */
export interface MemorySection {
  /** 记忆段文本（空串 = 无记忆可注入） */
  text: string;
  /** 估算 token 数（estimateTokens 口径：约 4 字符 ≈ 1 token） */
  tokens: number;
  /** 实际生效的预算 */
  budget: number;
  /** 是否因预算折叠过内容 */
  truncated: boolean;
  /** 实际注入的条目数 */
  entryCount: number;
  /** 因预算被折叠掉的条目数 */
  foldedCount: number;
  /** 索引模式（存在 MEMORY.md）还是全量模式 */
  mode: 'index' | 'full';
}

export interface BuildMemorySectionOptions {
  /** token 预算；非正值视为未配置，回落 DEFAULT_MEMORY_TOKEN_BUDGET */
  maxTokens?: number;
  /** false 时不提示 memory_save（memory.autoSave 关闭） */
  autoSave?: boolean;
  /** 预加载的记忆（全量模式用；省略则从磁盘读） */
  memories?: MemoryEntry[];
}

/**
 * 构建带 token 预算的记忆段。
 *
 * 模式选择与旧的 injectMemoryIndex / injectMemories 一致：存在 MEMORY.md 走索引模式，
 * 否则全量注入正文。超预算时按优先级折叠 —— **全局条目先于项目条目被丢弃**
 * （与 loadMemoryIndex / loadMemories 的「项目优先」同口径，两个加载器都已把项目条目
 * 排在前面，所以折叠 = 从尾部丢）—— 并在末尾追加折叠提示，让模型知道内容被扣留、
 * 可用 /memory 查看，而不是误以为看全了。
 *
 * 索引模式的 200 行 / 25KB 上限保留作外层兜底（在 loadMemoryIndex 里）。
 */
export function buildMemorySection(
  projectDir?: string,
  options: BuildMemorySectionOptions = {},
): MemorySection {
  const budget = options.maxTokens && options.maxTokens > 0
    ? Math.floor(options.maxTokens)
    : DEFAULT_MEMORY_TOKEN_BUDGET;

  const index = loadMemoryIndex(projectDir);
  const mode: 'index' | 'full' = index.hasIndex ? 'index' : 'full';

  // 每个 block 是一个可整体保留/丢弃的条目（索引模式一行，全量模式一节）；
  // 顺序即优先级（项目在前），折叠从尾部开始
  let blocks: string[];
  let footer: string;
  if (mode === 'index') {
    blocks = index.lines.map((l) => l.text);
    footer = memoryHint(index, options.autoSave);
  } else {
    const memories = options.memories ?? loadMemories(projectDir);
    blocks = memories.map((m) => `### ${m.name}\n${m.content}`);
    footer = '';
  }

  const total = blocks.length;
  // 全量模式无条目时与 injectMemories 一致返回空串；索引模式即使没有条目也要保留
  // 提示（告诉模型记忆目录在哪、可以怎么写），与 injectMemoryIndex 行为一致
  if (mode === 'full' && total === 0) {
    return { text: '', tokens: 0, budget, truncated: false, entryCount: 0, foldedCount: 0, mode };
  }

  const assemble = (keptCount: number): string => {
    // START 标记独占首行、END 独占末行：refreshMemorySection 靠它们定位替换区间，
    // 且不吞掉前后的换行（保证「内容未变 → prompt 逐字节不变」）
    const lines: string[] = [MEMORY_BLOCK_START, '', '## 记忆', ''];
    const kept = blocks.slice(0, keptCount);
    if (kept.length > 0) {
      // 索引模式一行一条紧排；全量模式条目之间空一行（与 injectMemories 逐字节一致）
      lines.push(kept.join(mode === 'index' ? '\n' : '\n\n'));
      lines.push('');
    }
    const folded = total - keptCount;
    if (folded > 0) {
      lines.push(`...(还有 ${folded} 条记忆已折叠，/memory 查看)`);
      lines.push('');
    }
    if (footer) lines.push(footer);
    lines.push(MEMORY_BLOCK_END);
    return lines.join('\n');
  };

  // 从全量开始逐条丢弃末尾条目直到进预算；keptCount 到 0 仍超预算时
  // 就只剩固定开销（标题 + 折叠提示 + footer），不再有可丢的东西
  let keptCount = total;
  let text = assemble(keptCount);
  while (keptCount > 0 && estimateTokens(text) > budget) {
    keptCount--;
    text = assemble(keptCount);
  }

  return {
    text,
    tokens: estimateTokens(text),
    budget,
    truncated: keptCount < total,
    entryCount: keptCount,
    foldedCount: total - keptCount,
    mode,
  };
}
