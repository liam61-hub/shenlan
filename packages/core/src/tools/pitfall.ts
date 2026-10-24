/**
 * 坑记忆搜索工具 — 结构化核心（pitfall-store）之上的检索接口
 *
 * 检索范围：全局（configDir/pitfalls.md）+ 项目（.shenlan/pitfalls.md），
 * 按 severity（hard 先）+ hits 降序返回。
 */
import { registerTool } from './index.js';
import { loadPitfalls, searchPitfalls } from '../pitfall-store.js';

registerTool({
  name: 'pitfall_search',
  description: 'Search pitfall records by trigger or symptom. Call before critical write/edit/exec actions. Returns matching pitfalls with severity and rules.',
  inputSchema: {
    type: 'object',
    properties: {
      trigger: {
        type: 'string',
        description: 'File path pattern, command, or tech stack to search for',
      },
      symptom: {
        type: 'string',
        description: 'Error pattern or symptom to match',
      },
    },
  },
  async execute(params, _signal?) {
    const trigger = (params.trigger as string) || '';
    const symptom = (params.symptom as string) || '';

    const entries = loadPitfalls(process.cwd());
    const results = searchPitfalls(entries, { trigger, symptom });

    if (results.length === 0) {
      return { content: `No pitfalls found matching trigger="${trigger}" symptom="${symptom}"` };
    }
    const formatted = results.map((e) => {
      const tag = e.severity === 'hard' ? '[hard]' : '[soft]';
      const head = `# ${e.title} ${tag} hits=${e.hits} (${e.source})`;
      const ruleLine = e.rule ? `\nrule: ${e.rule}` : '';
      const bodyLines = e.body.split('\n').filter((l) => !/^(severity|hits|trigger|symptom|rule):/i.test(l) && !l.startsWith('# ')).join('\n').trim();
      return `${head}${ruleLine}\n${bodyLines.slice(0, 300)}`;
    });
    return { content: `Found ${results.length} pitfall(s):\n\n${formatted.join('\n\n---\n\n')}` };
  },
});
