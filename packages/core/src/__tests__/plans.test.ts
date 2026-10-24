import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../tools/plan.js';
import { getTool } from '../tools/index.js';
import { clearPlan } from '../tools/plan.js';
import { savePlan, renderPlanMarkdown, sanitizePlanTitle } from '../plans.js';

let dir: string;

beforeEach(() => {
  clearPlan();
  dir = mkdtempSync(join(tmpdir(), 'shenlan-plans-'));
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('sanitizePlanTitle', () => {
  it('清洗路径分隔符与非法字符', () => {
    expect(sanitizePlanTitle('修复 /tmp/ 下的 bug: done')).toBe('修复-tmp-下的-bug-done');
  });

  it('空标题回退为 plan', () => {
    expect(sanitizePlanTitle('   ')).toBe('plan');
    expect(sanitizePlanTitle('///')).toBe('plan');
  });

  it('超长标题截断到 60 字符', () => {
    const long = 'x'.repeat(100);
    expect(sanitizePlanTitle(long).length).toBe(60);
  });
});

describe('renderPlanMarkdown', () => {
  it('渲染标题、元数据与步骤状态标记', () => {
    const md = renderPlanMarkdown(
      [
        { step: 'a', status: 'completed' },
        { step: 'b', status: 'in_progress' },
        { step: 'c', status: 'pending' },
      ],
      { title: 'My Plan', sessionId: 's1', model: 'deepseek-v4-flash' },
      '2026-08-16T00-00-00',
    );

    expect(md).toContain('# My Plan');
    expect(md).toContain('1. [x] a');
    expect(md).toContain('2. [→] b');
    expect(md).toContain('3. [ ] c');
    expect(md).toContain('1 完成 · 1 进行中 · 1 待办');
    expect(md).toContain('- 会话: s1');
  });
});

describe('savePlan', () => {
  it('无计划时抛错', () => {
    expect(() => savePlan(dir)).toThrow(/No plan to save/);
  });

  it('保存计划为 Markdown 文件', async () => {
    const tool = getTool('update_plan')!;
    await tool.execute({
      plan: [
        { step: 'step one', status: 'completed' },
        { step: 'step two', status: 'pending' },
      ],
    });

    const saved = savePlan(dir, { title: '测试计划', sessionId: 'sess1' });

    expect(saved.steps).toBe(2);
    expect(saved.filename.endsWith('.md')).toBe(true);
    expect(existsSync(saved.path)).toBe(true);

    const content = readFileSync(saved.path, 'utf-8');
    expect(content).toContain('# 测试计划');
    expect(content).toContain('1. [x] step one');
    expect(content).toContain('2. [ ] step two');
  });
});
