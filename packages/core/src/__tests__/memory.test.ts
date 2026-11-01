import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildMemorySection,
  MEMORY_BLOCK_START,
  MEMORY_BLOCK_END,
  loadMemories,
  DEFAULT_MEMORY_TOKEN_BUDGET,
  injectMemories,
  injectMemoryIndex,
  loadMemoryIndex,
  updateMemoryIndex,
  removeMemoryIndex,
  globalMemoryDir,
  projectMemoryDir,
} from '../memory.js';
import type { MemoryEntry } from '../memory.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, refreshMemorySection } from '../context.js';

describe('injectMemories', () => {
  it('returns empty string for empty list', () => {
    expect(injectMemories([])).toBe('');
  });

  it('formats memory entries for system prompt', () => {
    const memories: MemoryEntry[] = [
      { name: 'test', file: 'test.md', description: 'A test memory', content: 'Remember this.' },
    ];
    const result = injectMemories(memories);
    expect(result).toContain('## 记忆');
    expect(result).toContain('### test');
    expect(result).toContain('Remember this.');
  });
});

describe('记忆索引（MEMORY.md 读写）', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-memory-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('updateMemoryIndex 新建索引并追加条目', () => {
    const dir = projectMemoryDir(cwd);
    updateMemoryIndex(dir, 'use-pnpm', 'Use pnpm for installs');
    updateMemoryIndex(dir, 'log-style', 'Keep logs in Chinese');
    const text = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    expect(text).toContain('- [use-pnpm](use-pnpm.md) — Use pnpm for installs');
    expect(text).toContain('- [log-style](log-style.md) — Keep logs in Chinese');
  });

  it('updateMemoryIndex 同名条目原位更新不重复追加', () => {
    const dir = projectMemoryDir(cwd);
    updateMemoryIndex(dir, 'use-pnpm', 'old desc');
    updateMemoryIndex(dir, 'use-pnpm', 'new desc');
    const text = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    expect(text).toContain('- [use-pnpm](use-pnpm.md) — new desc');
    expect(text).not.toContain('old desc');
    expect(text.match(/- \[use-pnpm\]/g)).toHaveLength(1);
  });

  it('removeMemoryIndex 删除条目并清理空行；清空后删除文件', () => {
    const dir = projectMemoryDir(cwd);
    updateMemoryIndex(dir, 'a', 'desc a');
    updateMemoryIndex(dir, 'b', 'desc b');
    removeMemoryIndex(dir, 'a');
    let text = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    expect(text).not.toContain('desc a');
    expect(text).toContain('desc b');
    expect(text.trim().split('\n')).toHaveLength(1);
    removeMemoryIndex(dir, 'b');
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false);
  });

  it('loadMemoryIndex 合并全局 + 项目，项目同名优先', () => {
    const projectDir = projectMemoryDir(cwd);
    const globalDir = globalMemoryDir();
    mkdirSync(globalDir, { recursive: true });
    updateMemoryIndex(projectDir, 'shared', 'project desc');
    updateMemoryIndex(globalDir, 'shared', 'global desc');
    updateMemoryIndex(globalDir, 'only-global', 'global only');
    const index = loadMemoryIndex(cwd);
    expect(index.hasIndex).toBe(true);
    expect(index.text).toContain('project desc');
    expect(index.text).not.toContain('global desc');
    expect(index.text).toContain('only-global');
  });

  it('loadMemoryIndex 截断到前 200 行', () => {
    const dir = projectMemoryDir(cwd);
    // 直接一次性写入索引文件（逐条 updateMemoryIndex 是全量重写 O(n²)，
    // 全量并行跑时超过测试超时；被测对象是 loadMemoryIndex 的截断逻辑）
    const lines = Array.from(
      { length: 250 },
      (_, i) => `- [mem-${i}](mem-${i}.md) — description ${i}`,
    ).join('\n') + '\n';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), lines, 'utf-8');
    const index = loadMemoryIndex(cwd);
    expect(index.text.split('\n')).toHaveLength(200);
    expect(index.text).toContain('mem-0');
    expect(index.text).not.toContain('mem-249');
  });

  it('loadMemoryIndex 按行边界截断到 25KB', () => {
    const dir = projectMemoryDir(cwd);
    const longDesc = '长描述'.repeat(80);
    // 一次性写入（理由同上：避免 200 次全量重写在全量并行跑时超时）
    const lines = Array.from(
      { length: 200 },
      (_, i) => `- [mem-${i}](mem-${i}.md) — ${longDesc}`,
    ).join('\n') + '\n';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), lines, 'utf-8');
    const index = loadMemoryIndex(cwd);
    const bytes = Buffer.byteLength(index.text, 'utf-8');
    expect(bytes).toBeLessThanOrEqual(25 * 1024);
    // 截断发生在行边界：最后一行是完整索引行（不以中间截断的 desc 结尾）
    expect(index.text.split('\n').length).toBeLessThan(200);
    expect(index.text).toContain('mem-0');
  });

  it('loadMemoryIndex 无任何 MEMORY.md 时 hasIndex=false', () => {
    const index = loadMemoryIndex(cwd);
    expect(index.hasIndex).toBe(false);
    expect(index.text).toBe('');
  });

  it('injectMemoryIndex 输出索引 + 目录说明，autoSave=false 时隐藏 memory_save 提示', () => {
    const dir = projectMemoryDir(cwd);
    updateMemoryIndex(dir, 'use-pnpm', 'Use pnpm');
    const index = loadMemoryIndex(cwd);
    const text = injectMemoryIndex(index);
    expect(text).toContain('## 记忆');
    expect(text).toContain('- [use-pnpm](use-pnpm.md) — Use pnpm');
    expect(text).toContain(index.projectDir);
    expect(text).toContain('memory_save');
    const off = injectMemoryIndex(index, { autoSave: false });
    expect(off).not.toContain('memory_save');
  });
});

