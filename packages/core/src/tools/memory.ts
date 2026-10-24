/**
 * memory_save — 保存跨会话记忆（Claude Code Auto Memory 对齐）
 *
 * 模型侧自主判断：发现对未来会话有用的持久事实，或用户明确说
 * 「记住 xxx / 以后都用 xxx」时保存；不保存临时任务细节。
 * scope=project（默认）只对当前项目生效；scope=global 仅用于跨项目
 * 通用偏好（如「始终用 pnpm」）。mode=replace（默认）整体重写，
 * mode=append 追加到既有正文（累积性事实用 append，纠错才用 replace）。
 * 删除只走用户侧 /memory rm + 确认。
 */
import { registerTool } from './index.js';
import type { ToolResult } from './index.js';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debugLog } from '../debug-logger.js';
import { loadMemories, updateMemoryIndex, globalMemoryDir, projectMemoryDir } from '../memory.js';

/** 记忆名只允许小写字母/数字/连字符，天然防路径穿越 */
const NAME_RE = /^[a-z0-9-]+$/;
/** 正文上限（超长截断，去重 + 截断即护栏） */
const CONTENT_MAX = 6000;
/** description 单行摘要上限 */
const DESCRIPTION_MAX = 300;

registerTool({
  name: 'memory_save',
  description:
    'Save a persistent memory for future sessions (Claude Code style auto memory). Use when the user states a durable preference or fact worth remembering ("记住 xxx", "以后都用 xxx"), or when you discover a stable project fact. Do NOT save transient task details. scope=project (default) for this project; scope=global only for cross-project preferences (e.g. "始终用 pnpm"). Discipline: save at natural task boundaries; for an existing topic use mode="append" to extend it instead of creating a near-duplicate entry (use replace, the default, only to correct); never store secrets/tokens.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Unique memory name — lowercase letters, digits, hyphens only (e.g. project-style)',
      },
      description: {
        type: 'string',
        description: 'One-line summary shown in the MEMORY.md index',
      },
      content: {
        type: 'string',
        description: 'Memory body in Markdown (truncated to 6000 chars, applied after append)',
      },
      mode: {
        type: 'string',
        enum: ['replace', 'append'],
        description: 'replace (default): rewrite the whole memory body; append: add to the end of the existing body — use for cumulative facts, not for corrections',
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'project (default) or global',
      },
    },
    required: ['name', 'description', 'content'],
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const name = String(params.name ?? '').trim();
    if (!NAME_RE.test(name)) {
      return {
        content: `Invalid memory name "${name}": only lowercase letters, digits, hyphens allowed`,
        isError: true,
      };
    }

    const description = String(params.description ?? '').trim();
    if (!description) {
      return { content: 'Invalid memory description: required', isError: true };
    }

    const rawScope = params.scope;
    const scope = rawScope === undefined ? 'project' : rawScope;
    if (scope !== 'project' && scope !== 'global') {
      return {
        content: `Invalid scope "${String(scope)}": must be "project" or "global"`,
        isError: true,
      };
    }

    const mode = params.mode === undefined ? 'replace' : params.mode;
    if (mode !== 'replace' && mode !== 'append') {
      return {
        content: `Invalid mode "${String(mode)}": must be "replace" or "append"`,
        isError: true,
      };
    }

    let content = String(params.content ?? '');
    // append：并入既有正文再截断 —— CONTENT_MAX 必须在追加之后执行，
    // 否则「先截断再拼接」会让追加路径绕开上限
    if (mode === 'append') {
      try {
        const prev = readFileSync(join(
          scope === 'global' ? globalMemoryDir() : projectMemoryDir(process.cwd()),
          `${name}.md`,
        ), 'utf-8');
        const match = prev.match(/^---\nname:\s*(.+)\ndescription:\s*(.+)\n---\n(.*)/s);
        if (match) content = `${match[3].trim()}\n\n${content}`;
      } catch { /* 文件不存在 → 等同新建 */ }
    }
    if (content.length > CONTENT_MAX) {
      content = `${content.slice(0, CONTENT_MAX)}\n\n...(truncated)`;
    }

    const dir = scope === 'global' ? globalMemoryDir() : projectMemoryDir(process.cwd());
    const filePath = join(dir, `${name}.md`);
    const body = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;

    try {
      await mkdir(dir, { recursive: true });
      // 原子写：先写临时文件再 rename，避免写一半崩溃留下残缺记忆文件
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, body, 'utf-8');
      await rename(tmp, filePath);
    } catch (err) {
      return { content: `Failed to save memory: ${(err as Error).message}`, isError: true };
    }

    updateMemoryIndex(dir, name, description);
    const total = loadMemories(process.cwd()).length;
    debugLog('Memory save', { name, scope, filePath, total });

    return {
      content: `Saved memory to ${filePath} (scope: ${scope}) — ${total} memories total`,
    };
  },
});
