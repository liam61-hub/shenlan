/**
 * /keys 密钥管理面板 — 动态区模态面板
 *
 * provider 列表只显示掩码（尾 4 位）；Enter 进入输入模式（支持粘贴），
 * 输入完 Enter 保存并做连通性测试（失败仅黄色提示不阻塞），Esc 取消；
 * 已配置项按 d 删除；g/p 切换全局/项目级（默认全局）；Esc/q 关闭。
 *
 * Custom OpenAI-compatible 行走三步录入：baseUrl → API Key → 模型名；
 * 第 2 步拿到 key 后异步探测厂商 /v1/models，成功则第 3 步列出清单（序号选择，
 * 上限 DISCOVERED_MODEL_LIST_LIMIT，超出部分提示「未显示」），失败退回手输模型名。
 */
import { Box, Text } from 'ink';
import { useContext } from 'react';
import { AppContext } from '../context.js';
import type { KeysPanelState } from '../context.js';
import { KEY_SCOPE_LABELS } from '../keys.js';
import { DISCOVERED_MODEL_LIST_LIMIT } from '../providers.js';
import { capLine } from '../streaming.js';

const NAME_COL = 12;
/** 标题 + 副标题 + 2 空行 + 页脚（provider 行之外的固定骨架） */
const CHROME_ROWS = 5;

/** 自定义 provider 三步录入的分步提示行 */
const CUSTOM_STEP_HINTS = [
  'Base URL（OpenAI 兼容根路径，留空 = 自动推导官方端点）',
  'API Key（留空 = 取消）',
  '模型名（如 gpt-5.4 / llama-3.1-70b）',
] as const;

export function KeysPanelView({ panel }: { panel: KeysPanelState }) {
  const { termHeight, termWidth } = useContext(AppContext);
  const maxRows = Math.max(1, termHeight - 1);
  const rowBudget = Math.max(1, maxRows - CHROME_ROWS);
  const n = panel.providers.length;
  const start = n <= rowBudget
    ? 0
    : Math.max(0, Math.min(panel.selected - Math.floor((rowBudget - 1) / 2), n - rowBudget));
  const shown = panel.providers.slice(start, start + rowBudget);
  const maxWidth = Math.max(8, termWidth - 2);

  const selected = panel.providers[panel.selected];

  // 三步录入第 3 步的模型清单展示：该步骤不渲染 provider 列表，可用高度让给清单，
  // 但仍须满足「动态帧 < 终端行数」硬性规则（固定 4 行：标题/输入行/空行/页脚）。
  const listModels = panel.customStep === 2
    ? panel.customModels.slice(0, DISCOVERED_MODEL_LIST_LIMIT)
    : [];
  const listFixedRows = 4 + (panel.busy ? 1 : 0) + (panel.notice ? 1 : 0);
  const listBudget = Math.max(0, maxRows - listFixedRows);
  const visibleModels = listModels.length <= listBudget
    ? listModels
    : listModels.slice(0, Math.max(0, listBudget - 1));
  const hiddenModelCount = listModels.length - visibleModels.length;

  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden" flexShrink={0}>
      <Text bold color="cyan">  API keys</Text>
      <Text dimColor>  密钥只保存在本地配置文件（0600），环境变量优先。Enter 输入 · Esc 取消 · d 删除</Text>
      <Box height={1} />
      {panel.inputMode ? (
        panel.customStep !== null ? (
          <Box flexDirection="column">
            <Text>
              {`  Custom OpenAI-compatible — 步骤 ${panel.customStep + 1}/3：${
                listModels.length > 0
                  ? `选择模型（序号 1-${listModels.length}，或直接输入模型名）`
                  : CUSTOM_STEP_HINTS[panel.customStep]
              }`}
            </Text>
            {visibleModels.map((m, i) => (
              <Text key={`${m}-${i}`} dimColor>{capLine(`    [${i + 1}] ${m}`, maxWidth)}</Text>
            ))}
            {hiddenModelCount > 0 && (
              <Text dimColor>{capLine(`    … 其余 ${hiddenModelCount} 个未显示，可直接输入模型名`, maxWidth)}</Text>
            )}
            <Box>
              <Text dimColor>  {'> '}</Text>
              <Text>{panel.inputText}</Text>
              <Text>█</Text>
            </Box>
            <Box height={1} />
            <Text dimColor>  Enter 下一步 · Esc 取消</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              {selected
                ? `  输入 ${selected.name} API Key（粘贴支持）`
                : '  输入 API Key（粘贴支持）'}
            </Text>
            <Box>
              <Text dimColor>  {'> '}</Text>
              <Text>{panel.inputText}</Text>
              <Text>█</Text>
            </Box>
            <Box height={1} />
            <Text dimColor>  Enter 保存并测试连通性 · Esc 取消</Text>
          </Box>
        )
      ) : (
        <Box flexDirection="column">
          {shown.map((p, i) => {
            const idx = start + i;
            const isSel = idx === panel.selected;
            const envTag = p.envSet ? ' [env]' : '';
            const baseTag = p.baseUrl ? ` · ${p.baseUrl}` : '';
            const line = capLine(
              `${isSel ? '❯ ' : '  '}${idx + 1}. ${p.name.padEnd(NAME_COL)}  ${p.masked}${envTag}${baseTag}`,
              maxWidth,
            );
            return (
              <Box key={p.id}>
                <Text inverse={isSel}>{line}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box height={1} />
      {panel.notice && (
        <Text color="yellow">  ℹ {capLine(panel.notice, maxWidth)}</Text>
      )}
      {panel.busy && <Text dimColor>  ⬡ testing connection...</Text>}
      <Text dimColor>
        {panel.inputMode
          ? '  Enter 保存 · Esc 取消'
          : `  作用域：${KEY_SCOPE_LABELS[panel.scope]}（g/p 切换） · Enter 编辑 · d 删除 · Esc 关闭`}
      </Text>
    </Box>
  );
}
