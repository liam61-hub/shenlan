import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../tools/glob.js';
import { getTool } from '../tools/index.js';
import type { Tool } from '../tools/index.js';

let tool: Tool;
let root: string;

beforeAll(() => {
  tool = getTool('glob')!;
  root = mkdtempSync(join(tmpdir(), 'shenlan-glob-'));
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(join(root, 'src', 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'src', '.git'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), '');
  writeFileSync(join(root, 'src', 'nested', 'b.ts'), '');
  writeFileSync(join(root, 'src', 'node_modules', 'pkg', 'x.ts'), '');
  writeFileSync(join(root, 'src', '.git', 'config'), '');
  writeFileSync(join(root, 'README.md'), '');
  writeFileSync(join(root, 'DESIGN.md'), '');
  try {
    symlinkSync(root, join(root, 'loop'), 'dir');
  } catch {
    // 平台不支持符号链接则跳过该断言场景
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('glob 工具', () => {
  it('相对模式：递归匹配，跳过 node_modules / 隐藏目录 / 隐藏文件不匹配', async () => {
    const res = await tool.execute({ pattern: '**/*.ts', path: root });
    expect(res.content).toContain('2 file(s) matched');
    expect(res.content).toContain('src/a.ts');
    expect(res.content).toContain('src/nested/b.ts');
    expect(res.content).not.toContain('node_modules');
    expect(res.content).not.toContain('.git');
  });

  it('绝对路径模式：匹配绝对路径（修复相对/绝对口径不一致）', async () => {
    const res = await tool.execute({
      pattern: join(root, '**', 'DESIGN.md'),
      path: root,
    });
    expect(res.content).toContain('1 file(s) matched');
    expect(res.content).toContain('DESIGN.md');
  });

  it('绝对路径模式指向子目录', async () => {
    const res = await tool.execute({
      pattern: join(root, 'src', '**', '*.ts'),
      path: root,
    });
    expect(res.content).toContain('2 file(s) matched');
  });

  it('绝对路径模式未给 path：自动以模式静态前缀为搜索目录', async () => {
    const res = await tool.execute({ pattern: join(root, '**', 'DESIGN.md') });
    expect(res.content).toContain('1 file(s) matched');
    expect(res.content).toContain('DESIGN.md');
  });

  it('无匹配返回 No files matched', async () => {
    const res = await tool.execute({ pattern: '*.rs', path: root });
    expect(res.content).toBe('No files matched pattern "*.rs"');
  });

  it('不跟随符号链接目录（防循环扫描）', async () => {
    const res = await tool.execute({ pattern: '**/*', path: root });
    expect(res.content).not.toContain('loop/');
  });

  it('已 abort 的信号返回中断错误而不是继续扫描', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await tool.execute({ pattern: '**/*.ts', path: root }, controller.signal);
    expect(res.content).toBe('Glob aborted');
    expect(res.isError).toBe(true);
  });
});
