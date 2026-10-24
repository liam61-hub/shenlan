# Repository Guidelines（仓库指南）

## 项目简介

自建 Agent Harness CLI：TypeScript + Node.js 22+，npm workspaces monorepo。`packages/core`（内核：LLM 调用、工具系统、会话存储）零 UI 依赖，`packages/cli`（Ink 7 TUI）只做渲染与输入。

## 模块结构

```
packages/core/   # @shenlan/core — 内核：LLM 调用、工具系统、会话存储、配置、上下文压缩
packages/cli/    # @shenlan/cli — 终端：Ink 7 全屏 TUI、Agent 循环、slash 命令
```

**依赖方向**: `cli` → `core`，core 零 UI 依赖，可独立单测。

## 技术栈

| 模块 | 技术 |
|------|------|
| 语言 | TypeScript strict mode，ES2022 + NodeNext |
| TUI | **Ink 7.1**（React 19 终端 UI），非 chalk |
| 布局 | Yoga 3.2（Ink 内置 flexbox 引擎） |
| LLM | 原生 fetch (Node 22)，OpenAI 兼容 API |
| 存储 | JSONL 会话 + `.shenlan/` 项目目录 |
| 测试 | vitest |

## 构建与测试

| 命令 | 作用 |
|------|------|
| `npm install` | 安装全部 workspace 依赖 |
| `npm run build` | `tsc -b` 编译 core 与 cli，产物输出到各包 `dist/` |
| `npm test` | Vitest 运行全部单测（`packages/*/src/**/*.test.{ts,tsx}`） |
| `npm run dev` | 监听模式增量编译 |
| `npm run clean` | 清理各包 `dist/` 与 `node_modules` |

本地运行 CLI：`node packages/cli/dist/index.js`；单包操作如 `npm run build --workspace @shenlan/core`。测试文件命名 `*.test.ts`（JSX 用例用 `*.test.tsx`，vitest include 已覆盖），core 的测试放在 `src/__tests__/`。

## 代码规范

- TypeScript strict mode，target ES2022，NodeNext 模块解析；ESM 相对导入带 `.js` 后缀
- 2 空格缩进；无 ESLint/Prettier 配置，`tsc` 是代码门禁
- 命名：函数/变量 camelCase，组件/类型 PascalCase，常量 UPPER_SNAKE_CASE
- Ink/React 组件放 `components/`，hooks 放 `hooks/`；业务逻辑在 core，渲染在 cli

## TUI 架构约束

```
<App>
  <Box flexDirection="column">      ← 主屏渲染（render 不带 alternateScreen）
    <Static items={frozenItems}/>   ← 历史/流式整行：写入终端原生回滚区，永不重绘
    <DynamicRegion />               ← 有界动态区：工具状态/tail/confirm/error
    <InputBox />                    ← 输入框 + 历史浏览 + Tab 补全（随内容滚动）
  </Box>
</App>
```

**输出帧高度硬性规则（最高优先级，2026-08-12 定）**：Ink **动态帧**（DynamicRegion + InputBox，即 `<Static>` 之外的帧输出）高度**必须始终 < 终端行数**（总输出 ≤ rows-1）。一旦动态帧达到/超过终端高度，Ink 会进入整屏清空模式，每帧发送 `\x1b[2J\x1b[3J\x1b[H`（清屏 + 清空终端回滚区 + 全量重绘）：

- macOS：每 50ms token flush / spinner 跳动都触发一次整屏清空重绘 → 页面闪动；`\x1b[3J` 把终端滚动区清空 → 滚轮往上滚看不到任何历史
- Windows conhost：Ink 对 Windows 有独立分支（`isWindowsConsole`），满屏帧强制清屏+全量重写，conhost 对这套序列支持不稳/写满底行自动滚动 → 旧帧擦不干净
- `<Static>` 内容不计入 Ink 的 `outputHeight`（Ink 源码 `renderer.js` 把 static output 与 main output 分开渲染），历史无限增长不会触发清屏；预算只约束动态区：`maxDynamicRows(termHeight, inputLines)` 在 `dynamic-budget.ts`，各内容硬上限（工具状态 ≤4 行、tail 1 行、confirm ≤13、error ≤3），`fitDynamicBudget` 按优先级 confirm > error > tail > tools > thinking > plan > todos 分配/截断行数；**输入框支持多行内容（粘贴保留换行），文本行数上限 `maxInputLines(termHeight)`，动态区预算随输入行数收缩**，总输出 = 动态区 + 输入区(2+L) + 状态行 + 底部留白 ≤ rows-1 恒成立
- 任何新组件/布局改动都不允许让 Ink 动态帧超过 rows-1；验证方法：PTY 中渲染超长内容，抓原始字节流确认没有任何清屏/清滚动区序列（`\x1b[2J` / `\x1b[3J`；`/clear` 同样不发清屏序列，见下）

