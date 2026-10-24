/**
 * StatusBar — Claude Code 风格的头部（村民头 logo）
 *
 *   ╷╷╷╷╷╷╷╷   SHENLAN v0.4.90
 *   ██•██•██   deepseek-v4-flash · NORMAL · master
 *   ████████   /Users/edy/work/code/shenlan
 *    ▘▘  ▝▝
 *
 * 画法沿用 Claude Code CLI（v2.1.272，PTY 抓帧比对）：
 *  - **实心块 = 背景色涂空格**（`backgroundColor`），**不用 `█`/`▐`/`▌` 任何整块字形**
 *    —— 这正是旧版村民头「方块字形缺失 → 整张脸空心」的根因所在；
 *  - 眼睛是圆点 `•`（原村民头同款、已验证可渲染），画在实心脸上，
 *    前景走终端默认色（浅底深点、深底亮点）；**不用格子挖洞**（挖洞会露出方形的底，很难看）；
 *  - 发用 `╷`（U+2577 竖线**下半段**，长度只有 `│` 的一半、下端仍接住脸），腿用 `▘▝` 角字形。
 *
 * 造型保留原村民头结构：发（竖线）／脸 + 两颗圆眼睛（居中偏上）／下巴（实心）／两条腿。
 * logo 占 10 列 + 2 空格 → 信息文本从第 12 列开始（与 Claude Code 对齐）。
 */
import { Text, Box } from 'ink';
import type { ReactNode } from 'react';
import { useContext, useMemo } from 'react';
import { execSync } from 'node:child_process';
import { AppContext } from '../context.js';
import { modeLabel } from '../mode.js';

/** 品牌色：原来的村民青（cyan），与旧版村民头一致 */
const LOGO_COLOR = 'cyan';

/** 实心块：n 个空格加背景色（不依赖任何字形） */
function Block({ n }: { n: number }) {
  return <Text backgroundColor={LOGO_COLOR}>{' '.repeat(n)}</Text>;
}

/** 字形（发/腿/眼）：不指定颜色 → 走终端默认前景色 */
function Corners({ s }: { s: string }) {
  return <Text color={LOGO_COLOR}>{s}</Text>;
}

/**
 * 眼睛：圆点 `•`（原村民头同款、终端已验证可渲染），画在青色实心脸上。
 * 前景不指定 → 走终端默认前景色（浅色主题为深点、深色主题为亮点），
 * 因为脸恒为品牌色、不随底色变，所以默认前景色在任何主题下都与脸有对比。
 */
function Eye() {
  return <Text backgroundColor={LOGO_COLOR}>•</Text>;
}

/**
 * 村民头 logo，4 行 × 10 列（含左右各 1 列留白）。
 *   row0  发  ：8 个 `╷` 竖线（半长）
 *   row1  脸  ：实心 + 两颗圆点眼睛（列 3、6）
 *   row2  下巴：8 格实心
 *   row3  腿  ：▘▘ / ▝▝ 角字形
 *
 * 发为什么用 `╷`：`│`（U+2502）是**整格高**的竖线，显得头发太长；`╷`（U+2577
 * 「下」半线）只填格子**下半段**，长度恰为一半，且下端仍落在格底、接住下一行的脸，
 * 观感是"贴着脑袋的短发"。它同样位于格子水平正中，8 个并排仍居中对称、与脸左右对齐。
 * （若要头发离头悬空半格、上半段有发梢，则改用上半线 `╵` U+2575。）
 */
function LogoRow({ index }: { index: number }) {
  switch (index) {
    case 0: // 发：8 根半长竖线（╷ = 只占下半格，长度减半、下端接脸）
      return (
        <Text>
          {' '}
          <Corners s="╷╷╷╷╷╷╷╷" />
          {' '}
        </Text>
      );
    case 1: // 脸 + 两颗圆点眼睛（眼睛上移到这一行）
      return (
        <Text>
          {' '}
          <Block n={2} />
          <Eye />
          <Block n={2} />
          <Eye />
          <Block n={2} />
          {' '}
        </Text>
      );
    case 2: // 下巴（实心）
      return (
        <Text>
          {' '}
          <Block n={8} />
          {' '}
        </Text>
      );
    default: // 腿
      return (
        <Text>
          {'  '}
          <Corners s="▘▘" />
          {'  '}
          <Corners s="▝▝" />
          {'  '}
        </Text>
      );
  }
}

function gitBranch(): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

export function StatusBar({ version }: { version: string }) {
  const { model, mode } = useContext(AppContext);
  const cwd = process.cwd();
  const branch = useMemo(() => gitBranch(), []);

  const modeColor =
    mode === 'plan' ? 'yellow' : mode === 'bypassPermissions' ? 'red' : 'green';
  const modeShort = modeLabel(mode);

  // 3 行信息：品牌 / 状态（模型 · 模式 · 分支）/ 路径
  const infoLines: ReactNode[] = [
    <>
      <Text bold>SHENLAN</Text>
      <Text dimColor> v{version}</Text>
    </>,
    <>
      <Text>{model}</Text>
      <Text dimColor> · </Text>
      <Text color={modeColor}>{modeShort}</Text>
      {branch ? <Text dimColor> · {branch}</Text> : null}
    </>,
    <Text dimColor>{cwd}</Text>,
  ];

  return (
    <Box flexDirection="column">
      {/* 顶部留白：与上方终端内容（命令行/提示符）隔开 */}
      <Box height={1} />
      {/* logo 恒为 4 行；文字只贴前 3 行，第 4 行（腿）右侧留空 */}
      {[0, 1, 2, 3].map(i => (
        <Box key={i}>
          <LogoRow index={i} />
          {infoLines[i] ? (
            <>
              <Text>  </Text>
              {infoLines[i]}
            </>
          ) : null}
        </Box>
      ))}
      <Box height={1} />
    </Box>
  );
}
