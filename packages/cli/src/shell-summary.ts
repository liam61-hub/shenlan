import { diffLines } from 'diff';

export interface ShellSummary {
  command: string;
  output: string;
  runs: number;
}

/** Merge only adjacent executions of the exact same trimmed command. */
export function mergeAdjacentShellResults(
  items: ShellSummary[],
  command: string,
  output: string,
): ShellSummary[] {
  const normalized = command.trim();
  const last = items.at(-1);
  if (last?.command === normalized) {
    return [...items.slice(0, -1), { command: normalized, output, runs: last.runs + 1 }];
  }
  return [...items, { command: normalized, output, runs: 1 }];
}

/** Compact repeated output to only changed lines; unchanged output stays implicit. */
export function formatShellOutputChange(previous: string, current: string): string {
  const changes = diffLines(previous, current);
  const lines = changes.flatMap(change => {
    if (!change.added && !change.removed) return [];
    return change.value.split('\n').filter(Boolean).map(line => `${change.added ? '+' : '-'} ${line}`);
  });
  return lines.length ? lines.join('\n') : '(no output changes)';
}