**视口与滚动（原生回滚区模型，2026-08-12 定）**：

- 主屏渲染（`render(..., { patchConsole: true, exitOnCtrlC: false })`，**不带 alternateScreen**，进入前不发 `\x1b[H`）；历史消息和流式整行经 `<Static>` 增量写入终端**原生回滚区**，滚轮/滚动条由终端处理（**不启用 SGR 鼠标跟踪**，`mouse.ts` 已删除）
- **不用内部滚动视口**：无 scrollBack/scrollTop/marginTop 裁剪、无 `measureElement` 逐项测量（`viewport.ts` 已删除）；↑/↓ 只用于输入历史，PgUp/PgDn/Home/End 不做应用内滚动
- 流式输出：`TOKEN` action 用 `splitStreaming` 把已完成整行冻结进 `history`（`role: 'assistant-line'`，带代码围栏状态 `code`），未完成的一行留在 `state.streamingTail` 在动态区单行刷新；`COMPLETE`/`CONFIRM_RESULT`/`ERROR` 把 tail 落为最后一行静态项，assistant 消息不再重复进完成态渲染
- 静态项构建在 `frozen-items.ts`（`buildFrozenItems`）：logo 头部作首条（随内容滚走）+ 历史消息（`MessageItem`）+ 流式行（`StreamingLine`）；`history` 是 append-only 渲染列表，`<Static>` 按 index 切片只写新项
- 输入框随内容滚动：空闲时上滚，输入框离开视口；任务运行时因 spinner/tool 状态持续刷新仍实时绘制在底部（与 Claude Code 现状一致）
- **多行输入（2026-08-16 定，与 Codex CLI / Claude Code CLI 一致）**：粘贴走 Ink `usePaste` 独立通道，整段内容保留换行插入输入框（光标处），**粘贴绝不触发提交**，按 Enter 一次性提交全部；`inputValue` 在 AppState（`SET_INPUT`），光标保持局部 state；行数超预算时输入框内窗口滚动保持光标行可见，↑/↓ 仍为输入历史；**大段粘贴折叠（≥ 20 行）**：占位符 `[Pasted text #N +M lines]`，完整内容存进程内 paste 存储（`input-events.ts`，不落盘），Enter 提交时还原为原文、提交后清空存储，再粘贴一次展开占位符；小段（< 20 行）内联多行显示；提交后历史区用户消息完整多行显示（每行按 120 字符截断），`--resume` 恢复同样生效
- 动态区只放：运行中工具状态、thinking spinner（1 行）、流式 tail（单行按 `termWidth` 截断）、确认弹窗、错误（≤3 行）；`DynamicRegion` 每个 section 包 `height={allocated} overflow="hidden"` 保证帧高不超预算
- 终端 resize 时更新 termWidth/termHeight（App 监听 stdout `resize` 事件），InputBox 分隔线宽度与动态区截断宽度用最新值
- **`/clear`（2026-08-22 定，替代 2026-08-19 版）**：用户显式清空会话（重置 messages/history/todos/plan/error/会话成本），**不发任何清屏序列**（`\x1b[2J` / `\x1b[3J` 均不出现）——xterm.js 系终端对 `2J` 是直接删除缓冲内容而非滚入滚动区，发清屏必然丢历史；**视觉重置 = 换行推屏 + 光标归位**：`resetViewportToTop(termHeight)`（`screen-reset.ts`）在状态变更前同步写 `\x1b[{rows};1H` + rows 个换行（整屏旧内容压入滚动区，历史始终可上滑查看）+ `\x1b[H`（光标归位），并重置 Ink 帧状态（`lastOutput`/`lastOutputHeight` 归零 + `log.reset()`，镜像 Ink `endSuspend` 恢复路径）；随后**单次 `CLEAR_SESSION` dispatch**（清状态 + `staticEpoch`+1 + 设确认提示，一次渲染）让新会话 logo 渲染在**窗口顶部**、输入框紧随其下，观感等同刚启动（旧 index 只增不减，否则清空后的新消息会被跳过）；确认提示走 `SET_NOTICE`（`state.notice`）渲染在**输入框上方、紧贴分隔线**（不进 history/滚动区，`SUBMIT_INPUT` 时清除），避免“Context cleared”消息与输入框之间出现大段空白；`abortActiveLoop()` 终止在途任务（防止旧 run 的 COMPLETE 用旧 messages 回填撤销清空）
- **权限确认弹窗（Codex CLI 审批样式，2026-08-12 定）**：模态框描述要执行的操作（shell 命令带 `$` 前缀，写/改文件为 `✎ path`），选项固定为三个——通过(y) / 拒绝(d) / 终止(Esc)，支持上下键选择 + Enter 确认；**显示期间 InputBox 必须隐藏**（组件返回 null，useInput/usePaste hooks 保留以继续捕获确认按键，已输入内容保留），确认/终止后才恢复可输入；终止 = 清理未完成的 tool_calls 并停止 agent 循环（repl.ts 中 result === 'abort' 分支）。**弹窗在对话流内（2026-08-16 定，对齐 Claude Code CLI）**：弹窗渲染在最后一条消息正下方，不做整高底部锚定（避免消息未填满窗口时弹窗与消息之间出现大片空白）；tools/tail/plan/todos 确认期间暂隐、结束后恢复；输入框隐藏后弹窗独占动态帧，可用高度 rows-1（底部留白 1 行）；弹窗盒用 `maxHeight=min(CONFIRM_MAX, rows-1)` 限高，保证帧高 ≤ rows-1

