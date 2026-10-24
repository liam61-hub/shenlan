import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextConfig, Message, ShenlanConfig } from '@shenlan/core';
import { updateMemoryIndex, projectMemoryDir } from '@shenlan/core';
import { buildContextReport } from '../commands/context-report.js';

// 单独声明：ShenlanConfig.context 是可选字段，直接展开 baseConfig.context
// 会把必填项变成可选，覆写用例过不了类型检查
const baseContext: ContextConfig = {
  autoCompactTokenLimit: 200_000,
  keepRecentTurns: 20,
  toolOutputLimitChars: 8000,
  compactModel: '',
};

const baseConfig: ShenlanConfig = {
  model: { baseUrl: '', apiKey: 'k', model: 'deepseek-v4-flash', maxTokens: 8192 },
  permissions: { mode: 'default', allow: [], deny: [] },
  context: baseContext,
  skills: [],
  mcpServers: [],
};

function report(messages: Message[], cwd: string, config: ShenlanConfig = baseConfig): string[] {
  return buildContextReport({
    messages,
    config,
    model: 'deepseek-v4-flash',
    contextWindow: 128_000,
    history: [],
    cwd,
  });
}

describe('buildContextReport', () => {
  let tmp: string;
  let cwd: string;
  const realConfigDir = process.env.SHENLAN_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shenlan-ctxreport-'));
    cwd = join(tmp, 'proj');
    mkdirSync(join(cwd, '.shenlan'), { recursive: true });
    // 记忆行现算于磁盘，必须把全局记忆目录隔离掉，否则开发机上的真实记忆会进断言
    process.env.SHENLAN_CONFIG_DIR = join(tmp, 'global');
  });

  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.SHENLAN_CONFIG_DIR;
    else process.env.SHENLAN_CONFIG_DIR = realConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('保留抽取前的既有行：总量、分项、toolOutputLimit', () => {
    const lines = report(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      cwd,
    );
    expect(lines[0]).toMatch(/^ {2}~\d+.* tokens \/ 3 msgs（自动压缩阈值 /);
    expect(lines[1]).toContain('system ');
    expect(lines[1]).toContain('最近20轮 ');
    expect(lines[2]).toMatch(/toolOutputLimit=\S+ chars/);
  });

  it('有记忆时输出记忆行（token / 预算 / 条数）', () => {
    updateMemoryIndex(projectMemoryDir(cwd), 'topic', '一条记忆');
    const lines = report([{ role: 'system', content: 'sys' }], cwd);
    const memLine = lines.find((l) => l.includes('记忆 ~'));
    expect(memLine).toBeDefined();
    expect(memLine).toContain('预算 4096');
    expect(memLine).toContain('（1 条）');
    expect(memLine).not.toContain('已折叠');
  });

  it('记忆超预算时记忆行显示折叠条数', () => {
    const dir = projectMemoryDir(cwd);
    for (let i = 0; i < 40; i++) updateMemoryIndex(dir, `m-${i}`, 'x'.repeat(70));
    const cfg = { ...baseConfig, context: { ...baseContext, maxMemoryTokens: 180 } };
    const lines = report([{ role: 'system', content: 'sys' }], cwd, cfg);
    const memLine = lines.find((l) => l.includes('记忆 ~'))!;
    expect(memLine).toMatch(/预算 180（\d+ 条，已折叠 \d+ 条）/);
  });

  it('无任何记忆时不输出记忆行（不给一行 0 噪音）', () => {
    const lines = report([{ role: 'system', content: 'sys' }], cwd);
    expect(lines.some((l) => l.includes('记忆 ~'))).toBe(false);
  });

  it('超压缩阈值时给出 /compact 建议', () => {
    const cfg = { ...baseConfig, context: { ...baseContext, autoCompactTokenLimit: 10 } };
    const lines = report([{ role: 'user', content: 'x'.repeat(400) }], cwd, cfg);
    expect(lines.at(-1)).toContain('/compact 手动压缩');
  });

  it('压缩记录非空时输出压缩记录行', () => {
    const lines = buildContextReport({
      messages: [{ role: 'user', content: 'hi' }],
      config: baseConfig,
      model: 'deepseek-v4-flash',
      contextWindow: 128_000,
      history: [{ time: new Date(2026, 8, 15, 10, 30, 0), round: 3, method: 'llm', savedTokens: 1200 }],
      cwd,
    });
    const line = lines.find((l) => l.includes('压缩记录'))!;
    expect(line).toContain('1 次');
    expect(line).toContain('LLM');
  });
});
