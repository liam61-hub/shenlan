import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moveToTrash, restoreFromTrash, listTrash, emptyTrash } from '../trash.js';

const testFile = join(process.cwd(), '_trash_test.txt');

describe('trash', () => {
  beforeEach(() => {
    try { unlinkSync(testFile); } catch { /* */ }
    emptyTrash();
  });

  it('moves file to trash', () => {
    writeFileSync(testFile, 'test');
    const result = moveToTrash(testFile);
    expect(result).toBeTruthy();
    expect(result!.id).toBeTruthy();
    expect(existsSync(testFile)).toBe(false);
    const items = listTrash();
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('restores from trash', () => {
    writeFileSync(testFile, 'test content');
    const { id } = moveToTrash(testFile)!;
    expect(existsSync(testFile)).toBe(false);
    const ok = restoreFromTrash(id);
    expect(ok).toBe(true);
    expect(existsSync(testFile)).toBe(true);
    expect(readFileSync(testFile, 'utf-8')).toBe('test content');
  });

  it('returns null for nonexistent file', () => {
    const result = moveToTrash('/nonexistent/file.txt');
    expect(result).toBeNull();
  });

  it('emptyTrash removes all', () => {
    writeFileSync(testFile, 'test');
    moveToTrash(testFile);
    const count = emptyTrash();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(listTrash().length).toBe(0);
  });

  it('listTrash returns empty initially', () => {
    // after beforeEach emptyTrash
    expect(listTrash()).toEqual([]);
  });
});
