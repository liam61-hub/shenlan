export const PROGRESS_CHECK_MESSAGE = '[Progress check] Before continuing substantive work, reconcile the full task checklist with verified results. Update update_plan and/or todo_write for each active list, marking completed items only after their required implementation, verification, documentation and commit work is finished. Set the actual current item in_progress. If still working on the same item, retain its status and briefly report what remains. task_progress events alone do not update either list.';

/** Request explicit status reconciliation; never infer completion from tool activity. */
export class ProgressCheck {
  private calls = 0;
  private stageChanged = false;
  constructor(private lists: Record<string, boolean> = {}) {}

  private get active(): boolean { return Object.values(this.lists).some(Boolean); }

  observe(name: string, args: Record<string, unknown>, success: boolean): void {
    if (!success) return;
    if (name === 'todo_write' || name === 'update_plan') {
      const items = args[name === 'todo_write' ? 'todos' : 'plan'];
      if (!Array.isArray(items)) return;
      this.lists[name] = items.some(item => item && typeof item === 'object' && item.status !== 'completed');
      this.calls = 0;
      this.stageChanged = false;
      return;
    }
    if (!this.active) return;
    this.calls++;
    if (name === 'task_progress' && args.kind === 'stage') this.stageChanged = true;
  }

  takeReminder(): boolean {
    if (!this.active || (!this.stageChanged && this.calls < 8)) return false;
    this.calls = 0;
    this.stageChanged = false;
    return true;
  }
}
