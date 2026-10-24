/**
 * /pitfall 命令共享逻辑 — 结构化列表 / add / CLAUDE.md·AGENTS.md 导入
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPitfalls, parsePitfallEntry, expandHome } from '@shenlan/core';

function projectPitfallPath(cwd: string): string {
  return join(cwd, '.shenlan', 'pitfalls.md');
}

/** 结构化列表：`# title [hard|soft] hits=N (source) — 首行正文` */
export function pitfallReport(cwd: string): string {
  const entries = loadPitfalls(cwd);
  if (entries.length === 0) return '  None';
  return entries.map((e) => {
    const tag = e.severity === 'hard' ? 'hard' : 'soft';
    const firstBody = e.body.split('\n').filter(l => !l.startsWith('#') && !/^(severity|hits|trigger|symptom|rule):/i.test(l)).find(l => l.trim()) || '';
    return `  # ${e.title} [${tag}] hits=${e.hits} (${e.source}) — ${firstBody.slice(0, 60)}`;
  }).join('\n');
}

/**
 * 追加/更新坑条目（默认 soft；同标题更新为覆盖语义——保留一个条目）。
 * 返回操作后的条目标题。
 */
export function pitfallAdd(cwd: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const file = projectPitfallPath(cwd);
  mkdirSync(join(cwd, '.shenlan'), { recursive: true });
  const entry = parsePitfallEntry(trimmed, 'project', 0);

  let content = '';
  if (existsSync(file)) {
    content = readFileSync(file, 'utf-8');
  }
  // 同标题更新：替换该条目块（保持位置）；否则追加
  const titleMark = `# ${entry.title}`;
  if (content.includes(titleMark)) {
    const blocks = content.split(/^---$/m);
    const next = blocks.map((b) => {
      const isTarget = b.includes(titleMark)
        || new RegExp(`^#\\s*${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(b);
      return isTarget ? `\n${trimmed}\n` : b;
    });
    content = next.join('---');
  } else {
    content = content.replace(/\s*$/, '');
    content += (content ? '\n\n---\n\n' : '') + trimmed + '\n';
  }
  writeFileSync(file, content, 'utf-8');
  return entry.title;
}

/** 坑类标题段落匹配：`## 坑与陷阱` / `### Pitfalls` / `## 注意` 等 */
const PITFALL_HEADING = /^#{1,3}\s+.*(坑|陷阱|pitfall|注意|教训)/i;

/**
 * 从 CLAUDE.md / AGENTS.md（含全局 ~/.claude/CLAUDE.md）导入坑类标题段落为
 * 项目坑条目（soft、body 保留原文、重复标题跳过）。返回导入/跳过计数。
 */
export function importPitfallsFromAgentDocs(cwd: string): { imported: number; skipped: number } {
  const candidates: Array<{ path: string }> = [
    { path: join(cwd, 'CLAUDE.md') },
    { path: join(cwd, 'AGENTS.md') },
    { path: expandHome('~/.claude/CLAUDE.md') },
  ];
  const existing = new Set(loadPitfalls(cwd).map(e => e.title));
  let imported = 0;
  let skipped = 0;

  for (const { path } of candidates) {
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch { continue; }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!PITFALL_HEADING.test(line)) continue;
      const title = line.replace(/^#+\s*/, '').trim().slice(0, 120);
      // 段落：标题行到下一个标题行之间的非空行
      const bodyLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (/^#{1,3}\s+/.test(next)) break;
        bodyLines.push(next);
      }
      const body = bodyLines.join('\n').trim();
      if (!body) continue;
      if (existing.has(title)) {
        skipped++;
        continue;
      }
      pitfallAdd(cwd, `# ${title}\n${body}`);
      existing.add(title);
      imported++;
    }
  }
  return { imported, skipped };
}
