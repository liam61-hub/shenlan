/**
 * /memory 斜杠命令逻辑 — 列表、开关、删除、打开目录
 *
 * 与 InputBox 的交互拆分：可测逻辑放这里，UI 渲染留在组件。
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  loadMemories,
  updateConfig,
  removeMemoryIndex,
  globalMemoryDir,
  projectMemoryDir,
} from '@shenlan/core';
import type { ShenlanConfig } from '@shenlan/core';

export interface MemoryListEntry {
  name: string;
  description: string;
  scope: 'project' | 'global';
}

/** 当前 Auto Memory 开关状态（默认开） */
export function memoryAutoSave(config: ShenlanConfig): boolean {
  return config.memory?.autoSave ?? true;
}

/** /memory on|off — 写回项目 config.json（只动 memory.autoSave，保留其余字段） */
export function setMemoryAutoSave(enabled: boolean, cwd = process.cwd()): { file: string } {
  return updateConfig({ memory: { autoSave: enabled } }, { scope: 'project', cwd });
}

/** 带作用域来源标记的记忆列表（项目优先；文件在项目目录即标记 project） */
export function listMemories(cwd = process.cwd()): MemoryListEntry[] {
  const projectDir = projectMemoryDir(cwd);
  return loadMemories(cwd).map((m) => ({
    name: m.name,
    description: m.description,
    scope: existsSync(join(projectDir, m.file)) ? ('project' as const) : ('global' as const),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** 删除记忆：主题文件 + MEMORY.md 索引行；返回删除的文件路径（找不到返回 null） */
export function removeMemory(
  name: string,
  cwd = process.cwd(),
): { file: string; scope: 'project' | 'global' } | null {
  const entry = listMemories(cwd).find((e) => e.name === name);
  if (!entry) return null;
  const dir = entry.scope === 'project' ? projectMemoryDir(cwd) : globalMemoryDir();
  const file = join(dir, `${name}.md`);
  try {
    unlinkSync(file);
  } catch {
    // 主题文件可能已被外部删除，索引行仍要清理
  }
  removeMemoryIndex(dir, name);
  return { file, scope: entry.scope };
}

/** 平台化打开记忆目录（macOS open / Windows explorer / Linux xdg-open）；目录不存在则先创建 */
export function openMemoryDir(cwd = process.cwd()): Promise<{ opened: boolean; message?: string }> {
  const target = projectMemoryDir(cwd);
  try {
    mkdirSync(target, { recursive: true });
  } catch (err) {
    return Promise.resolve({ opened: false, message: (err as Error).message });
  }
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer'
      : 'xdg-open';
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, [target], { stdio: 'ignore' });
      child.on('error', (err) => resolve({ opened: false, message: err.message }));
      child.on('spawn', () => resolve({ opened: true }));
    } catch (err) {
      resolve({ opened: false, message: (err as Error).message });
    }
  });
}

/**
 * 用 OS 默认关联程序打开指定记忆文件（macOS open / Windows start / Linux xdg-open）。
 * 不 shell out 到 $EDITOR 终端编辑器：全屏编辑器会与 Ink 争 stdin，raw-mode /
 * alt-screen 序列直接威胁 TUI 帧高与清屏序列两条最高优先级约束。
 */
export function editMemory(
  name: string,
  cwd = process.cwd(),
): Promise<{ opened: boolean; message?: string }> {
  const entry = listMemories(cwd).find((e) => e.name === name);
  if (!entry) {
    return Promise.resolve({ opened: false, message: `未找到记忆 "${name}"（/memory list 查看）` });
  }
  const dir = entry.scope === 'project' ? projectMemoryDir(cwd) : globalMemoryDir();
  const file = join(dir, `${name}.md`);
  // Windows 没有直接「用默认程序打开文件」的 exe：start 是 cmd 内置命令，空标题参数防歧义
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => resolve({ opened: false, message: err.message }));
      child.on('spawn', () => resolve({ opened: true }));
    } catch (err) {
      resolve({ opened: false, message: (err as Error).message });
    }
  });
}
