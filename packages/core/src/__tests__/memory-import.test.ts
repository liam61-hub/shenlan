/**
 * expandImports — @import 递归展开的边界用例（本轮最易出边界 bug 的模块，测试要密）
 *
 * 覆盖：单层/嵌套/深度上限、环检测、围栏保护（含被导入文件内部）、
 * 相对路径基准、~ 展开、字节上限、文件缺失、symlink 逃逸。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { expandImports, IMPORT_MAX_DEPTH } from '../memory-import.js';
import { loadMemories, projectMemoryDir } from '../memory.js';

describe('expandImports', () => {
  let tmp: string;
  let base: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-import-'));
    base = join(tmp, 'base');
    mkdirSync(base, { recursive: true });
    // isPathSafe 的项目根 = process.cwd()，把 cwd 指到临时项目下；
    // 同时隔离全局记忆目录（loadMemories 集成用例不得混入开发机真实记忆）
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(base);
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const p = join(base, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('单层导入：@import 行原位替换为文件全文', () => {
    write('shared.md', '导入的内容');
    const r = expandImports('开头\n@import shared.md\n结尾', base);
    expect(r.text).toBe('开头\n导入的内容\n结尾');
    expect(r.skipped).toEqual([]);
    // imported 按契约返回 realpath：macOS 的 /var → /private/var 等系统级 symlink
    // 会让字面路径与 realpath 不等，断言须用 realpathSync 归一化。
    expect(r.imported).toEqual([realpathSync(join(base, 'shared.md'))]);
  });

  it('嵌套导入到 5 层通过，第 6 层被拒并带可见标记', () => {
    // d1→d2→d3→d4→d5→d6：d5 在深度 4 展开时导入 d6 会到深度 5 = maxDepth → 拒
    write('d5.md', 'level5\n@import d6.md');
    write('d4.md', '@import d5.md');
    write('d3.md', '@import d4.md');
    write('d2.md', '@import d3.md');
    write('d1.md', '@import d2.md');

    const r = expandImports('@import d1.md', base);
    expect(r.text).toContain('level5');
    expect(r.text).toContain('<!-- @import skipped: d6.md (深度超限');
    expect(r.imported).toHaveLength(5);
  });

  it('自引用环被拒（A→A）', () => {
    write('a.md', '@import a.md\n正文');
    const r = expandImports('@import a.md', base);
    expect(r.text).toContain('<!-- @import skipped: a.md (循环导入) -->');
    expect(r.text).toContain('正文');
  });

  it('A→B→A 环被拒，B 仍展开一次', () => {
    write('a.md', '@import b.md');
    write('b.md', '@import a.md\nb 的内容');
    const r = expandImports('@import a.md', base);
    expect(r.text).toContain('b 的内容');
    expect(r.text).toContain('(循环导入)');
    expect(r.skipped.length).toBe(1);
  });

  it('``` 与 ~~~ 围栏内的 @import 都不展开（含 info string）', () => {
    const src = [
      '@import real.md',
      '```ts',
      '@import inside-code-fence.md',
      '```',
      '~~~~python',
      '@import inside-tilde-fence.md',
      '~~~~',
    ].join('\n');
    write('real.md', 'real');
    const r = expandImports(src, base);
    expect(r.text).toContain('real');
    expect(r.text).toContain('@import inside-code-fence.md');
    expect(r.text).toContain('@import inside-tilde-fence.md');
    expect(r.skipped).toEqual([]);
  });

  it('被导入文件内部围栏里的 @import 也不展开', () => {
    write('inner.md', '@import fence-nested.md');
    write('fence-nested.md', 'fence-nested 正文');
    write('outer.md', '```\n@import inner.md\n```');
    const r = expandImports('@import outer.md', base);
    expect(r.text).toContain('@import inner.md');
    expect(r.text).not.toContain('fence-nested 正文');
  });

  it('导入文件内的相对 @import 以其自身目录为基准', () => {
    write('sub/one.md', '@import two.md');
    write('sub/two.md', 'two 正文');
    write('root-import.md', '@import sub/one.md');
    const r = expandImports('@import root-import.md', base);
    expect(r.text).toContain('two 正文');
    expect(r.skipped).toEqual([]);
  });

  it('缺失文件给可见标记而非抛错', () => {
    const r = expandImports('@import nope.md', base);
    expect(r.text).toContain('<!-- @import skipped: nope.md (文件不存在) -->');
    expect(r.skipped[0]!.reason).toContain('文件不存在');
  });

  it('超过单文件字节上限被拒并带标记', () => {
    write('big.md', 'x'.repeat(2000));
    const r = expandImports('@import big.md', base, { maxFileBytes: 1000 });
    expect(r.text).toContain('(文件超限');
    expect(r.text).not.toContain('x'.repeat(2000));
  });

  it('~ 路径展开到 homedir', () => {
    // 唯一名 + finally 清理：写真实 homedir 但绝不留残余
    const target = join(homedir(), 'shenlan-import-home-target.md');
    writeFileSync(target, 'home 正文', 'utf-8');
    try {
      const r = expandImports('@import ~/shenlan-import-home-target.md', base);
      expect(r.text).toContain('home 正文');
    } finally {
      rmSync(target, { force: true });
    }
  });

  // Windows 建 symlink 需管理员/开发者模式，CI 的 ubuntu 侧覆盖此用例
  it.skipIf(process.platform === 'win32')('symlink 逃逸到项目外被 isPathSafe 拦截', () => {
    const outside = join(tmp, 'outside.md');
    writeFileSync(outside, 'secret', 'utf-8');
    symlinkSync(outside, join(base, 'escape.md'));
    const r = expandImports('@import escape.md', base);
    expect(r.text).toContain('@import skipped');
    expect(r.text).not.toContain('secret');
  });

  it('空路径 @import 给标记', () => {
    const r = expandImports('@import   ', base);
    expect(r.text).toContain('(空路径)');
  });

  it('无 @import 的文本原样返回（注入路径零成本）', () => {
    const plain = '普通正文\n多行\n无导入';
    expect(expandImports(plain, base).text).toBe(plain);
  });

  it('记忆正文的 @import 在 loadMemories 阶段已展开（预算看到的是展开后的量）', () => {
    // 记忆文件里的 @import 以其所在目录（.shenlan/memory）为基准
    write('imported.md', 'y'.repeat(4000));
    const memDir = projectMemoryDir(base);
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'with-import.md'),
      '---\nname: with-import\ndescription: d\n---\n@import ../../imported.md',
      'utf-8',
    );
    const entries = loadMemories(base);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toContain('y'.repeat(4000));
  });

  it('IMPORT_MAX_DEPTH 默认 5', () => {
    expect(IMPORT_MAX_DEPTH).toBe(5);
  });
});
