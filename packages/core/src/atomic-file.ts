import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export type FileSnapshot =
  | { exists: false }
  | { exists: true; content: string };

export class FileConflictError extends Error {
  constructor(filePath: string) {
    super(`File changed after it was read: ${filePath}`);
    this.name = 'FileConflictError';
  }
}

const pathLocks = new Map<string, Promise<void>>();

async function withPathLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const absolutePath = resolve(filePath);
  const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
  const previous = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  pathLocks.set(key, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathLocks.get(key) === current) pathLocks.delete(key);
  }
}

export async function readFileSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    return { exists: true, content: await readFile(filePath, 'utf-8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

/** Replace a file atomically while retaining the existing POSIX permission bits. */
export async function writeFileAtomically(
  filePath: string,
  content: string,
  expected?: FileSnapshot,
): Promise<void> {
  await withPathLock(filePath, () => writeFileAtomicallyLocked(filePath, content, expected));
}

async function writeFileAtomicallyLocked(
  filePath: string,
  content: string,
  expected?: FileSnapshot,
): Promise<void> {
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(tempPath, 'wx', existingMode ?? 0o666);
    await file.writeFile(content, 'utf-8');
    if (existingMode !== undefined) await file.chmod(existingMode);
    await file.sync();
    await file.close();
    file = undefined;
    if (expected) {
      const current = await readFileSnapshot(filePath);
      if (current.exists !== expected.exists || (current.exists && expected.exists && current.content !== expected.content)) {
        throw new FileConflictError(filePath);
      }
    }
    await rename(tempPath, filePath);
  } catch (error) {
    if (file) {
      try { await file.close(); } catch { /* preserve the original error */ }
    }
    try { await unlink(tempPath); } catch { /* a process crash may leave a temp file */ }
    throw error;
  }
}
