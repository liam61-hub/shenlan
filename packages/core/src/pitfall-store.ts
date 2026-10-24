/**
 * 坑记忆结构化核心（§14 坑防复发）— 解析 / 双层合并 / 检索 / hits 递增
 *
 * 文件格式：`---` 分隔块，字段行 `severity: hard|soft`、`hits: N`、
 * `trigger: ...`、`symptom: ...`、`rule: ...`（均可缺省，回退默认）。
 * 全局（configDir/pitfalls.md）+ 项目（.shenlan/pitfalls.md）双层，同名以项目覆盖。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { configDir } from './platform.js';

export interface PitfallEntry {
  title: string;
  severity: 'hard' | 'soft';
  hits: number;
  /** 匹配关键词（逗号分隔的路径/命令/技术栈） */
  trigger: string;
  symptom: string;
  /** hard 坑的硬约束规则描述 */
  rule: string;
  source: 'global' | 'project';
  /** 原始块正文（含字段行） */
  body: string;
}

/** 全局坑路径：~/.config/shenlan/pitfalls.md（Windows %APPDATA%\shenlan\pitfalls.md） */
export function globalPitfallPath(): string {
  return join(configDir(), 'pitfalls.md');
}

function fieldOf(text: string, name: string): string {
  const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return m ? m[1]!.trim() : '';
}

/**
 * 解析单个坑条目块：字段缺失回退默认（severity soft / hits 0 / trigger 取正文首 80 字符）。
 * 兼容自由格式旧条目（无任何字段行）。
 */
export function parsePitfallEntry(text: string, source: 'global' | 'project', index: number): PitfallEntry {
  const trimmed = text.trim();
  const titleMatch = trimmed.match(/^#\s+(.+)$/m);
  const title = (titleMatch ? titleMatch[1]!.trim() : `entry-${index + 1}`).slice(0, 120);
  const severityRaw = fieldOf(trimmed, 'severity').toLowerCase();
  const severity: 'hard' | 'soft' = severityRaw === 'hard' ? 'hard' : 'soft';
  const hitsRaw = fieldOf(trimmed, 'hits');
  const hits = /^\d+$/.test(hitsRaw) ? Number(hitsRaw) : 0;
  const trigger = fieldOf(trimmed, 'trigger')
    || trimmed.split('\n').slice(1).join(' ').slice(0, 80);
  const symptom = fieldOf(trimmed, 'symptom');
  const rule = fieldOf(trimmed, 'rule');
  return { title, severity, hits, trigger, symptom, rule, source, body: trimmed };
}

function readEntries(filePath: string, source: 'global' | 'project'): PitfallEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content
      .split(/^---$/m)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t, i) => parsePitfallEntry(t, source, i));
  } catch {
    return [];
  }
}

/**
 * 加载全部坑条目：全局 + 项目双层，同名以项目覆盖；
 * 排序：hard 在前，同 severity 按 hits 降序。
 */
export function loadPitfalls(cwd: string): PitfallEntry[] {
  const project = readEntries(join(cwd, '.shenlan', 'pitfalls.md'), 'project');
  const global = readEntries(globalPitfallPath(), 'global');
  const merged = new Map<string, PitfallEntry>();
  for (const e of global) merged.set(e.title, e);
  for (const e of project) merged.set(e.title, e); // 项目覆盖全局
  return [...merged.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'hard' ? -1 : 1;
    return b.hits - a.hits;
  });
}

/** 按 trigger/symptom 子串检索（空条件 = 不过滤） */
export function searchPitfalls(
  entries: PitfallEntry[],
  q: { trigger?: string; symptom?: string },
): PitfallEntry[] {
  const trigger = (q.trigger ?? '').toLowerCase();
  const symptom = (q.symptom ?? '').toLowerCase();
  return entries.filter((e) => {
    const text = `${e.trigger} ${e.symptom} ${e.body}`.toLowerCase();
    const okTrigger = !trigger || text.includes(trigger);
    const okSymptom = !symptom || text.includes(symptom);
    return okTrigger && okSymptom;
  });
}

/**
 * 更新坑文件中指定条目的 hits 字段（+1），返回新值；条目不存在返回 -1。
 * 仅替换该条目块内的 hits 行（保留其余内容原样）；无 hits 行时补插。
 */
export function incrementPitfallHits(filePath: string, title: string): number {
  if (!existsSync(filePath)) return -1;
  const content = readFileSync(filePath, 'utf-8');
  const blocks = content.split(/^---$/m);
  let changed = false;
  let newHits = -1;
  const next = blocks.map((block) => {
    if (changed) return block;
    const isTarget = block.includes(`# ${title}`) || block.startsWith(`#${title}`)
      || new RegExp(`^#\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(block);
    if (!isTarget) return block;
    changed = true;
    const hitsMatch = block.match(/^hits:\s*(\d+)\s*$/im);
    if (hitsMatch) {
      newHits = Number(hitsMatch[1]) + 1;
      return block.replace(/^hits:\s*\d+\s*$/im, `hits: ${newHits}`);
    }
    newHits = 1;
    return block.replace(/(^#\s+.+$)/m, `$1\nhits: 1`);
  });
  if (!changed) return -1;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, next.join('---'), 'utf-8');
  return newHits;
}
