import { maskSensitive } from '@shenlan/core';
import { truncateWidth } from './tool-summary.js';

export interface ShellActivity {
  kind: 'test' | 'verification' | 'commit';
  label: string;
}

export interface ShellActivityEvent {
  id: string;
  activities: ShellActivity[];
  phase: 'started' | 'finished';
  output?: string;
  failed?: boolean;
}

/** Display classification only; never use this parser to authorize a command. */
export function shellActivities(command: string, depth = 0): ShellActivity[] {
  if (depth > 3) return [];
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|\n]|[^\s;|]+/g) ?? [];
  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (/^(?:&&|\|\||[;|\n])$/.test(token)) groups.push([]);
    else groups.at(-1)!.push(token);
  }
  const unquote = (word: string) => word.replace(/^(['"])([\s\S]*)\1$/, '$2');
  const executable = (word: string) => unquote(word).split(/[\\/]/).at(-1)!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  const found: ShellActivity[] = [];
  for (const group of groups) {
    if (!group.length) continue;
    const first = executable(group[0]!);
    if (['wsl', 'bash', 'sh', 'pwsh', 'powershell', 'cmd'].includes(first)) {
      const flag = group.findIndex(token => /^-(?:lc|c|command)$/i.test(token) || /^\/c$/i.test(token));
      if (flag >= 0 && group[flag + 1]) {
        found.push(...shellActivities(unquote(group[flag + 1]!), depth + 1));
      }
      continue;
    }
    let subcommand = 1;
    if (first === 'git') {
      while (['-C', '-c', '--git-dir', '--work-tree'].includes(group[subcommand] ?? '')) subcommand += 2;
      if (group[subcommand] === 'commit') found.push({ kind: 'commit', label: 'git commit' });
    } else if (first === 'cargo' && ['test', 'build', 'check', 'clippy', 'fmt'].includes(group[1] ?? '')) {
      found.push({ kind: group[1] === 'test' ? 'test' : 'verification', label: `cargo ${group[1]}` });
    } else if (['npm', 'pnpm', 'yarn'].includes(first)) {
      const script = group[1] === 'run' ? group[2] : group[1];
      if (/^(?:test(?::[\w-]+)?|build|typecheck|lint|check)$/.test(script ?? '')) {
        found.push({ kind: script!.startsWith('test') ? 'test' : 'verification', label: `${first} ${group[1] === 'run' ? 'run ' : ''}${script}` });
      }
    } else if (['vitest', 'pytest'].includes(first) || (first === 'npx' && group[1] === 'vitest')) {
      found.push({ kind: 'test', label: first === 'npx' ? 'npx vitest' : first });
    }
  }
  return found.filter((activity, index) => found.findIndex(other => other.label === activity.label) === index);
}

/** Keep decisive evidence rather than only the first output line (often a hook banner). */
export function shellActivityLines(event: ShellActivityEvent): { lines: string[]; failed: boolean } {
  const label = event.activities.map(activity => activity.label).join(' / ');
  if (event.phase === 'started') return { lines: [`${label} started`], failed: false };
  const output = maskSensitive(event.output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const background = /still running in the background|^\[bg-[^\]]+\] running/m.test(output);
  const failed = !background && (!!event.failed || /test result: FAILED|^FAIL(?:ED)?\b|^fatal:|^error:|Command (?:exited with code|failed to start)|^\[bg-[^\]]+\] (?:failed|killed)/im.test(output));
  const evidence = output.split(/\r?\n/).map(line => line.trim())
    .map(line => line.startsWith('[bg-') ? line.split(' — ')[0]! : line).filter(Boolean);
  const decisive = evidence.filter(line =>
    /test result:|Tests?\s+(?:Files|Suites|Cases)?\s*\d*.*(?:pass|fail)|\b\d+ (?:passed|failed)|^\[[^\]]+ [a-f0-9]{7,40}\]|files? changed|Finished .*target|^FAIL(?:ED)?\b|^fatal:|^error:|Command (?:exited|failed|timed out)|^\[bg-/i.test(line),
  );
  const details = decisive.length ? [...decisive].sort((left, right) => {
    const priority = (line: string) => /^\[[^\]]+ [a-f0-9]{7,40}\]|test result: FAILED|^FAIL(?:ED)?\b|^fatal:|^error:|Command (?:exited|failed|timed out)|^\[bg-/i.test(line) ? 0 : 1;
    return priority(left) - priority(right);
  }) : evidence.slice(0, 3);
  const lines = [`${label} ${background ? 'running in background' : failed ? 'failed' : 'finished'}`,
    ...details.slice(0, 8).map(line => truncateWidth(line, 140))];
  if (details.length > 8) lines.push(`… +${details.length - 8} result lines`);
  return { lines, failed };
}
