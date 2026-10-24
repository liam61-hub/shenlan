import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { takeSnapshot, undoS, snapshotCount } from '../snapshot.js';

const testDir = join(process.cwd(), '.shenlan', 'snapshots');

describe('snapshot', () => {
  const testFile = join(process.cwd(), '_test_snap.txt');

  beforeEach(() => {
    // Clean up
    try { unlinkSync(testFile); } catch { /* */ }
    try { rmSync(testDir, { recursive: true }); } catch { /* */ }
  });

  it('returns null for non-existent file', () => {
    const result = takeSnapshot('/nonexistent/file.txt');
    expect(result).toBeNull();
  });

  it('takes snapshot of existing file', () => {
    writeFileSync(testFile, 'original content');
    const id = takeSnapshot(testFile);
    expect(id).toBeTruthy();
    expect(snapshotCount()).toBeGreaterThanOrEqual(1);
  });

  it('undo restores snapshot', () => {
    writeFileSync(testFile, 'original content');
    takeSnapshot(testFile);
    writeFileSync(testFile, 'modified content');
    const result = undoS();
    expect(result).toBeTruthy();
    const content = readFileSync(testFile, 'utf-8');
    expect(content).toBe('original content');
  });

  it('undo returns null when no snapshots', () => {
    const result = undoS();
    expect(result).toBeNull();
  });
});
