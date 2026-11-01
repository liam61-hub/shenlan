import { describe, expect, it } from 'vitest';
import { formatShellOutputChange, mergeAdjacentShellResults } from '../shell-summary.js';

describe('shell summary', () => {
  it('merges only adjacent identical commands', () => {
    const first = mergeAdjacentShellResults([], ' git status ', ' M a');
    const repeated = mergeAdjacentShellResults(first, 'git status', ' M a\n M b');
    const separated = mergeAdjacentShellResults(repeated, 'git diff', 'diff');
    const later = mergeAdjacentShellResults(separated, 'git status', ' M c');
    expect(repeated).toEqual([{ command: 'git status', output: ' M a\n M b', runs: 2 }]);
    expect(later).toHaveLength(3);
    expect(later[2]?.runs).toBe(1);
  });

  it('shows only added and removed output lines', () => {
    expect(formatShellOutputChange('same\nold\n', 'same\nnew\n')).toBe('- old\n+ new');
    expect(formatShellOutputChange('same\n', 'same\n')).toBe('(no output changes)');
  });
});
