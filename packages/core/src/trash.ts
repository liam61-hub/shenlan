/**
 * 回收站 — 删除文件先移动到 .shenlan/trash/
 */
import { renameSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

interface TrashEntry {
  id: string;
  originalPath: string;
  trashPath: string;
  deletedAt: string;
  size: number;
}

function getTrashDir(): string {
  const dir = join(process.cwd(), '.shenlan', 'trash');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getTrashMeta(): string {
  return join(getTrashDir(), '.meta.json');
}

function loadMeta(): TrashEntry[] {
  try {
    if (existsSync(getTrashMeta())) {
      return JSON.parse(readFileSync(getTrashMeta(), 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveMeta(entries: TrashEntry[]): void {
  writeFileSync(getTrashMeta(), JSON.stringify(entries, null, 2), 'utf-8');
}

/** 移动文件到回收站 */
export function moveToTrash(filePath: string): { id: string } | null {
  try {
    if (!existsSync(filePath)) return null;

    const dir = getTrashDir();
    const id = randomUUID().slice(0, 8);
    const trashPath = join(dir, `${id}-${basename(filePath)}`);
    const st = statSync(filePath);

    renameSync(filePath, trashPath);

    const entry: TrashEntry = {
      id,
      originalPath: filePath,
      trashPath,
      deletedAt: new Date().toISOString(),
      size: st.size,
    };

    const meta = loadMeta();
    meta.push(entry);
    saveMeta(meta);

    return { id };
  } catch {
    return null;
  }
}

/** 从回收站恢复 */
export function restoreFromTrash(id: string): boolean {
  const meta = loadMeta();
  const idx = meta.findIndex(e => e.id === id);
  if (idx === -1) return false;

  const entry = meta[idx];
  try {
    renameSync(entry.trashPath, entry.originalPath);
    meta.splice(idx, 1);
    saveMeta(meta);
    return true;
  } catch {
    return false;
  }
}

/** 列出回收站内容 */
export function listTrash(): TrashEntry[] {
  return loadMeta();
}

/** 永久清空回收站 */
export function emptyTrash(): number {
  const meta = loadMeta();
  let count = 0;
  for (const entry of meta) {
    try { unlinkSync(entry.trashPath); count++; } catch { /* skip */ }
  }
  saveMeta([]);
  return count;
}
