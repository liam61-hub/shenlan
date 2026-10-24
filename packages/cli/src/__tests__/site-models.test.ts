/**
 * 产品站「模型接入」页漂移守卫（B3）
 *
 * 与 README 相反的策略：README 的模型表是 MODEL_CATALOG 的字面投影（npm run docs:models 生成），
 * 而公开站这一页刻意只讲**机制**（接入路径、配置优先级、路由策略、视觉升级），
 * 不含任何具体模型 ID 与价格 —— 目录每次微调都要重建 + 部署站点是不可接受的维护成本，
 * 且公开页写错价格比不写价格糟得多。
 *
 * 所以这里守的不是「表格同步」，而是「这一页没有偷偷长出目录」：
 * 谁开始往里手写模型清单/价格，这个测试立刻红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODEL_CATALOG, CONFIG_KEYS } from '@shenlan/core';
import { PROVIDERS } from '../providers.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const pagePath = join(repoRoot, 'docs', 'site', 'guide', 'models.md');
const page = readFileSync(pagePath, 'utf-8');

describe('产品站模型页刻意不具体', () => {
  it('不出现任何具体模型 ID', () => {
    for (const c of MODEL_CATALOG) {
      expect(
        page,
        `docs/site/guide/models.md 出现了具体模型 ID ${c.model}；本页应只讲机制，目录以 CLI /model 输出为准`,
      ).not.toContain(c.model);
    }
  });

  it('不出现价格数字', () => {
    // ¥12 / $2.50 / ￥ 3 一类；页面讲价格机制可以，写具体金额不行
    expect(page, '产品站不应写死价格，官方价会漂移（以 /prices 为准）').not.toMatch(/[¥￥$]\s*\d/);
  });

  it('提到的 provider 都能对上 providers.ts 的真实条目', () => {
    // 从「可接入 X、Y、Z 以及…」这句抽取品牌名，provider 被删/改名时本测试会红
    const m = page.match(/可接入([^以]+)以及/);
    expect(m, '模型页缺少「可接入 …… 以及」介绍句（provider 守卫依赖它定位）').toBeTruthy();
    const mentioned = m![1]!.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    expect(mentioned.length).toBeGreaterThan(0);

    // providers.ts 的 name 大小写不统一（'DeepSeek' vs 'qwen'），故不区分大小写比对 id/name
    const known = new Set(PROVIDERS.flatMap((p) => [p.id, p.name]).map((s) => s.toLowerCase()));
    for (const name of mentioned) {
      expect(known.has(name.toLowerCase()), `模型页提到的 provider「${name}」不在 providers.ts 中`).toBe(true);
    }
  });

  it('提到的路由策略串都是合法配置值', () => {
    const allowed = CONFIG_KEYS['routing.policy']?.allowedValues ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    const inlineCode = [...page.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    const policyLike = inlineCode.filter((s) => s.endsWith('-first'));
    expect(policyLike.length, '模型页应至少提到一种路由策略').toBeGreaterThan(0);
    for (const p of policyLike) {
      expect(allowed, `模型页写的路由策略「${p}」不是 routing.policy 的合法值`).toContain(p);
    }
  });

  it('免责声明句仍在（本页可以不具体的前提）', () => {
    expect(page).toContain('/model');
    expect(page).toContain('/prices');
    expect(page, '删掉「以 CLI 输出为准」的免责声明后，本页就成了会过期的事实源').toMatch(
      /以\s*CLI\s*内的\s*`\/model`\s*与\s*`\/prices`\s*输出为准/,
    );
  });
});
