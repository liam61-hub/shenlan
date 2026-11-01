import { describe, expect, it } from 'vitest';
import { ProgressCheck } from '../progress-check.js';

describe('progress reconciliation', () => {
  it('requests a status check after eight calls without a checklist update', () => {
    const check = new ProgressCheck();
    check.observe('update_plan', { plan: [{ status: 'in_progress' }, { status: 'pending' }] }, true);
    for (let i = 0; i < 7; i++) check.observe('read', {}, true);
    expect(check.takeReminder()).toBe(false);
    check.observe('shell', {}, true);
    expect(check.takeReminder()).toBe(true);
    expect(check.takeReminder()).toBe(false);
  });
  it('requests a checklist update on a stage event but not when updated in the same batch', () => {
    const check = new ProgressCheck({ update_plan: true });
    check.observe('task_progress', { kind: 'stage', status: 'completed' }, true);
    expect(check.takeReminder()).toBe(true);
    check.observe('task_progress', { kind: 'stage', status: 'started' }, true);
    check.observe('todo_write', { todos: [{ status: 'in_progress' }] }, true);
    expect(check.takeReminder()).toBe(false);
  });
  it('ignores failed updates and stops reminders when the list is complete', () => {
    const check = new ProgressCheck({ update_plan: true });
    check.observe('task_progress', { kind: 'stage' }, true);
    check.observe('update_plan', { plan: [{ status: 'completed' }] }, false);
    expect(check.takeReminder()).toBe(true);
    check.observe('update_plan', { plan: [{ status: 'completed' }] }, true);
    for (let i = 0; i < 10; i++) check.observe('shell', {}, true);
    expect(check.takeReminder()).toBe(false);
  });

  it('keeps reminders active when another checklist is unfinished', () => {
    const check = new ProgressCheck({ update_plan: true, todo_write: true });
    check.observe('update_plan', { plan: [{ status: 'completed' }] }, true);
    for (let i = 0; i < 8; i++) check.observe('read', {}, true);
    expect(check.takeReminder()).toBe(true);
  });
});
