/**
 * README 模型表漂移守卫（#10）：表格行数与模型名必须与 MODEL_CATALOG 一一对应，
 * 防下次手工改表失同步（更新方式：npm run docs:models）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODEL_CATALOG } from '@shenlan/core';
import { VERSION } from '../version.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const readmePath = join(repoRoot, 'README.md');

describe('README 模型表漂移守卫', () => {
  it('表格行数与模型名与 MODEL_CATALOG 一一对应', () => {
    const text = readFileSync(readmePath, 'utf-8');
    // \r?\n 容忍 CRLF（Windows git autocrlf 提交时会把 README 转成 CRLF）
    const m = text.match(/<!-- model-table:start -->\r?\n([\s\S]*?)\r?\n<!-- model-table:end -->/);
    expect(m).toBeTruthy();
    const rows = m![1]!.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toHaveLength(MODEL_CATALOG.length);
    for (const c of MODEL_CATALOG) {
      expect(m![1]!, `README 模型表缺少 ${c.model}`).toContain(`| \`${c.model}\` |`);
    }
  });

  it('README 展示版本与 CLI 版本唯一事实源一致', () => {
    const readme = readFileSync(readmePath, 'utf-8');
    const cliPackage = JSON.parse(
      readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf-8'),
    ) as { version: string };
    const match = readme.match(/Current version:\s*\*\*v([^*]+)\*\*/);

    expect(match, 'README 缺少 "Current version: **vX.Y.Z**" 版本标记').toBeTruthy();
    expect(match![1]).toBe(VERSION);
    expect(cliPackage.version).toBe(VERSION);
  });
});
