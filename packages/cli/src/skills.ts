/**
 * skills 子命令与 /skills 共享逻辑 — 列出已安装 skills
 *
 * 扫描来源：内置目录 + config.skills 自定义目录 + 全局目录 + 项目 .shenlan/skills
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSkillIndex, buildSkillScanDirs, type SkillEntry } from '@shenlan/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = join(__dirname, '..', 'builtin-skills');

/** 来源展示标签：内置（锁定）/ 用户级 / 项目级 */
export const SKILL_SOURCE_LABELS: Record<SkillEntry['source'], string> = {
  builtin: '内置 🔒',
  global: '用户级',
  project: '项目级',
};

const SOURCE_ORDER: Record<SkillEntry['source'], number> = { builtin: 0, global: 1, project: 2 };

/** 来源中文标签（内置 🔒 / 用户级 / 项目级） */
export function skillSourceLabel(source: SkillEntry['source']): string {
  return SKILL_SOURCE_LABELS[source];
}

/** 排序：内置 → 用户级 → 项目级，同来源按名称 */
export function sortSkills(skills: SkillEntry[]): SkillEntry[] {
  return [...skills].sort((a, b) =>
    SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name),
  );
}

/** 汇总当前已安装 skills（含内置） */
export function getAllSkills(cwd = process.cwd()): SkillEntry[] {
  const config = loadConfig(cwd);
  return sortSkills(loadSkillIndex(buildSkillScanDirs(cwd, config, [BUILTIN_SKILLS_DIR])));
}

/** 人类可读的 skill 列表 */
export function formatSkillList(skills: SkillEntry[]): string {
  if (skills.length === 0) return '  未安装 skills';
  return sortSkills(skills)
    .map(s => `  ${s.source === 'builtin' ? '🔒 ' : ''}${s.name} — ${s.description} [${skillSourceLabel(s.source)}]\n    ${s.dir}`)
    .join('\n');
}

/** CLI 入口：shenlan skills list [--json] */
export async function runSkillsCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === 'list' || sub === undefined) {
    const skills = getAllSkills();
    if (argv.includes('--json')) {
      console.log(JSON.stringify(skills, null, 2));
    } else {
      console.log(formatSkillList(skills));
    }
    return 0;
  }
  console.error('Usage: shenlan skills list [--json]');
  return 2;
}
