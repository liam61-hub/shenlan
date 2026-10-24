/**
 * 坑记忆结构化核心 — 解析/合并/检索/hits 递增（全局 + 项目双层）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePitfallEntry,
  loadPitfalls,
  searchPitfalls,
  incrementPitfallHits,
  globalPitfallPath,
} from '../pitfall-store.js';

function sampleEntry(opts: { title: string; severity?: string; hits?: number; trigger?: string; body?: string }): string {
  const parts = [
    `# ${opts.title}`,
    `severity: ${opts.severity ?? 'soft'}`,
    `hits: ${opts.hits ?? 0}`,
  ];
  if (opts.trigger) parts.push(`trigger: ${opts.trigger}`);
  parts.push(opts.body ?? '注意事项正文');
  return parts.join('\n');
}

describe('parsePitfallEntry', () => {
  it('提取结构化字段', () => {
    const e = parsePitfallEntry(
      sampleEntry({ title: 'push 前先检查 remote', severity: 'hard', hits: 2, trigger: 'git push' }),
      'project', 0,
    );
    expect(e).toMatchObject({
      title: 'push 前先检查 remote',
      severity: 'hard',
      hits: 2,
      trigger: 'git push',
      source: 'project',
    });
    expect(e.body).toContain('注意事项正文');
  });

  it('自由格式条目回退默认（severity soft / hits 0）', () => {
    const e = parsePitfallEntry('# 自由格式条目\n正文内容', 'global', 1);
    expect(e).toMatchObject({ title: '自由格式条目', severity: 'soft', hits: 0, source: 'global' });
  });

  it('severity 大小写不敏感', () => {
    const e = parsePitfallEntry('# t\nSeverity: HARD\n正文', 'project', 0);
    expect(e.severity).toBe('hard');
  });
});

describe('loadPitfalls — 全局 + 项目合并', () => {
  let cwd: string;
  let globalDir: string;
  const realConfig = process.env.XDG_CONFIG_HOME;
  const realAppData = process.env.APPDATA;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shenlan-pf-'));
    globalDir = mkdtempSync(join(tmpdir(), 'shenlan-pf-global-'));
    // Windows 用 APPDATA、macOS/Linux 用 XDG_CONFIG_HOME（platform.ts configDir）
    process.env.XDG_CONFIG_HOME = globalDir;
    process.env.APPDATA = globalDir;
    mkdirSync(join(globalDir, 'shenlan'), { recursive: true });
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
  });

  afterEach(() => {
    if (realConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = realConfig;
    if (realAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = realAppData;
    try { rmSync(cwd, { recursive: true, force: true }); rmSync(globalDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeProject(content: string): void {
    writeFileSync(join(cwd, '.shenlan', 'pitfalls.md'), content, 'utf-8');
  }

  function writeGlobal(content: string): void {
    writeFileSync(globalPitfallPath(), content, 'utf-8');
  }

  it('无文件时返回空数组', () => {
    expect(loadPitfalls(cwd)).toEqual([]);
  });

  it('排序：hard 在前，hits 降序', () => {
    writeProject([
      sampleEntry({ title: 'a-soft', hits: 9 }),
      '---',
      sampleEntry({ title: 'b-hard', severity: 'hard', hits: 1 }),
      '---',
      sampleEntry({ title: 'c-hard', severity: 'hard', hits: 5 }),
    ].join('\n'));
    const list = loadPitfalls(cwd);
    expect(list.map(e => e.title)).toEqual(['c-hard', 'b-hard', 'a-soft']);
  });

  it('全局 + 项目合并：同名以项目覆盖，其余并存', () => {
    writeGlobal([
      sampleEntry({ title: 'same', severity: 'hard', hits: 1, body: '全局版本' }),
      '---',
      sampleEntry({ title: 'global-only', hits: 3 }),
    ].join('\n'));
    writeProject([
      sampleEntry({ title: 'same', severity: 'hard', hits: 7, body: '项目版本' }),
    ].join('\n'));
    const list = loadPitfalls(cwd);
    expect(list).toHaveLength(2);
    const same = list.find(e => e.title === 'same')!;
    expect(same.body).toContain('项目版本');
    expect(same.hits).toBe(7);
    expect(same.source).toBe('project');
    expect(list.find(e => e.title === 'global-only')!.source).toBe('global');
  });
});

describe('searchPitfalls / incrementPitfallHits', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shenlan-pf-search-'));
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('按 trigger/symptom 子串匹配', () => {
    const list = [
      parsePitfallEntry(sampleEntry({ title: 't1', trigger: 'git push', body: '报错 A' }), 'project', 0),
      parsePitfallEntry(sampleEntry({ title: 't2', trigger: 'npm install' }), 'project', 1),
    ];
    expect(searchPitfalls(list, { trigger: 'push', symptom: '' })).toHaveLength(1);
    expect(searchPitfalls(list, { trigger: '', symptom: '报错' })[0]!.title).toBe('t1');
    expect(searchPitfalls(list, { trigger: '', symptom: '' })).toHaveLength(2);
  });

  it('incrementPitfallHits 更新文件内 hits 字段并返回新值，其余内容原样', () => {
    const file = join(cwd, '.shenlan', 'pitfalls.md');
    const original = sampleEntry({ title: 'x', hits: 2, body: '正文行保持原样' });
    writeFileSync(file, original, 'utf-8');
    expect(incrementPitfallHits(file, 'x')).toBe(3);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).toContain('hits: 3');
    expect(raw).toContain('正文行保持原样');
    expect(raw).not.toContain('hits: 2');
  });

  it('incrementPitfallHits 条目不存在返回 -1 且文件不变', () => {
    const file = join(cwd, '.shenlan', 'pitfalls.md');
    const original = sampleEntry({ title: 'x', hits: 2 });
    writeFileSync(file, original, 'utf-8');
    expect(incrementPitfallHits(file, 'not-exist')).toBe(-1);
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });
});