`MessageItem` 用 `React.memo` 保持性能。

### 组件树

```
<Static key={state.staticEpoch} items={buildFrozenItems(state)}>   ← 终端回滚区（写入一次，永不重绘；/clear 重挂载）
├── StatusBar（首条，随内容滚走）
├── MessageItem × N（user/assistant/tool/system）
└── StreamingLine × N（role='assistant-line'，流式整行）

DynamicRegion                              ← 有界动态帧（≤ maxDynamicRows）
├── ToolStatusItem × ≤4（运行中工具 + 溢出提示）
├── thinking spinner（1 行）
├── 流式 tail（1 行，截断）
├── ConfirmPrompt（≤13 行）
└── Error（≤3 行）
```

## 工具系统

core 层工具注册中心：`registerTool({ name, description, inputSchema, execute })`。

| 工具 | 来源 |
|------|------|
| read / write / edit / shell | 内置（core/src/tools/） |
| search（grep）/ glob（文件匹配） | 内置 |
| web_search（DeepSeek 原生 + Tavily fallback）/ tavily_search / web_fetch | 内置 |
| pitfall_search / ref_outline / ref_retrieve / restore | 内置 |
| todo_write / update_plan | 内置（session 级状态，动态区最小 UI） |
| agent | 内置（子任务分解执行） |
| MCP 工具（mcp__ 前缀） | 外部 MCP 服务器 |

**搜索路由**：DeepSeek 模型 → Responses API 原生搜索；其他模型 → Tavily。结果过滤 `reasoning` 类型，上限 2000 字符。

**成本护栏（2026-08-16 定）**：每次 LLM 调用前检查会话/单日成本上限（`config.costGuardrails`，默认会话 ¥5 / 单日 ¥20，`enabled` 可关），超限停止当前任务并提示、不再发起调用；`/clear` 重置会话成本；单日账本按本地日期持久化在 `~/.shenlan/cost-ledger.json`（跨会话累计，测试用 `SHENLAN_COST_LEDGER` 重定向）；`/cost` 显示真实 usage 折算 CNY（无 usage 时回退估算），`/budget` 展示护栏状态与本会话/今日用量；headless `shenlan run` 不经护栏，仅在结果里输出 `costCny`

