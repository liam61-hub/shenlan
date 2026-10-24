/**
 * 首次引导面板 — 对齐 Codex / Claude Code 首次运行体验
 *
 * 三步入场（模态，Esc 可跳过，之后随时 /keys 再配）：
 *   welcome：欢迎 + 一句话说明（密钥仅存本地）
 *   keys：复用 /keys 密钥面板（第 1 步：配置 API Key，保存后进入 tips）
 *   tips：一次性快速上手（/model /goal /security /keys /help）
 *
 * 完成/跳过时由 InputBox 持久化 onboarding.done 到全局配置（0600），
 * 后续启动不再自动弹出。
 */
import { Box, Text } from 'ink';
import { useContext } from 'react';
import { AppContext } from '../context.js';
import type { KeysPanelState, OnboardingState } from '../context.js';
import { KeysPanelView } from './KeysPanel.js';
import { providerDef } from '../keys.js';
import { capLine } from '../streaming.js';

export function OnboardingPanelView({ onboarding, keysPanel }: {
  onboarding: OnboardingState;
  keysPanel: KeysPanelState | null;
}) {
  const { termHeight, termWidth } = useContext(AppContext);
  const maxRows = Math.max(1, termHeight - 1);
  const maxWidth = Math.max(8, termWidth - 2);

  if (onboarding.step === 'keys' && keysPanel) {
    // 复用 /keys 面板，顶部加步骤引导行
    return (
      <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
        <Text bold color="cyan">  第 1 步 · 配置 API Key</Text>
        <Text dimColor>  密钥只保存在本地配置文件（0600），环境变量优先。Esc 返回欢迎页</Text>
        <Box height={1} />
        <KeysPanelView panel={keysPanel} />
      </Box>
    );
  }

  if (onboarding.step === 'tips') {
    const saved = onboarding.saved;
    const providerName = saved ? providerDef(saved.provider)?.name ?? saved.provider : '';
    const savedText = saved
      ? `✓ 配置完成${providerName ? `（${providerName} ${saved.masked}` : `（${saved.masked}`}）`
      : '✓ 配置完成';
    return (
      <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
        <Text bold color="green">  {savedText}</Text>
        <Box height={1} />
        <Text dimColor>  快速上手：</Text>
        <Text>  /model     切换模型（自动路由 / 手动锁定）</Text>
        <Text>  /goal      长任务目标模式（/goal &lt;可验证目标&gt;）</Text>
        <Text>  /security  提交时安全检查（pre-commit 钩子）</Text>
        <Text>  /keys      随时重新配置 API Key</Text>
        <Text>  /help      查看全部命令</Text>
        <Box height={1} />
        <Text dimColor>  [Enter] 开始使用</Text>
      </Box>
    );
  }

  // welcome
  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
      <Text bold color="cyan">  ⚡ 欢迎使用 shenlan</Text>
      <Box height={1} />
      <Text>  终端里的 AI 编程助手（私有分发 · 自带 API Key · 密钥仅存本地）</Text>
      <Box height={1} />
      <Text dimColor>  首次使用只需配置 API Key：</Text>
      <Text dimColor>  · 支持 DeepSeek / qwen / OpenAI / 自定义 OpenAI 兼容，写入 ~/.shenlan/config.json（0600）</Text>
      <Text dimColor>  · 环境变量（如 DEEPSEEK_API_KEY）优先级更高</Text>
      <Box height={1} />
      <Text>  [Enter] 开始配置  ·  [Esc] 跳过（随时 /keys 配置）</Text>
      <Box height={1} />
      <Text dimColor>  {capLine('shenlan 为 AI 编程助手：文件操作、代码搜索、shell 执行、联网搜索、子代理分解。', maxWidth)}</Text>
    </Box>
  );
}
