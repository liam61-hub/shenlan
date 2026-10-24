/**
 * 编辑快照 — write/edit 前自动备份，/undo 恢复
 */
import { copyFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_SNAPSHOTS = 20;
const snapshots: Array<{ id: string; file: string; snapshotPath: string; time: Date }> = [];

function getSnapshotDir(): string {
  const dir = join(process.cwd(), '.shenlan', 'snapshots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function takeSnapshot(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const dir = getSnapshotDir();
    const id = randomUUID().slice(0, 8);
    const ext = basename(filePath);
    const snapshotPath = join(dir, `${id}-${ext}`);
    copyFileSync(filePath, snapshotPath);
    snapshots.push({ id, file: filePath, snapshotPath, time: new Date() });
    while (snapshots.length > MAX_SNAPSHOTS) {
      const old = snapshots.shift()!;
      try { unlinkSync(old.snapshotPath); } catch { /* ignore */ }
    }
    return id;
  } catch {
    return null;
  }
}

export function undoS(): { file: string; time: Date } | null {
  const s = snapshots.pop();
  if (!s) return null;
  try {
    copyFileSync(s.snapshotPath, s.file);
    try { unlinkSync(s.snapshotPath); } catch { /* ignore */ }
    return { file: s.file, time: s.time };
  } catch {
    snapshots.push(s);
    return null;
  }
}

export function snapshotCount(): number {
  return snapshots.length;
}

export function listSnapshots(): Array<{ id: string; file: string; time: Date }> {
  return snapshots.map(s => ({ id: s.id, file: s.file, time: s.time }));
}
