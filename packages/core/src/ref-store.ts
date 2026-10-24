/**
 * 工具结果引用外置（ToolResultRefStore）
 *
 * 大输出落盘存引用，上下文只留 refId + 摘要
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface RefEntry {
  refId: string;
  summary: string;
  file: string;
  created: Date;
}

const refs = new Map<string, RefEntry>();

function getRefDir(): string {
  const dir = join(process.cwd(), '.shenlan', 'refs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 存储大结果到引用 */
export function storeRef(content: string, summary: string): { refId: string; summary: string } {
  const refId = randomUUID().slice(0, 8);
  const dir = getRefDir();
  const file = join(dir, `${refId}.txt`);
  writeFileSync(file, content, 'utf-8');

  refs.set(refId, { refId, summary, file, created: new Date() });
  return { refId, summary };
}

/** 按 refId 取回全文 */
export function retrieveRef(refId: string): string | null {
  const entry = refs.get(refId);
  if (!entry || !existsSync(entry.file)) return null;
  try {
    return readFileSync(entry.file, 'utf-8');
  } catch {
    return null;
  }
}

/** 列出所有引用 */
export function listRefs(): Array<{ refId: string; summary: string }> {
  return Array.from(refs.values()).map(r => ({ refId: r.refId, summary: r.summary }));
}

/** 清理过期引用 */
export function cleanupRefs(): number {
  let count = 0;
  for (const [id, entry] of refs) {
    try { unlinkSync(entry.file); count++; } catch { /* skip */ }
    refs.delete(id);
  }
  return count;
}