describe('buildSystemPrompt 记忆注入', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-prompt-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan', 'memory'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('规定非查询任务最终总结的固定内容，并允许查询类任务简答', () => {
    const prompt = buildSystemPrompt(cwd);
    for (const required of [
      'completed work',
      'final line ranges',
      'left unchanged, with the reason',
      'verification commands and actual results',
      'unresolved issues and material limitations',
      'commit result',
      'Query-only answers may stay brief',
    ]) expect(prompt).toContain(required);
  });

  it('要求多步骤任务初始化并持续更新底部 todo_write 清单', () => {
    const prompt = buildSystemPrompt(cwd);
    expect(prompt).toContain('initialize the visible bottom checklist with `todo_write`');
    expect(prompt).toContain('do not update this checklist');
    expect(prompt).toContain('cannot replace `todo_write`');
  });

  it('无 MEMORY.md 时回退旧 front-matter 全量注入', () => {
    const dir = projectMemoryDir(cwd);
    writeFileSync(
      join(dir, 'legacy.md'),
      '---\nname: legacy\ndescription: old format\n---\nFull legacy content',
      'utf-8',
    );
    const prompt = buildSystemPrompt(cwd);
    expect(prompt).toContain('### legacy');
    expect(prompt).toContain('Full legacy content');
    expect(prompt).not.toContain('MEMORY.md');
  });

  it('有 MEMORY.md 时只注入索引，不注入主题全文', () => {
    const dir = projectMemoryDir(cwd);
    writeFileSync(
      join(dir, 'topic.md'),
      '---\nname: topic\ndescription: indexed\n---\nFull topic content',
      'utf-8',
    );
    updateMemoryIndex(dir, 'topic', 'indexed');
    const prompt = buildSystemPrompt(cwd);
    expect(prompt).toContain('- [topic](topic.md) — indexed');
    expect(prompt).not.toContain('Full topic content');
  });

  it('memoryAutoSave=false 时注入说明不提及 memory_save', () => {
    updateMemoryIndex(projectMemoryDir(cwd), 'topic', 'indexed');
    const prompt = buildSystemPrompt(cwd, { memoryAutoSave: false });
    expect(prompt).not.toContain('memory_save');
  });
});

