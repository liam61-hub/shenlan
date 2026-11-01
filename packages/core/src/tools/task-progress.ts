import { registerTool } from './index.js';
import type { ToolResult } from './index.js';
import { debugLog } from '../debug-logger.js';

export type TaskProgressKind = 'stage' | 'verification' | 'todo' | 'commit';
export type TaskProgressStatus = 'started' | 'in_progress' | 'completed' | 'passed' | 'failed' | 'updated';

export interface TaskProgressEvent {
  kind: TaskProgressKind;
  status: TaskProgressStatus;
  title: string;
  details?: string;
}

let events: TaskProgressEvent[] = [];

export function getTaskProgress(): TaskProgressEvent[] {
  return events.map(event => ({ ...event }));
}

export function clearTaskProgress(): void {
  const previousCount = events.length;
  events = [];
  debugLog('Task progress cleared', { previousCount });
}

const kinds: TaskProgressKind[] = ['stage', 'verification', 'todo', 'commit'];
const statuses: TaskProgressStatus[] = ['started', 'in_progress', 'completed', 'passed', 'failed', 'updated'];

registerTool({
  name: 'task_progress',
  description: 'Record visible task progress in the session history. Emit separate events for stage started, in_progress, and completed so users can follow work as it happens. Also record verification started/passed/failed, Todo updates, and commit started/passed/failed. Record results only after the action finishes; use failed for failures. Keep details concise and never include secrets, full prompts, or user content.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: kinds, description: 'Progress event category' },
      status: { type: 'string', enum: statuses, description: 'Stage: started/in_progress/completed; verification or commit: started/passed/failed; Todo: updated' },
      title: { type: 'string', description: 'Short stage, check, Todo, or commit label' },
      details: { type: 'string', description: 'Optional concise outcome or reason; do not include secrets or user content' },
    },
    required: ['kind', 'status', 'title'],
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const kind = params.kind;
    const status = params.status;
    const title = typeof params.title === 'string' ? params.title.trim() : '';
    if (!kinds.includes(kind as TaskProgressKind) || !statuses.includes(status as TaskProgressStatus) || !title) {
      return { content: 'Invalid task progress event: kind, status, and non-empty title are required', isError: true };
    }
    const allowedStatuses = kind === 'stage'
      ? ['started', 'in_progress', 'completed']
      : kind === 'verification' || kind === 'commit'
        ? ['started', 'passed', 'failed']
        : ['updated'];
    if (!allowedStatuses.includes(status as string)) {
      return { content: `Invalid ${kind} status: use started, passed, or failed`, isError: true };
    }
    const event: TaskProgressEvent = {
      kind: kind as TaskProgressKind,
      status: status as TaskProgressStatus,
      title,
      ...(typeof params.details === 'string' && params.details.trim() ? { details: params.details.trim() } : {}),
    };
    events = [...events, event];
    debugLog('Task progress recorded', {
      eventCount: events.length,
      kindCode: kinds.indexOf(event.kind),
      statusCode: statuses.indexOf(event.status),
    });
    return { content: `Progress recorded: ${event.kind} ${event.status} — ${event.title}${event.details ? ` (${event.details})` : ''}` };
  },
});
