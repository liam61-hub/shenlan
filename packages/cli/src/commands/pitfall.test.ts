/**
 * /pitfall 命令共享逻辑 — 结构化列表 / add / CLAUDE.md·AGENTS.md 导入
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPitfalls } from '@shenlan/core';
import { pitfallReport, pitfallAdd, importPitfallsFromAgentDocs } from './pitfall.js';

describe('pitfall 命令共享逻辑', () => {
  let cwd: string;
  let homeDir: string;
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shenlan-pf-cmd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'shenlan-pf-home-'));
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    // 隔离 ~/.claude/CLAUDE.md（import 扫描全局文件；避免命中真实全局配置）
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    try { rmSync(cwd, { recursive: true, force: true }); rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('pitfallReport 空库显示空态', () => {
    expect(pitfallReport(cwd)).toContain('None');
  });

  it('pitfallAdd 追加新条目（默认 soft，与解析器兼容），重复标题更新', () => {
    pitfallAdd(cwd, '# 新坑\nnpm 会缓存\n');
    let list = loadPitfalls(cwd);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: '新坑', severity: 'soft', hits: 0 });

    pitfallAdd(cwd, '# 新坑\nseverity: hard\n更新为 hard\n');
    list = loadPitfalls(cwd);
    expect(list).toHaveLength(1);
    expect(list[0]!.severity).toBe('hard');
  });

  it('pitfallReport 结构化列表（title severity hits source）', () => {
    pitfallAdd(cwd, '# 坑A\nseverity: hard\nhits: 2\n正文');
    pitfallAdd(cwd, '# 坑B\n正文');
    const report = pitfallReport(cwd);
    expect(report).toContain('坑A');
    expect(report).toContain('hard');
    expect(report).toContain('hits=2');
    expect(report).toContain('坑B');
    expect(report).toContain('soft');
  });

  it('importPitfallsFromAgentDocs 提取坑类标题段落为条目（body 保留原文，soft）', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), [
      '# 仓库指南',
      '正常段落。',
      '## 坑与陷阱',
      '双远程推送必须同时推到两个仓库。',
      '第二个注意点。',
      '## 其他章节',
      '无关内容。',
    ].join('\n'), 'utf-8');

    const result = importPitfallsFromAgentDocs(cwd);
    expect(result.imported).toBe(1);
    const list = loadPitfalls(cwd);
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('坑与陷阱');
    expect(list[0]!.severity).toBe('soft');
    expect(list[0]!.body).toContain('双远程推送');
    expect(list[0]!.body).not.toContain('无关内容');
  });

  it('import 重复标题跳过（幂等）', () => {
    writeFileSync(join(cwd, 'CLAUDE.md'), [
      '## 坑',
      '已导入过的内容。',
    ].join('\n'), 'utf-8');

    expect(importPitfallsFromAgentDocs(cwd).imported).toBe(1);
    const second = importPitfallsFromAgentDocs(cwd);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(loadPitfalls(cwd)).toHaveLength(1);
  });

  it('无坑类段落时 import 报告 0 条', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# 指南\n只是普通内容。\n', 'utf-8');
    const result = importPitfallsFromAgentDocs(cwd);
    expect(result.imported).toBe(0);
    expect(loadPitfalls(cwd)).toHaveLength(0);
  });
});
