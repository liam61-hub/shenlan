import { beforeEach, describe, expect, it } from 'vitest';
import '../tools/task-progress.js';
import { getTool } from '../tools/index.js';
import { clearTaskProgress, getTaskProgress } from '../tools/task-progress.js';

const tool = getTool('task_progress')!;

describe('task_progress tool', () => {
  beforeEach(() => clearTaskProgress());

  it('records ordered stage, verification, todo, and commit events', async () => {
    for (const event of [
      { kind: 'stage', status: 'started', title: 'Implementation' },
      { kind: 'stage', status: 'in_progress', title: 'Implementation' },
      { kind: 'verification', status: 'started', title: 'Tests' },
      { kind: 'verification', status: 'failed', title: 'Tests', details: 'one failed' },
      { kind: 'todo', status: 'updated', title: 'Review' },
      { kind: 'commit', status: 'passed', title: 'Commit created' },
    ]) await tool.execute(event);

    expect(getTaskProgress().map(({ kind, status }) => `${kind}:${status}`)).toEqual([
      'stage:started', 'stage:in_progress', 'verification:started', 'verification:failed', 'todo:updated', 'commit:passed',
    ]);
    expect(getTaskProgress()[3]?.details).toBe('one failed');
  });

  it('rejects invalid events and prevents false verification or commit statuses', async () => {
    expect((await tool.execute({ kind: 'verification', status: 'completed', title: 'Tests' })).isError).toBe(true);
    expect((await tool.execute({ kind: 'commit', status: 'completed', title: 'Commit' })).isError).toBe(true);
    expect((await tool.execute({ kind: 'stage', status: 'failed', title: 'Build' })).isError).toBe(true);
    expect((await tool.execute({ kind: 'todo', status: 'completed', title: 'Todo' })).isError).toBe(true);
    expect((await tool.execute({ kind: 'stage', status: 'started', title: ' ' })).isError).toBe(true);
    expect(getTaskProgress()).toEqual([]);
  });

  it('returns a copy and can clear the event state', async () => {
    await tool.execute({ kind: 'stage', status: 'completed', title: 'Done' });
    const copy = getTaskProgress();
    copy[0]!.title = 'mutated';
    expect(getTaskProgress()[0]?.title).toBe('Done');
    clearTaskProgress();
    expect(getTaskProgress()).toEqual([]);
  });
});