describe('buildMemorySection — token 预算（C1）', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-membudget-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 写 N 条索引条目到指定作用域目录，description 填充到 padLen 字符以撑 token */
  function seedIndex(dir: string, prefix: string, count: number, padLen = 20): void {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      updateMemoryIndex(dir, `${prefix}-${i}`, 'x'.repeat(padLen));
    }
  }

  it('未超预算时全部注入，truncated=false', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 3);
    const sec = buildMemorySection(cwd, { maxTokens: 4096 });
    expect(sec.mode).toBe('index');
    expect(sec.entryCount).toBe(3);
    expect(sec.foldedCount).toBe(0);
    expect(sec.truncated).toBe(false);
    expect(sec.text).toContain('- [proj-0](proj-0.md)');
    expect(sec.text).toContain('- [proj-2](proj-2.md)');
    expect(sec.text).not.toContain('已折叠');
  });

  it('超预算时折叠并且 tokens 不超预算', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 60, 60);
    const sec = buildMemorySection(cwd, { maxTokens: 200 });
    expect(sec.truncated).toBe(true);
    expect(sec.entryCount).toBeLessThan(60);
    expect(sec.foldedCount).toBe(60 - sec.entryCount);
    expect(sec.tokens).toBeLessThanOrEqual(sec.budget);
  });

  it('折叠提示带条数并指向 /memory', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 60, 60);
    const sec = buildMemorySection(cwd, { maxTokens: 200 });
    expect(sec.text).toContain(`...(还有 ${sec.foldedCount} 条记忆已折叠，/memory 查看)`);
  });

  it('折叠时全局条目先被丢弃，项目条目存活', () => {
    // 全局 20 条 + 项目 3 条；预算只够装少数几条
    seedIndex(globalMemoryDir(), 'glob', 20, 80);
    seedIndex(projectMemoryDir(cwd), 'proj', 3, 80);
    const sec = buildMemorySection(cwd, { maxTokens: 150 });
    expect(sec.truncated).toBe(true);
    expect(sec.text).toContain('- [proj-0](proj-0.md)');
    expect(sec.text).not.toContain('- [glob-19](glob-19.md)');
  });

  it('输出绝不出现半行截断（每行都是完整索引条目）', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 40, 70);
    const sec = buildMemorySection(cwd, { maxTokens: 180 });
    const entryLines = sec.text.split('\n').filter((l) => l.startsWith('- ['));
    expect(entryLines.length).toBe(sec.entryCount);
    for (const line of entryLines) {
      expect(line).toMatch(/^- \[proj-\d+\]\(proj-\d+\.md\) — x+$/);
    }
  });

  it('maxTokens 为 0 / 负数 / 省略时回落默认预算 4096', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 2);
    for (const maxTokens of [0, -1, undefined]) {
      const sec = buildMemorySection(cwd, { maxTokens });
      expect(sec.budget).toBe(DEFAULT_MEMORY_TOKEN_BUDGET);
      expect(sec.truncated).toBe(false);
    }
  });

  /** 去掉 START/END 标记行，与旧注入器的输出对比（标记是 C2 刷新回路引入的） */
  function stripMarkers(text: string): string {
    return text
      .split('\n')
      .filter((l) => l !== MEMORY_BLOCK_START && l !== MEMORY_BLOCK_END)
      .join('\n');
  }

  it('全量模式输出去掉标记后与 injectMemories 逐字节一致', () => {
    const dir = projectMemoryDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'legacy.md'), '---\nname: legacy\ndescription: d\n---\nBody text', 'utf-8');
    const sec = buildMemorySection(cwd, { maxTokens: 4096 });
    expect(sec.mode).toBe('full');
    expect(sec.entryCount).toBe(1);
    expect(sec.text.startsWith(MEMORY_BLOCK_START)).toBe(true);
    expect(sec.text.endsWith(MEMORY_BLOCK_END)).toBe(true);
    expect(stripMarkers(sec.text)).toBe(injectMemories(loadMemories(cwd)));
  });

  it('索引模式输出去掉标记后与 injectMemoryIndex 逐字节一致（未超预算）', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 2);
    const sec = buildMemorySection(cwd, { maxTokens: 4096 });
    expect(stripMarkers(sec.text)).toBe(injectMemoryIndex(loadMemoryIndex(cwd)));
  });

  it('完全无记忆时返回空串（不注入空的 ## 记忆 段）', () => {
    const sec = buildMemorySection(cwd, { maxTokens: 4096 });
    expect(sec.mode).toBe('full');
    expect(sec.text).toBe('');
    expect(sec.tokens).toBe(0);
  });

  it('buildSystemPrompt 传 maxMemoryTokens 时记忆段被折叠', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 60, 60);
    const prompt = buildSystemPrompt(cwd, { maxMemoryTokens: 200 });
    expect(prompt).toContain('条记忆已折叠');
    expect(prompt).not.toContain('- [proj-59](proj-59.md)');
  });
});