## 开发规范

- **版本号**：SemVer，`packages/cli/src/version.ts` 的 `VERSION` 与 `package.json` 同步，禁止重复发布
- **发布**：只发有变更的包（`@shenlan/core` / `@shenlan/cli`），不变不动
- **源码渠道**：MIT 源码以 GitHub `liam61-hub/shenlan` 为主仓，`master` 为主分支。源码变更经 PR 和 Ubuntu/Windows CI 审查；不得导入旧私有仓库历史、私有配置或凭据。
- **npm 发布（硬性）**：公开 npm 暂缓。私有包继续通过维护者本机配置的 registry 发布；仓库内不存 registry 地址或凭据。发版前必须汇报改动并取得用户明确确认；确认后才更新版本、发布记录并执行 `npm publish`。公开 npm 发布须另行明确批准。
- **发版节奏（2026-08-26 定）**：默认攒批发版——多个修复/功能在本地累积后一次发布，建议每周一个发版窗口；同一天多版连发（如 0.4.78 / 0.4.79 同日）需说明原因。减少发版次数同时节省 CI 分钟与 npm 版本噪音
- **修复后输出调试命令（硬性）**：每次修完问题或 `git push` 成功后，回复末尾列出 **源码调试**：`npm run build && node packages/cli/dist/index.js`。已有私有包用户可在本机 registry 配置下使用 `npm install -g @shenlan/cli` 和 `npm update -g @shenlan/cli`；公开 npm 前不得将这两条当作公共安装说明。不做代码改动无需输出。
- **文档**：README.md、SHENLAN.md、docs/site/ 与 docs/user-guide.md 面向用户；CONTRIBUTING.md 和 SECURITY.md 面向贡献者。旧规划和开发日志只留在私有归档。
- **默认模型**：deepseek-v4-flash（DeepSeek API）
- **平台**：Windows 10 优先，macOS 兼容，GBK 编码（CMD 不支持 UTF-8 .cmd）
- **Git 远端**：公开仓库的 `origin` 只指向 `https://github.com/liam61-hub/shenlan.git`。不得添加旧私有远端或双推配置。首次公开推送必须先提交快照与安全审计供用户审阅并获明确确认。

## 提交与 PR 规范

- Conventional Commits：`feat:` / `fix:` / `chore:` / `docs:` / `debug:`；版本号提交用 `chore: bump version to X.Y.Z`
- 提交保持聚焦；PR 目标 `master`，CI（Ubuntu/Windows + Node 22 的 `build` + `test`）必须通过，UI 改动附截图；macOS 由本地开发环境覆盖（2026-08-26 定：macOS CI 任务移除以省 Actions 额度）

## 文档体系

```
README.md           → 项目门面（人读）：安装、快速开始、功能一览
SHENLAN.md          → 人向项目说明：概要、模块结构、技术栈、构建/测试命令
AGENTS.md           → 本文件：共享规范唯一事实源（Codex 自动加载，Claude 经 @AGENTS.md 导入）
CLAUDE.md           → Claude Code 入口薄壳：@导入本文件 + Claude 特有约定
CONTRIBUTING.md     → 公开贡献说明
SECURITY.md         → 漏洞私下报告入口
```

**规则：CLAUDE.md 是薄壳，共享内容一律以本文件为准；禁止把本文件内容复制进 CLAUDE.md。**

## Codex 约定

- 默认沙箱只读：写文件、执行外部命令需要用户批准，不要绕过审批
- 用户级 skills 在 `~/.codex/skills`；仓库内置 skills 在 `packages/cli/builtin-skills/`
- 全局偏好写 `~/.codex/AGENTS.md`，不要提交进仓库
- 任务完成前必须跑 `npm run build && npm test` 验证
- **交互一致性默认（2026-08-16 定）**：交互/行为不确定时，一律与 Codex CLI / Claude Code CLI 保持一致（例：粘贴整段进输入框、Enter 才提交；工具失败普通展示不标红；确认弹窗 Codex 审批样式）
