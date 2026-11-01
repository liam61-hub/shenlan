/**
 * 子 Agent 并行编排 — /agents 命令
 *
 * 拆解任务 → 并发执行子任务 → 合并结果
 */
import type { ShenlanConfig } from '@shenlan/core';
import { runSubTask } from '@shenlan/core';
import type { SubTaskProgress } from '@shenlan/core';
import { getEffectiveModel } from './router.js';

interface SubTask {
  id: number;
  goal: string;
  input: string;
}

interface SubTaskResult {
  id: number;
  goal: string;
  summary: string;
  success: boolean;
  cost: { promptTokens: number; completionTokens: number };
}

/** 确定性拆解器：按段落或编号拆分子任务 */
function decomposeTask(task: string): SubTask[] {
  // 按编号列表拆解: 1. xxx 2. xxx
  const numbered = task.match(/\d+[\.\)、]\s*.+/g);
  if (numbered && numbered.length >= 2) {
    return numbered.map((t, i) => ({
      id: i + 1,
      goal: t.replace(/^\d+[\.\)、]\s*/, '').slice(0, 100),
      input: t.trim(),
    }));
  }

  // 按空行拆解
  const paragraphs = task.split(/\n{2,}/).filter(Boolean);
  if (paragraphs.length >= 2) {
    return paragraphs.map((p, i) => ({
      id: i + 1,
      goal: p.slice(0, 100),
      input: p.trim(),
    }));
  }

  // 单一任务
  return [{ id: 1, goal: task.slice(0, 100), input: task }];
}

/** 执行子 Agent 并行编排 */
export async function runAgents(
  task: string,
  config: ShenlanConfig,
  onProgress?: (message: string) => void,
): Promise<string> {
  const subtasks = decomposeTask(task);
  if (subtasks.length <= 1) {
    return 'Task cannot be decomposed — try providing numbered sub-tasks (e.g. "1. Analyze frontend 2. Analyze backend")';
  }

  // 子 agent 跟随实际生效模型（sticky 路由优先），保证 qwen 环境下不打到 deepseek 端点
  const model = getEffectiveModel();
  const startTime = Date.now();

  // 并发执行
  onProgress?.(`Split into ${subtasks.length} sub-tasks; starting them in parallel.`);
  const results = await Promise.all(subtasks.map((s) => runSubTask(
    s.input,
    s.goal,
    config,
    model,
    20,
    undefined,
    (progress: SubTaskProgress) => {
      onProgress?.(`Task ${s.id}/${subtasks.length} · ${s.goal}: ${progressText(progress)}`);
    },
  )));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const successCount = results.filter(r => r.success).length;

  let output = `## ${successCount}/${results.length} sub-tasks completed in ${elapsed}s\n\n`;

  for (const r of results) {
    const icon = r.success ? '✓' : '✗';
    output += `- ${icon} **${r.goal}**\n  ${r.summary.slice(0, 200)}\n`;
  }

  return output;
}

function progressText(progress: SubTaskProgress): string {
  switch (progress.kind) {
    case 'started': return 'started';
    case 'round': return `${progress.title} in progress`;
    case 'tool': return `working on ${progress.title}`;
    case 'stage': return progress.title;
  }
}
