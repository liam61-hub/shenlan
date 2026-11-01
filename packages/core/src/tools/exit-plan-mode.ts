import { getTool, registerTool, unregisterTool } from './index.js';

const TOOL_NAME = 'exit_plan_mode';

/** Make the explicit Plan-to-implementation handoff available to the model. */
export function registerExitPlanModeTool(): void {
  if (getTool(TOOL_NAME)) return;
  registerTool({
    name: TOOL_NAME,
    description: 'Request user approval to leave Plan mode and choose implementation permissions. Call this when the plan is ready. Never begin implementation before the user selects a mode.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { content: 'Plan implementation approved. Continue with the implementation.' };
    },
  });
}

export function unregisterExitPlanModeTool(): void {
  unregisterTool(TOOL_NAME);
}
