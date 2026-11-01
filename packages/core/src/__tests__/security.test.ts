import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskSensitive, isProtectedPath, setSafetyConfig, isPathSafe } from '../security.js';
import { DEFAULT_CONFIG } from '../config.js';

describe('maskSensitive', () => {
  it('masks API keys', () => {
    expect(maskSensitive('key=sk-abcdefghijklmnopqrstuvwxyz123'))
      .toContain('***API_KEY***');
  });

  it('masks Bearer tokens', () => {
    expect(maskSensitive('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc'))
      .toContain('***TOKEN***');
  });

  it('masks passwords in connection strings', () => {
    expect(maskSensitive('mysql://user:password=mypassword@host'))
      .toContain('password=***');
  });

  it('leaves normal text unchanged', () => {
    expect(maskSensitive('hello world')).toBe('hello world');
  });
});

describe('isProtectedPath — 保护路径拦截（write/edit 前置）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-protect-'));
    setSafetyConfig(null);
  });

  afterEach(() => {
    setSafetyConfig(null);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('未注入配置/空清单时不拦截（向后兼容）', () => {
    expect(isProtectedPath(join(tmp, 'x.txt')).blocked).toBe(false);
    setSafetyConfig({ ...DEFAULT_CONFIG });
    expect(isProtectedPath(join(tmp, 'x.txt')).blocked).toBe(false);
  });

  it('glob 模式命中（**/.git/**，真实存在的路径经 realpath 规范化）', () => {
    mkdirSync(join(tmp, 'repo', '.git'), { recursive: true });
    const target = join(tmp, 'repo', '.git', 'config');
    writeFileSync(target, 'x', 'utf-8');
    setSafetyConfig({
      ...DEFAULT_CONFIG,
      actionSafety: { ...DEFAULT_CONFIG.actionSafety!, protectedPaths: ['**/.git/**'] },
    });
    const r = isProtectedPath(target);
    expect(r.blocked).toBe(true);
    expect(r.pattern).toBe('**/.git/**');
  });

  it('普通文件名片段模式命中（.git 子串匹配）', () => {
    setSafetyConfig({
      ...DEFAULT_CONFIG,
      actionSafety: { ...DEFAULT_CONFIG.actionSafety!, protectedPaths: ['.git'] },
    });
    expect(isProtectedPath(join(tmp, 'repo', '.git', 'config')).blocked).toBe(true);
  });

  it('不存在的路径同样匹配（写新文件场景，按字面路径规范化）', () => {
    setSafetyConfig({
      ...DEFAULT_CONFIG,
      actionSafety: { ...DEFAULT_CONFIG.actionSafety!, protectedPaths: ['**/.env*'] },
    });
    expect(isProtectedPath(join(tmp, 'proj', '.env.local')).blocked).toBe(true);
  });

  it('通过指向保护目录的 symlink 阻止尚不存在的新文件', () => {
    const protectedDir = join(tmp, 'vault');
    const linkDir = join(tmp, 'project', 'vault-link');
    mkdirSync(protectedDir, { recursive: true });
    mkdirSync(join(tmp, 'project'), { recursive: true });
    symlinkSync(protectedDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    setSafetyConfig({
      ...DEFAULT_CONFIG,
      actionSafety: { ...DEFAULT_CONFIG.actionSafety!, protectedPaths: [protectedDir] },
    });

    expect(isProtectedPath(join(linkDir, 'new-subdir', 'secret.txt')).blocked).toBe(true);
  });

  it('非保护路径不拦截', () => {
    setSafetyConfig({
      ...DEFAULT_CONFIG,
      actionSafety: { ...DEFAULT_CONFIG.actionSafety!, protectedPaths: ['**/.git/**'] },
    });
    expect(isProtectedPath(join(tmp, 'repo', 'src', 'main.ts')).blocked).toBe(false);
  });
});

describe('isPathSafe — symlink 逃逸判定', () => {
  let tmp: string;
  let project: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-pathsafe-'));
    project = join(tmp, 'project');
    mkdirSync(project, { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('项目内普通文件安全（含 tmpdir 系统级 symlink：/var → /private/var）', () => {
    const f = join(project, 'a.md');
    writeFileSync(f, 'x', 'utf-8');
    expect(isPathSafe(f)).toEqual({ safe: true });
  });

  it('项目内子目录文件安全', () => {
    mkdirSync(join(project, 'src'), { recursive: true });
    const f = join(project, 'src', 'main.ts');
    writeFileSync(f, 'x', 'utf-8');
    expect(isPathSafe(f).safe).toBe(true);
  });

  it('symlink 指向项目外被拦截', () => {
    // Windows 普通用户默认不能创建文件 symlink（EPERM），但目录 junction
    // 无需管理员权限且同样会经 realpath 逃出项目根，保留真实安全语义而非跳过。
    let target: string;
    if (process.platform === 'win32') {
      const outsideDir = join(tmp, 'outside');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'secret.md'), 'secret', 'utf-8');
      const link = join(project, 'escape');
      symlinkSync(outsideDir, link, 'junction');
      target = join(link, 'secret.md');
    } else {
      const outside = join(tmp, 'outside.md');
      writeFileSync(outside, 'secret', 'utf-8');
      const link = join(project, 'escape.md');
      symlinkSync(outside, link);
      target = link;
    }
    const r = isPathSafe(target);
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('Symlink escape');
  });

  it('项目外路径不检查（用户显式传入）', () => {
    const outside = join(tmp, 'outer.md');
    writeFileSync(outside, 'x', 'utf-8');
    expect(isPathSafe(outside).safe).toBe(true);
  });

  it('不存在的路径视为安全（写新文件场景）', () => {
    expect(isPathSafe(join(project, 'not-yet.md')).safe).toBe(true);
  });

  it('新文件经项目内 symlink 父目录逃逸时拦截', () => {
    const outside = join(tmp, 'outside');
    const link = join(project, 'escape');
    mkdirSync(outside);
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const target = join(link, 'not-created', 'secret.md');
    const platformPath = process.platform === 'win32' ? target.replace(/\\/g, '/') : target;

    const result = isPathSafe(platformPath);

    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Symlink escape');
  });
});
