/**
 * 计划落盘 — 把当前结构化计划（update_plan 产物）保存为 Markdown
 *
 * 对齐产品规划 Plan Mode：`/plan save` 存 `.shenlan/plans/<时间戳>-<标题>.md`，
 * 含会话 / 模型 / 工作目录等元数据。可选操作，默认不自动落盘。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlan } from './tools/plan.js';
import type { PlanItem } from './tools/plan.js';

export interface PlanSaveMeta {
  /** 计划标题（缺省用 'plan'；会做文件名字符清洗） */
  title?: string;
  sessionId?: string;
  model?: string;
  cwd?: string;
}

export interface SavedPlan {
  /** 绝对路径 */
  path: string;
  /** 文件名 */
  filename: string;
  /** 步骤数 */
  steps: number;
}

/** 标题清洗：去路径分隔符与非法字符，空白折叠为 `-`，截断到 60 字符 */
export function sanitizePlanTitle(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (cleaned || 'plan').slice(0, 60);
}

/** 状态标记（与 DynamicRegion 一致） */
function statusMark(status: PlanItem['status']): string {
  switch (status) {
    case 'completed': return '[x]';
    case 'in_progress': return '[→]';
    default: return '[ ]';
  }
}

/** 渲染计划 Markdown */
export function renderPlanMarkdown(plan: PlanItem[], meta: PlanSaveMeta, timestamp: string): string {
  const title = meta.title?.trim() || 'Plan';
  const lines: string[] = [
    `# ${title}`,
    '',
  ];
  const metaRows: string[] = [`- 生成时间: ${timestamp}`];
  if (meta.sessionId) metaRows.push(`- 会话: ${meta.sessionId}`);
  if (meta.model) metaRows.push(`- 模型: ${meta.model}`);
  if (meta.cwd) metaRows.push(`- 工作目录: ${meta.cwd}`);
  const pending = plan.filter(p => p.status === 'pending').length;
  const inProgress = plan.filter(p => p.status === 'in_progress').length;
  const completed = plan.filter(p => p.status === 'completed').length;
  metaRows.push(`- 进度: ${completed} 完成 · ${inProgress} 进行中 · ${pending} 待办`);
  lines.push(...metaRows, '', '## 执行步骤', '');
  plan.forEach((item, i) => {
    lines.push(`${i + 1}. ${statusMark(item.status)} ${item.step}`);
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * 把当前计划保存为 Markdown 文件。
 * 无计划时抛错（调用方转为友好提示）。
 */
export function savePlan(dir: string, meta: PlanSaveMeta = {}): SavedPlan {
  const plan = getPlan();
  if (plan.length === 0) {
    throw new Error('No plan to save — enter /plan and let the model draft a plan first');
  }
  const title = sanitizePlanTitle(meta.title || 'plan');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `${timestamp}-${title}.md`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, renderPlanMarkdown(plan, meta, timestamp), 'utf-8');
  return { path, filename, steps: plan.length };
}
