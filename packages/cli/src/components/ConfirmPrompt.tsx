/**
 * 权限确认弹窗 — Codex CLI 审批样式
 *
 * 按操作类型渲染上下文相关的标题与选项：
 *   - edit：文件列表 + Yes / 这些文件不再询问 / 说明原因
 *   - command：Environment + $ 命令 + Yes / 同类命令不再询问 / 说明原因
 *   - plan：choose an implementation permission mode or stay in Plan mode
 *
 * “No, and tell me what to do differently” 选中后进入反馈输入模式，
 * 用户的说明会作为 tool 结果回传给模型（repl.ts 处理 deny_feedback）。
 */
import { Text, Box } from 'ink';
import type { ConfirmPrompt } from '../context.js';
import { capLine } from '../streaming.js';
import { displayWidth } from '../markdown-utils.js';

/** 选项标签最大显示宽度（超出截断，防止窄终端把弹窗撑出预算） */
const LABEL_MAX_WIDTH = 74;
/** plan 选项标签补白宽度（右侧对齐描述） */
const PLAN_LABEL_PAD = 34;

/** plan 选项右侧描述（与 Codex CLI 一致） */
const PLAN_HINTS = {
  en: {
    '1': 'Ask before writes and commands.',
    '2': 'Auto-accept edits; ask before commands.',
    '3': 'Skip permission prompts.',
    '4': 'Fresh context in Normal mode.',
    '5': 'Continue planning.',
  },
  'zh-CN': {
    '1': '写入和命令仍需确认。',
    '2': '自动允许文件编辑，命令仍需确认。',
    '3': '跳过权限确认。',
    '4': '清空上下文后以 Normal 实施。',
    '5': '继续规划。',
  },
} as const;

export function ConfirmPromptView({ prompt }: { prompt: ConfirmPrompt }) {
  const isPlan = prompt.kind === 'plan';
  const showFeedback = prompt.feedbackMode;
  const language = prompt.language ?? 'en';
  const showEnv = prompt.kind === 'command';
  const prefix =
    prompt.kind === 'edit' || prompt.kind === 'create' ? '✎ ' : prompt.kind === 'command' ? '$ ' : '';
  const footerHint = prompt.footerHint
    ?? (language === 'zh-CN'
      ? (prompt.kind === 'delete' ? '  Esc 取消 · Ctrl+C 终止' : prompt.kind === 'high-risk' ? '  Enter 输入短语 · Esc 拒绝 · Ctrl+C 终止' : '  ↑/↓ 选择 · Enter 确认 · Esc 说明原因 · Ctrl+C 终止')
      : (prompt.kind === 'delete' ? '  Esc cancel · Ctrl+C abort' : prompt.kind === 'high-risk' ? '  Enter phrase · Esc deny · Ctrl+C abort' : '  ↑/↓ select · Enter confirm · Esc explain refusal · Ctrl+C abort'));

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>{prompt.title}</Text>
      <Box height={1} />

      {isPlan ? (
        <Box flexDirection="column">
          {prompt.detail.map((line, i) => (
            <Box key={i}>
              <Text dimColor>  </Text>
              <Text>{line}</Text>
            </Box>
          ))}
          {prompt.detail.length > 0 && <Box height={1} />}
        </Box>
      ) : (
        <Box flexDirection="column">
          {showEnv && (
            <Box>
              <Text dimColor>  {language === 'zh-CN' ? '环境：本地' : 'Environment: local'}</Text>
            </Box>
          )}
          {prompt.detail.map((line, i) => (
            <Box key={i}>
              <Text color="cyan">
                {'  '}
                {prefix}
              </Text>
              <Text>{line}</Text>
            </Box>
          ))}
          <Box height={1} />
        </Box>
      )}

      {prompt.options.map((opt, i) => {
        const isSelected = i === prompt.selected;
        const label = capLine(opt.label, LABEL_MAX_WIDTH);
        if (isPlan) {
          const hint = PLAN_HINTS[language][opt.key as keyof typeof PLAN_HINTS.en] || '';
          const pad = Math.max(1, PLAN_LABEL_PAD - displayWidth(label) + (isSelected ? 1 : 0));
          return (
            <Box key={opt.key}>
              <Text>  </Text>
              <Text bold={isSelected} color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '› ' : '  '}
                {opt.key}. {label}
              </Text>
              <Text dimColor>{' '.repeat(pad)}{hint}</Text>
            </Box>
          );
        }
        return (
          <Box key={opt.key}>
            <Text>  </Text>
            {isSelected ? (
              <Text color="cyan">{'› '}</Text>
            ) : (
              <Text dimColor>{'  '}</Text>
            )}
            <Text bold={isSelected} color={isSelected ? 'cyan' : undefined}>
              {i + 1}. {label}
            </Text>
          </Box>
        );
      })}

      {!isPlan && (
        <Box>
          <Text dimColor>{footerHint}</Text>
        </Box>
      )}

      {showFeedback && (
        <Box flexDirection="column">
          <Box height={1} />
          <Box>
            <Text dimColor>  {prompt.feedbackLabel || (language === 'zh-CN' ? '请说明应如何调整：' : 'Tell me what to do differently:')}</Text>
          </Box>
          <Box>
            <Text dimColor>  {'> '}</Text>
            <Text>{prompt.feedbackText}</Text>
            <Text>█</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
