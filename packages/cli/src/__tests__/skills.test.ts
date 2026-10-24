import { describe, it, expect } from 'vitest';
import { formatSkillList, skillSourceLabel, sortSkills, SKILL_SOURCE_LABELS } from '../skills.js';
import type { SkillEntry } from '@shenlan/core';

function entry(partial: Partial<SkillEntry> & Pick<SkillEntry, 'name' | 'source'>): SkillEntry {
  return {
    description: `${partial.name} desc`,
    path: `/skills/${partial.name}/SKILL.md`,
    dir: `/skills/${partial.name}`,
    ...partial,
  };
}

describe('skills 列表展示（锁标识 + 中文来源标签 + 排序）', () => {
  it('来源标签：内置 🔒 / 用户级 / 项目级', () => {
    expect(SKILL_SOURCE_LABELS.builtin).toBe('内置 🔒');
    expect(skillSourceLabel('builtin')).toBe('内置 🔒');
    expect(skillSourceLabel('global')).toBe('用户级');
    expect(skillSourceLabel('project')).toBe('项目级');
  });

  it('formatSkillList：内置行首 🔒 + 中文来源标签', () => {
    const skills = [
      entry({ name: 'deploy-check', source: 'project' }),
      entry({ name: 'create-skill', source: 'builtin' }),
      entry({ name: 'weekly-report', source: 'global' }),
    ];
    const out = formatSkillList(skills);
    expect(out).toContain('🔒 create-skill — create-skill desc [内置 🔒]');
    expect(out).toContain('weekly-report — weekly-report desc [用户级]');
    expect(out).toContain('deploy-check — deploy-check desc [项目级]');
    expect(out).not.toContain('[builtin]');
    expect(out).not.toContain('[global]');
    expect(out).not.toContain('[project]');
  });

  it('排序：内置 → 用户级 → 项目级，同来源按名称', () => {
    const skills = [
      entry({ name: 'zeta', source: 'project' }),
      entry({ name: 'alpha', source: 'builtin' }),
      entry({ name: 'mid', source: 'global' }),
      entry({ name: 'beta', source: 'builtin' }),
    ];
    const sorted = sortSkills(skills).map(s => s.name);
    expect(sorted).toEqual(['alpha', 'beta', 'mid', 'zeta']);
    // formatSkillList 内部也排序
    const lines = formatSkillList(skills).split('\n').filter(l => l.startsWith('  🔒') || l.startsWith('  alpha') || l.startsWith('  beta'));
    expect(lines[0]).toContain('alpha');
    expect(lines[1]).toContain('beta');
  });

  it('空列表显示未安装提示', () => {
    expect(formatSkillList([])).toBe('  未安装 skills');
  });
});
