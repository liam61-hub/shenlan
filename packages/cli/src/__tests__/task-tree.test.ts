import { describe, expect, it } from 'vitest';
import type { TodoItem } from '@shenlan/core';
import { taskTreeRows, visibleTaskItems } from '../task-tree.js';

const items: TodoItem[] = [
  { content: 'S1 Verify: build/test/fmt', status: 'completed' },
  { content: 'S1 Commit: implementation and tests', status: 'completed' },
  { content: 'S2 Coverage: HEAD and Range', status: 'completed' },
  { content: 'S2 Commit: coverage', status: 'completed' },
  { content: 'S3 Performance: measure stat overhead', status: 'in_progress' },
  { content: 'S3 Commit: benchmark result', status: 'pending' },
  { content: 'S4 Docs: update README', status: 'pending' },
  { content: 'S4 Commit: docs', status: 'pending' },
];

describe('unified subtask tree', () => {
  it('nests S3 items under S3 while completed S1/S2 remain collapsed', () => {
    const rows = taskTreeRows(items, 10);
    expect(rows.filter(row => row.depth === 0).map(row => row.text)).toEqual([
      '▸ S1 Verify (2/2)', '▸ S2 Coverage (2/2)', '▾ S3 Performance (0/2)', '▸ S4 Docs (0/2)',
    ]);
    const parent = rows.findIndex(row => row.text.includes('▾ S3'));
    expect(rows[parent + 1]).toMatchObject({ depth: 1, text: '5. Performance: measure stat overhead', status: 'in_progress' });
    expect(rows[parent + 2]).toMatchObject({ depth: 1, text: '6. Commit: benchmark result', status: 'pending' });
    expect(rows.some(row => row.text.includes('implementation and tests'))).toBe(false);
  });

  it('supports explicit parent titles and updates the parent status from reported children', () => {
    const grouped: TodoItem[] = [
      { group: 'S3 Performance', content: 'Develop', status: 'completed' },
      { group: 'S3 Performance', content: 'Verify', status: 'in_progress' },
      { group: 'S4 Docs', content: 'Write docs', status: 'pending' },
    ];
    expect(taskTreeRows(grouped, 10)[0]).toMatchObject({ status: 'in_progress', text: '▾ S3 Performance (1/2)' });
    grouped[1]!.status = 'completed';
    const rows = taskTreeRows(grouped, 10);
    expect(rows[0]).toMatchObject({ status: 'completed', text: '▸ S3 Performance (2/2)' });
    expect(rows.some(row => row.text.includes('▾ S4 Docs'))).toBe(true);
  });

  it('keeps the active parent and development item together within the height budget', () => {
    const rows = taskTreeRows(items, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.text).toContain('▾ S3');
    expect(rows[1]?.depth).toBe(1);
    expect(rows[2]?.key).toBe('overflow');
    expect(taskTreeRows(items, 1)[0]?.text).toContain('▾ S3');
  });

  it('uses the latest list without duplicating or reviving stale statuses', () => {
    const plan = [{ step: 'S3 Current', status: 'in_progress' as const }];
    expect(visibleTaskItems(items, plan, 'plan')).toEqual([{ content: 'S3 Current', status: 'in_progress' }]);
    expect(visibleTaskItems(items, plan, 'todos')).toBe(items);
    expect(visibleTaskItems([], plan, 'todos')).toEqual([]);
  });
});