describe('refreshMemorySection — C2 刷新回路', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-mem-refresh-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedIndex(dir: string, prefix: string, count: number): void {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      updateMemoryIndex(dir, `${prefix}-${i}`, `desc ${i}`);
    }
  }

  it('只替换分隔块：新记忆出现在块内，周围文本逐字节不变', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 2);
    const before = buildSystemPrompt(cwd);
    expect(before).toContain(MEMORY_BLOCK_START);

    // 刷新前不存在的新记忆（模拟本会话内 memory_save）
    updateMemoryIndex(projectMemoryDir(cwd), 'extra', '新增的一条');
    const after = refreshMemorySection(before, cwd);

    expect(after).toContain('- [extra](extra.md) — 新增的一条');
    // 块外文本（前缀 + 后缀）逐字节一致 —— provider prompt 缓存前提
    const startIdx = before.indexOf(MEMORY_BLOCK_START);
    const endIdx = after.indexOf(MEMORY_BLOCK_END) + MEMORY_BLOCK_END.length;
    expect(after.slice(0, startIdx)).toBe(before.slice(0, startIdx));
    expect(after.slice(endIdx)).toBe(
      before.slice(before.indexOf(MEMORY_BLOCK_END) + MEMORY_BLOCK_END.length),
    );
  });

  it('记忆段仍过 token 预算（刷新不绕过 C1 折叠）', () => {
    const dir = projectMemoryDir(cwd);
    seedIndex(dir, 'proj', 50);
    const before = buildSystemPrompt(cwd, { maxMemoryTokens: 4096 });
    updateMemoryIndex(dir, 'extra', 'x'.repeat(500));
    const after = refreshMemorySection(before, cwd, { maxMemoryTokens: 200 });
    expect(after).toContain('条记忆已折叠');
  });

  it('缺分隔符的旧 --resume system 消息原样返回而非被破坏', () => {
    const oldPrompt = 'You are an agent.\n\nSome legacy instructions without memory markers.';
    expect(refreshMemorySection(oldPrompt, cwd)).toBe(oldPrompt);
  });

  it('记忆全部删空后记忆块整体移除（不残留标记）', () => {
    seedIndex(projectMemoryDir(cwd), 'proj', 1);
    const before = buildSystemPrompt(cwd);
    expect(before).toContain(MEMORY_BLOCK_START);

    // 模拟 /memory rm 清空：索引空 → MEMORY.md 被删除 → 全量模式零条目
    removeMemoryIndex(projectMemoryDir(cwd), 'proj-0');
    const after = refreshMemorySection(before, cwd);

    expect(after).not.toContain(MEMORY_BLOCK_START);
    expect(after).not.toContain(MEMORY_BLOCK_END);
    const startIdx = before.indexOf(MEMORY_BLOCK_START);
    expect(after.slice(0, startIdx)).toBe(before.slice(0, startIdx));
  });
});
