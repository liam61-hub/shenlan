/**
 * Skill 子系统 — SKILL.md 扫描/索引/按需加载
 *
 * 格式兼容 Claude Code / Codex SKILL.md (frontmatter + markdown body)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { configDir } from './platform.js';
import { expandHome } from './tools/paths.js';

export interface SkillEntry {
  name: string;
  description: string;
  path: string;       // SKILL.md 文件路径
  dir: string;        // skill 目录
  source: 'builtin' | 'global' | 'project';
}

/**
 * 计算 skill 扫描目录：
 * - global：内置目录 + config.skills 自定义目录 + 平台全局目录（macOS ~/.config/shenlan/skills，Windows %APPDATA%/shenlan/skills）
 * - project：<cwd>/.shenlan/skills
 * config.skills 中的 `~` 按主目录展开；相对路径按 cwd 解析；绝对路径原样使用。
 */
export function buildSkillScanDirs(
  cwd: string,
  config: { skills?: string[] } = {},
  builtinDirs: string[] = [],
): { builtin: string[]; global: string[]; project: string[] } {
  const custom = (config.skills || [])
    .map(s => String(s).trim())
    .filter(Boolean)
    .map(s => {
      const expanded = expandHome(s);
      // resolve：相对路径拼 cwd、绝对路径丢弃 cwd、Windows 下把 `~/x` 展开的
      // 混合分隔符 `C:\Users\xx/x` 归一化为 `C:\Users\xx\x`
      return resolve(cwd, expanded);
    });
  return {
    builtin: builtinDirs,
    global: [...custom, join(configDir(), 'skills')],
    project: [join(cwd, '.shenlan', 'skills')],
  };
}

/** 解析 SKILL.md frontmatter */
function parseSkillMd(filePath: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // frontmatter: ---\nname: xxx\ndescription: xxx\n---
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      // No frontmatter — use directory name
      const dirName = basename(dirname(filePath));
      const desc = content.slice(0, 100).replace(/\n/g, ' ').trim();
      return { name: dirName, description: desc || dirName };
    }
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    return {
      name: nameMatch?.[1]?.trim() || basename(dirname(filePath)),
      description: descMatch?.[1]?.trim() || '(no description)',
    };
  } catch {
    return null;
  }
}

/** 递归扫描 skill 目录 */
function scanSkillDir(dir: string, source: SkillEntry['source']): SkillEntry[] {
  if (!existsSync(dir)) return [];

  const results: SkillEntry[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          const skillMd = join(full, 'SKILL.md');
          if (existsSync(skillMd)) {
            const parsed = parseSkillMd(skillMd);
            if (parsed) {
              results.push({ ...parsed, path: skillMd, dir: full, source });
            }
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return results;
}

/** 加载所有 skill 索引 */
export function loadSkillIndex(skillDirs: { builtin?: string[]; global: string[]; project: string[] }): SkillEntry[] {
  const skills: SkillEntry[] = [];
  for (const dir of skillDirs.builtin || []) {
    skills.push(...scanSkillDir(dir, 'builtin'));
  }
  for (const dir of skillDirs.global) {
    skills.push(...scanSkillDir(dir, 'global'));
  }
  for (const dir of skillDirs.project) {
    skills.push(...scanSkillDir(dir, 'project'));
  }
  return skills;
}

/** 生成 skill 索引文本（注入 system prompt） */
export function buildSkillIndexText(skills: SkillEntry[], maxTokens = 2048): string {
  if (skills.length === 0) return '';

  let text = '\n## Available Skills\n\n';
  text += 'Use `$skillname` to invoke a skill. Skills provide specialized instructions.\n\n';
  text += 'Skills marked 🔒 are builtin and cannot be overridden or modified.\n\n';
  for (const s of skills) {
    const lock = s.source === 'builtin' ? ' 🔒' : '';
    text += `- **$${s.name}**${lock} — ${s.description}\n`;
  }

  // 粗略截断到 token 预算
  if (text.length > maxTokens * 4) {
    text = text.slice(0, maxTokens * 4) + '\n...(truncated)';
  }
  return text;
}

/** 按需加载 skill 全文 */
export function loadSkillContent(name: string, skills: SkillEntry[]): string | null {
  const skill = skills.find(s => s.name === name);
  if (!skill) return null;
  try {
    const content = readFileSync(skill.path, 'utf-8');
    // 去掉 frontmatter
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    return `## Skill: ${skill.name}\n> ${skill.description}\n\n${body}`;
  } catch {
    return null;
  }
}
