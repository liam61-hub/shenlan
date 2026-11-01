import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConflictError, readFileSnapshot, writeFileAtomically } from '../atomic-file.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shenlan-atomic-file-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomically', () => {
  it('replaces existing content and preserves POSIX permission bits', async () => {
    const target = join(dir, 'script.sh');
    writeFileSync(target, 'old content', 'utf-8');
    if (process.platform !== 'win32') chmodSync(target, 0o751);

    await writeFileAtomically(target, 'new content');

    expect(readFileSync(target, 'utf-8')).toBe('new content');
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o751);
    expect(readdirSync(dir)).toEqual(['script.sh']);
  });

  it('creates a new file through a same-directory temporary file', async () => {
    const target = join(dir, 'new.txt');

    await writeFileAtomically(target, 'created');

    expect(readFileSync(target, 'utf-8')).toBe('created');
    expect(readdirSync(dir)).toEqual(['new.txt']);
  });

  it('refuses to replace content changed since the caller read it', async () => {
    const target = join(dir, 'shared.txt');
    writeFileSync(target, 'original', 'utf-8');
    const expected = await readFileSnapshot(target);
    writeFileSync(target, 'external update', 'utf-8');

    await expect(writeFileAtomically(target, 'agent update', expected)).rejects.toBeInstanceOf(FileConflictError);

    expect(readFileSync(target, 'utf-8')).toBe('external update');
    expect(readdirSync(dir)).toEqual(['shared.txt']);
  });

  it('refuses to create a file if it appeared after the caller observed absence', async () => {
    const target = join(dir, 'created-externally.txt');
    const expected = await readFileSnapshot(target);
    writeFileSync(target, 'external create', 'utf-8');

    await expect(writeFileAtomically(target, 'agent create', expected)).rejects.toBeInstanceOf(FileConflictError);

    expect(readFileSync(target, 'utf-8')).toBe('external create');
    expect(readdirSync(dir)).toEqual(['created-externally.txt']);
  });

  it('serializes same-process writers and rejects the stale queued update', async () => {
    const target = join(dir, 'shared-by-agents.txt');
    writeFileSync(target, 'original', 'utf-8');
    const expected = await readFileSnapshot(target);

    const results = await Promise.allSettled([
      writeFileAtomically(target, 'agent one', expected),
      writeFileAtomically(target, 'agent two', expected),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(FileConflictError);
    expect(['agent one', 'agent two']).toContain(readFileSync(target, 'utf-8'));
    expect(readdirSync(dir)).toEqual(['shared-by-agents.txt']);
  });
});
