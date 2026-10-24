/**
 * rules-loader — 分层规则发现的硬边界与 paths 匹配
 *
 * 硬边界是本轮最高风险项：向上递归走出项目读父目录/兄弟项目文件并送进
 * 模型 API 是真实数据外泄形状。这些测试把每一条边界钉死。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  discoverRuleFiles,
  matchPathsRule,
  touchedPathsOfToolCall,
  buildRulesSection,
  RULE_MAX_DEPTH,
  RULE_MAX_FILE_BYTES,
} from '../rules-loader.js';

describe('discoverRuleFiles', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;
  const realPolicyDir = process.env.SHENLAN_POLICY_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-rules-'));
    cwd = join(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'user');
    delete process.env.SHENLAN_POLICY_DIR;
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    if (realPolicyDir === undefined) delete process.env.SHENLAN_POLICY_DIR;
    else process.env.SHENLAN_POLICY_DIR = realPolicyDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const p = join(tmp, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  }

  it('四层全部发现，顺序 org → user → project 近→远 → personal', () => {
    const policyDir = join(tmp, 'policy');
    write('policy/SHENLAN.md', 'org 规则');
    process.env.SHENLAN_POLICY_DIR = policyDir;
    write('user/SHENLAN.md', 'user 规则');
    write('user/rules/global-style.md', 'user rules 规则');
    // 模拟 monorepo：parent 是 git root，proj 是子项目
    write('parent/SHENLAN.md', 'parent 规则');
    write('parent/proj/SHENLAN.md', 'project 规则');
    write('parent/proj/SHENLAN.local.md', 'personal 规则');

    const r = discoverRuleFiles(join(tmp, 'parent', 'proj'));
    expect(r.rules.map((f) => f.level)).toEqual([
      'org', 'user', 'user', 'project', 'project', 'personal',
    ]);
    expect(r.rules.map((f) => f.label)).toEqual([
      'SHENLAN.md', 'SHENLAN.md', 'rules/global-style.md',
      'SHENLAN.md', 'SHENLAN.md', 'SHENLAN.local.md',
    ]);
    // 近的 project 排在远的之前
    const projectLabels = r.rules.filter((f) => f.level === 'project').map((f) => f.path);
    expect(projectLabels[0]).toContain(join('parent', 'proj'));
    expect(projectLabels[1]).toContain(join('parent', 'SHENLAN.md'));
  });

  it('org 层 opt-in：SHENLAN_POLICY_DIR 未设时绝不发现', () => {
    write('proj/SHENLAN.md', 'project 规则');
    const r = discoverRuleFiles(cwd);
    expect(r.rules.some((f) => f.level === 'org')).toBe(false);
  });

  it('project 层停在 git root，不读 git root 之上的父目录规则', () => {
    const gitRoot = join(tmp, 'repo');
    write('repo/.git/config', ''); // .git 目录存在即 git root
    write('repo/proj/SHENLAN.md', 'project 规则');
    write('repo/SHENLAN.md', 'repo root 规则');
    write('outer/SHENLAN.md', 'git root 之外，不应被发现');

    const r = discoverRuleFiles(join(gitRoot, 'proj'));
    const paths = r.rules.map((f) => f.path);
    expect(paths.some((p) => p.includes(join('repo', 'SHENLAN.md')))).toBe(true);
    expect(paths.some((p) => p.includes(join('outer', 'SHENLAN.md')))).toBe(false);
  });

  it('向上递归硬上限 5 层，第 6 层不被发现', () => {
    // tmp/d0/d1/.../d5/proj：cwd 起向上 5 层到 d1；d0 是第 6 层，不得被发现
    let p = join(tmp, 'd0');
    for (let i = 1; i <= 5; i++) p = join(p, `d${i}`);
    const deepCwd = join(p, 'proj');
    mkdirSync(deepCwd, { recursive: true });
    write('d0/d1/SHENLAN.md', '第 5 层规则（应发现）');
    write('d0/SHENLAN.md', '第 6 层规则（不应发现）');

    const r = discoverRuleFiles(deepCwd);
    const paths = r.rules.map((f) => f.path);
    expect(paths).toContain(join(tmp, 'd0', 'd1', 'SHENLAN.md'));
    expect(paths).not.toContain(join(tmp, 'd0', 'SHENLAN.md'));
  });

  it('绝不越过 homedir()：cwd 在 homedir 内时 homedir 本层不被处理', () => {
    // 在真实 homedir 下放哨兵文件（唯一名，finally 清理）
    const sentinel = join(homedir(), 'SHENLAN.md');
    const existedBefore = existsSync(sentinel);
    if (!existedBefore) writeFileSync(sentinel, '哨兵规则', 'utf-8');
    try {
      // tmpdir 通常在 homedir 内（Windows: %TEMP% 在 Users 下）——
      // 若不在，本用例自动退化为「未发现哨兵」同样成立
      const r = discoverRuleFiles(cwd, { stopAtGitRoot: false });
      expect(r.rules.some((f) => f.path === sentinel)).toBe(false);
    } finally {
      if (!existedBefore) rmSync(sentinel, { force: true });
    }
  });

  it('单文件字节上限：超限文件进 skipped 并带原因', () => {
    write('proj/SHENLAN.md', 'x'.repeat(2000));
    const r = discoverRuleFiles(cwd, { maxFileBytes: 1000 });
    expect(r.rules.some((f) => f.path.includes('proj'))).toBe(false);
    expect(r.skipped.some((s) => s.reason.includes('文件超限'))).toBe(true);
  });

  it('rules/ 目录文件按名排序，无 rules 目录不报错', () => {
    write('proj/.shenlan/rules/b.md', 'b 规则');
    write('proj/.shenlan/rules/a.md', 'a 规则');
    const r = discoverRuleFiles(cwd);
    const labels = r.rules.map((f) => f.label);
    expect(labels.indexOf('rules/a.md')).toBeLessThan(labels.indexOf('rules/b.md'));
  });

  it('frontmatter 的 paths: 被解析为条件规则，正文剥掉 frontmatter', () => {
    write('proj/.shenlan/rules/ts.md', '---\npaths: src/**/*.ts\ndescription: ts 规则\n---\nTS 正文');
    const r = discoverRuleFiles(cwd);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]!.paths).toEqual(['src/**/*.ts']);
    expect(r.rules[0]!.content).toBe('TS 正文');
    expect(r.rules[0]!.content).not.toContain('paths:');
  });

  it('RULE_MAX_DEPTH / RULE_MAX_FILE_BYTES 常量', () => {
    expect(RULE_MAX_DEPTH).toBe(5);
    expect(RULE_MAX_FILE_BYTES).toBe(32 * 1024);
  });
});

