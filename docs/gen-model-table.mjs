#!/usr/bin/env node
/**
 * 从 MODEL_CATALOG 生成 README 模型表（<!-- model-table:start/end --> 标记区间）
 * 用法：npm run docs:models（先 build 保证 dist 最新）
 */
import { MODEL_CATALOG } from '../packages/core/dist/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

const tag = (c) => {
  const base = c.tier >= 4 ? (c.thinking ? 'Strongest reasoning' : 'Strongest')
    : c.tier === 3 ? 'Strong reasoning'
    : c.tier === 2 ? 'Balanced'
    : 'Fast/economical';
  return c.modalities.includes('image') ? `${base} (vision)` : base;
};
const fmtCtx = (n) => (n >= 1_000_000 ? `${n / 1_000_000}M tokens` : `${Math.round(n / 1000)}K tokens`);

const rows = MODEL_CATALOG.map((c) => `| \`${c.model}\` | ${tag(c)} | ${fmtCtx(c.contextWindow)} |`);
const block = ['| Model | Tier | Context |', '|------|------|--------|', ...rows].join('\n');

const readmePath = 'README.md';
const text = readFileSync(readmePath, 'utf-8');
const start = '<!-- model-table:start -->';
const end = '<!-- model-table:end -->';
const re = new RegExp(`${start}[\\s\\S]*?${end}`);
if (!re.test(text)) {
  console.error('README 缺少 model-table 标记区间（<!-- model-table:start/end -->）');
  process.exit(1);
}
const out = text.replace(re, `${start}\n${block}\n${end}`);
writeFileSync(readmePath, out);
console.log(`README 模型表已更新（${MODEL_CATALOG.length} 项）`);
