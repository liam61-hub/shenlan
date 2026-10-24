/**
 * 引用工具 — ref_outline / ref_retrieve
 */
import { registerTool } from './index.js';
import { listRefs, retrieveRef } from '../ref-store.js';

registerTool({
  name: 'ref_outline',
  description: 'List all stored reference IDs and summaries. Use to find relevant stored data.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_params?, _signal?) {
    const refs = listRefs();
    if (refs.length === 0) return { content: 'No stored references' };
    const lines = refs.map(r => `  [${r.refId}] ${r.summary.slice(0, 100)}`);
    return { content: `${refs.length} reference(s):\n${lines.join('\n')}` };
  },
});

registerTool({
  name: 'ref_retrieve',
  description: 'Retrieve full content of a stored reference by its ID.',
  inputSchema: {
    type: 'object',
    properties: {
      ref_id: { type: 'string', description: 'Reference ID from ref_outline' },
    },
    required: ['ref_id'],
  },
  async execute(params, _signal?) {
    const refId = params.ref_id as string;
    const content = retrieveRef(refId);
    if (!content) return { content: `Reference "${refId}" not found or expired`, isError: true };
    return { content };
  },
});