describe('matchPathsRule', () => {
  it('通配符 glob 命中相对与绝对路径', () => {
    expect(matchPathsRule(['src/**/*.ts'], ['src/foo/bar.ts'])).toBe(true);
    expect(matchPathsRule(['**/*.test.ts'], ['packages/core/x.test.ts'])).toBe(true);
    expect(matchPathsRule(['src/*.ts'], ['src/foo/bar.ts'])).toBe(false); // 单星不跨目录
    expect(matchPathsRule(['*.md'], ['README.md'])).toBe(true);
  });

  it('无通配符模式按目录前缀匹配', () => {
    expect(matchPathsRule(['src/api'], ['src/api/foo.ts'])).toBe(true);
    expect(matchPathsRule(['src/api'], ['src/api'])).toBe(true);
    expect(matchPathsRule(['src/api'], ['src/apix/foo.ts'])).toBe(false);
  });

  it('多个 glob 任一命中即真', () => {
    expect(matchPathsRule(['docs/**', 'src/**/*.ts'], ['src/a/b.ts'])).toBe(true);
  });
});

describe('touchedPathsOfToolCall', () => {
  // 绝对路径跨平台（/fake 在 Windows 是盘符相对路径，不可作 fixture）
  const cwd = join(tmpdir(), 'fake-proj');

  it('read/write/edit 返回相对与绝对两种形态', () => {
    const touched = touchedPathsOfToolCall('edit', { file_path: 'src/a.ts' }, cwd);
    expect(touched).toHaveLength(2);
    expect(touched[0]).toBe(join(cwd, 'src', 'a.ts').replace(/\\/g, '/'));
    expect(touched[1]).toBe('src/a.ts');
  });

  it('其他工具不参与', () => {
    expect(touchedPathsOfToolCall('shell', { command: 'x' }, cwd)).toEqual([]);
    expect(touchedPathsOfToolCall('write', {}, cwd)).toEqual([]);
  });
});

describe('buildRulesSection', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;
  const realPolicyDir = process.env.SHENLAN_POLICY_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-rules-sec-'));
    cwd = join(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'user');
    delete process.env.SHENLAN_POLICY_DIR;
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    if (realPolicyDir === undefined) delete process.env.SHENLAN_POLICY_DIR;
    else process.env.SHENLAN_POLICY_DIR = realPolicyDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('无规则时返回空段', () => {
    const sec = buildRulesSection(cwd);
    expect(sec.text).toBe('');
    expect(sec.files).toBe(0);
    expect(sec.pathsCount).toBe(0);
  });

  it('paths 条件规则不进段，计入 pathsCount', () => {
    mkdirSync(join(cwd, '.shenlan', 'rules'), { recursive: true });
    writeFileSync(join(cwd, 'SHENLAN.md'), '常驻规则', 'utf-8');
    writeFileSync(
      join(cwd, '.shenlan', 'rules', 'ts.md'),
      '---\npaths: src/**/*.ts\n---\nTS 规则',
      'utf-8',
    );
    const sec = buildRulesSection(cwd);
    expect(sec.text).toContain('常驻规则');
    expect(sec.text).not.toContain('TS 规则');
    expect(sec.files).toBe(1);
    expect(sec.pathsCount).toBe(1);
  });

  it('超预算从低优先级折叠（personal 先丢）并带可见提示', () => {
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    writeFileSync(join(cwd, 'SHENLAN.md'), '项目规则', 'utf-8');
    writeFileSync(join(cwd, 'SHENLAN.local.md'), 'x'.repeat(2000), 'utf-8');
    const sec = buildRulesSection(cwd, { maxTokens: 100 });
    expect(sec.folded).toBeGreaterThan(0);
    expect(sec.text).toContain('已折叠');
    expect(sec.text).toContain('SHENLAN.local.md');
    expect(sec.text).not.toContain('x'.repeat(2000));
    expect(sec.tokens).toBeLessThanOrEqual(100);
  });
});
