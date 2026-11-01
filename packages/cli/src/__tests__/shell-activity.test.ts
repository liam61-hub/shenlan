import { describe, expect, it } from 'vitest';
import { shellActivities, shellActivityLines } from '../shell-activity.js';

describe('shell execution activity', () => {
  it('recognizes wrapped checks and commits without parsing commit messages as commands', () => {
    expect(shellActivities('wsl -d Ubuntu -- bash -lc "cd /project && cargo test 2>&1 | tail -50"'))
      .toEqual([{ kind: 'test', label: 'cargo test' }]);
    expect(shellActivities('git -C "D:/my project" commit -m "fix: cargo test; npm test"'))
      .toEqual([{ kind: 'commit', label: 'git commit' }]);
    expect(shellActivities('echo "cargo test"')).toEqual([]);
    expect(shellActivities('git status')).toEqual([]);
    expect(shellActivities('npm run build && npm test').map(activity => activity.label)).toEqual(['npm run build', 'npm test']);
  });

  it('preserves commit evidence after a successful hook banner', () => {
    const result = shellActivityLines({ id: 'commit', activities: shellActivities('git commit -m fix'), phase: 'finished',
      output: 'Scan passed\n[main f3714bc] test: cover try_files\n 1 file changed, 156 insertions(+)' });
    expect(result.lines).toContain('[main f3714bc] test: cover try_files');
    expect(result.lines).not.toContain('Scan passed');
    expect(result.failed).toBe(false);
  });

  it('keeps test summaries and failure evidence even when a pipeline exits successfully', () => {
    const result = shellActivityLines({ id: 'tests', activities: shellActivities('cargo test | tail -50'), phase: 'finished',
      output: 'Compiling project\ntest result: ok. 132 passed; 0 failed\ntest result: FAILED. 4 passed; 1 failed', failed: false });
    expect(result.failed).toBe(true);
    expect(result.lines[0]).toBe('cargo test failed');
    expect(result.lines.join(' ')).toContain('132 passed');
    expect(result.lines.join(' ')).toContain('1 failed');
  });

  it('does not report background execution as finished or passed', () => {
    const result = shellActivityLines({ id: 'tests', activities: shellActivities('cargo test'), phase: 'finished', failed: true,
      output: 'Command timed out after 120 seconds — still running in the background (id: bg-123)' });
    expect(result.lines[0]).toBe('cargo test running in background');
    expect(result.failed).toBe(false);
    expect(result.lines.join(' ')).toContain('bg-123');
  });

  it('redacts returned secrets and does not invent success evidence for quiet commits', () => {
    const result = shellActivityLines({ id: 'commit', activities: shellActivities('git commit -q'), phase: 'finished',
      output: 'password=fixture' });
    expect(result.lines.join(' ')).not.toContain('fixture');
    expect(result.lines[0]).toBe('git commit finished');
    expect(result.lines.join(' ')).not.toContain('[main');
  });
});

it('keeps commit evidence visible after many test suites', () => {
  const output = Array.from({ length: 20 }, () => 'test result: ok. 5 passed; 0 failed').join('\n')
    + '\n[main abc1234] fix: verified change';
  const result = shellActivityLines({ id: 'combined', activities: shellActivities('cargo test && git commit -m fix'), phase: 'finished', output });
  expect(result.lines.join(' ')).toContain('[main abc1234]');
  expect(result.lines.length).toBeLessThanOrEqual(10);
});

it('retains background completion evidence without repeating command arguments', () => {
  const result = shellActivityLines({ id: 'poll', activities: shellActivities('cargo test'), phase: 'finished',
    output: '[bg-123] completed (exit 0) — 150s elapsed — cargo test --private-argument\ntest result: ok. 5 passed; 0 failed' });
  expect(result.lines.join(' ')).toContain('completed (exit 0)');
  expect(result.lines.join(' ')).toContain('5 passed');
  expect(result.lines.join(' ')).not.toContain('--private-argument');
});
