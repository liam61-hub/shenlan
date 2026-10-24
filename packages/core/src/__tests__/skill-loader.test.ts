import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSkillScanDirs, loadSkillIndex, loadSkillContent, buildSkillIndexText } from '../skill-loader.js';
import { configDir } from '../platform.js';

describe('skill-loader 目录解析与扫描', () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-skills-'));
    cwd = join(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('buildSkillScanDirs 合并内置/自定义/全局/项目目录', () => {
    const dirs = buildSkillScanDirs(cwd, { skills: ['team-skills', '/abs/skills', '~/myskills'] }, ['/builtin']);
    expect(dirs.builtin).toEqual(['/builtin']);
    expect(dirs.global[0]).toBe(join(cwd, 'team-skills'));
    // `/abs/skills` 在 Windows 按基准路径所在盘解析（实现里是 cwd 的盘），
    // 断言用与实现完全相同的表达式，避免进程 cwd 与传入 cwd 不同盘导致错位
    expect(dirs.global[1]).toBe(resolve(cwd, '/abs/skills'));
    expect(dirs.global[2]).toBe(join(homedir(), 'myskills'));
    expect(dirs.global).toContain(join(configDir(), 'skills'));
    expect(dirs.project).toEqual([join(cwd, '.shenlan', 'skills')]);
  });

  it('空 skills 配置时仍含默认全局与项目目录', () => {
    const dirs = buildSkillScanDirs(cwd);
    expect(dirs.builtin).toEqual([]);
    expect(dirs.global).toEqual([join(configDir(), 'skills')]);
    expect(dirs.project).toEqual([join(cwd, '.shenlan', 'skills')]);
  });

  it('loadSkillIndex 按 source 标记来源，loadSkillContent 返回正文', () => {
    const projectSkill = join(cwd, '.shenlan', 'skills', 'demo');
    const globalSkill = join(tmp, 'globalskills', 'gskill');
    mkdirSync(projectSkill, { recursive: true });
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(projectSkill, 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\n# Demo\nbody here');
    writeFileSync(join(globalSkill, 'SKILL.md'), '---\nname: gskill\ndescription: global skill\n---\nGlobal body');

    const skills = loadSkillIndex({ global: [join(tmp, 'globalskills')], project: [join(cwd, '.shenlan', 'skills')] });
    expect(skills).toHaveLength(2);
    const demo = skills.find(s => s.name === 'demo');
    const gskill = skills.find(s => s.name === 'gskill');
    expect(demo?.source).toBe('project');
    expect(gskill?.source).toBe('global');

    const content = loadSkillContent('demo', skills);
    expect(content).toContain('body here');
    expect(content).toContain('demo skill');
    expect(loadSkillContent('missing', skills)).toBeNull();
  });

  it('builtin 目录来源标记为 builtin', () => {
    const builtinSkill = join(tmp, 'builtin', 'bskill');
    mkdirSync(builtinSkill, { recursive: true });
    writeFileSync(join(builtinSkill, 'SKILL.md'), '---\nname: bskill\ndescription: builtin skill\n---\nBuiltin body');
    const skills = loadSkillIndex({
      builtin: [join(tmp, 'builtin')],
      global: [],
      project: [join(cwd, '.shenlan', 'skills')],
    });
    expect(skills.find(s => s.name === 'bskill')?.source).toBe('builtin');
  });

  it('buildSkillIndexText：内置 skill 加 🔒 标记，提示不可覆盖', () => {
    const skills = [
      { name: 'bskill', description: 'builtin skill', path: '/x/SKILL.md', dir: '/x', source: 'builtin' as const },
      { name: 'gskill', description: 'global skill', path: '/y/SKILL.md', dir: '/y', source: 'global' as const },
      { name: 'pskill', description: 'project skill', path: '/z/SKILL.md', dir: '/z', source: 'project' as const },
    ];
    const text = buildSkillIndexText(skills);
    expect(text).toContain('**$bskill** 🔒');
    expect(text).toContain('**$gskill**');
    expect(text).not.toContain('**$gskill** 🔒');
    expect(text).not.toContain('**$pskill** 🔒');
    expect(text).toContain('cannot be overridden or modified');
  });
});
