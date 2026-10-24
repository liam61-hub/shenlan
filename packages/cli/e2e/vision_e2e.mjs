#!/usr/bin/env node
/**
 * 视觉真机验证脚本（真机 opt-in，不进 CI）— 清单 #11
 *
 * 用本地 ~/.shenlan/config.json 里的 qwen key 直连 qwen-vl-max，
 * 发送 OpenAI 兼容 image_url 内容块（1x1 透明 PNG），断言：
 *   1. HTTP 200（chat 内部非 2xx 抛错）
 *   2. 返回内容非空（模型确实读到了图片并作出描述）
 *
 * 判定点：请求体含 image_url 块（协议正确性）+ 模型返回图片描述（真机可用）。
 *
 * 退出码契约（run_e2e.py 依此做三态汇总）：
 *   0  = PASS
 *   77 = SKIP（autotools 约定）—— 未设 SHENLAN_E2E_LIVE 或无 qwen key
 *   其他 = FAIL
 * 之所以 SKIP 不用 0：它会打真端点、花真钱，必须 opt-in，且"没跑"不能
 * 在汇总里显示成 PASS（否则发布清单 #6/#11 是靠一个从未执行的脚本打的勾）。
 *
 * 用法：npm run build && SHENLAN_E2E_LIVE=1 node packages/cli/e2e/vision_e2e.mjs
 */
import { loadConfig, resolveApiKey, resolveBaseUrl, detectProvider, chat } from '../../core/dist/index.js';

const SKIP = 77;

// SKIP 原因会被 run_e2e.py 抓进汇总行，所以 `SKIP:` 后面保持一行短语
if (!process.env.SHENLAN_E2E_LIVE) {
  console.log('SKIP: live test not enabled (set SHENLAN_E2E_LIVE=1)');
  console.log('  本脚本打真端点、消耗真实 token，故默认不跑');
  process.exit(SKIP);
}

const model = 'qwen-vl-max';
const config = loadConfig(process.cwd());
const provider = detectProvider(model);
const apiKey = resolveApiKey(config, provider);
if (!apiKey) {
  console.log('SKIP: no qwen key configured');
  console.log('  需 providerKeys.qwen（~/.shenlan/config.json）或 QWEN_API_KEY');
  process.exit(SKIP);
}

// 1x1 透明 PNG（与 view-image.test.ts 同款）
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const messages = [
  { role: 'system', content: 'You are a vision test bot.' },
  {
    role: 'user',
    content: [
      { type: 'text', text: '描述这张图（1x1 透明像素 PNG）' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  },
];

try {
  const resp = await chat(
    { ...config.model, baseUrl: resolveBaseUrl(config, model), model, apiKey, maxTokens: 128 },
    messages,
  );
  const text = resp.choices?.[0]?.message?.content?.trim() || '';
  console.log('HTTP 200 OK');
  console.log('response:', text.slice(0, 300) || '(empty)');
  if (!text) {
    console.error('FAIL: empty response — 模型未返回描述（图片可能未被识别）');
    process.exit(1);
  }
  console.log('PASS: qwen-vl-max 收到 image_url 内容块并返回图片描述');
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
