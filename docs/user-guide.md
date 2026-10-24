# shenlan 使用手册

> 面向终端用户的详细使用指南。安装与快速开始见 [README](../README.md)；本文档覆盖多模型配置与路由、权限与安全网、成本与预算、扩展能力（MCP/Skill/长任务等）四大专题。
> 版本：随主版本持续更新；命令以 `/help` 列出的为准。

## 一、多模型配置与路由

### 1.1 核心概念：配置的是 key，选择靠路由

shenlan **按 provider 配 key**（一个 provider 一个 key，该 provider 的全部模型即"可用"），模型选择由「自动路由 + 手动锁定」两层完成。全链路走 OpenAI 兼容协议：DeepSeek / Qwen / OpenAI 为内置 provider，其余任何兼容网关（Kimi、智谱、豆包、xAI、Mistral、OpenRouter、Anthropic 兼容端点等）经自定义入口接入。

### 1.2 配置方式（五种，可混用）

**① 首次向导（推荐一次性配齐）**
```bash
shenlan --setup
# Providers [1] DeepSeek [2] qwen [3] OpenAI [4] Custom OpenAI-compatible (default: 1)
# 输入 1,2,3 → 依次输入三个 key → 每个 provider 选一个模型 → 最后选默认模型
```
多选用逗号分隔（如 `1,2`）；空输入默认 DeepSeek；空 key 取消该 provider；重跑向导 = 合并更新（已有 key 保留）。

**② `/keys` 面板**：逐行 Enter 输入 key（掩码显示、粘贴支持、保存即测连通性）；`g`/`p` 切换全局/项目作用域；`d` 删除；选中 Custom 行按 Enter 是三步录入（Base URL → API Key → 模型名，模型名按前缀自动归属 provider，如 `gpt-5.4` → openai）。

**③ 配置文件**（`~/.shenlan/config.json` 全局 / `.shenlan/config.json` 项目）：
```json
{
  "providerKeys": { "deepseek": "sk-xx", "qwen": "sk-xx", "openai": "sk-xx" },
  "providerBaseUrls": { "claude": "https://api.anthropic.com" },
  "model": { "model": "deepseek-v4-flash" }
}
```
`providerBaseUrls` 用于自定义端点（带 `/v1` 后缀自动归一化，不会双重拼接）；Claude 经 Anthropic 官方 OpenAI 兼容端点、百炼托管快照（模型名 `deepseek-v4-pro-0813` + `providerKeys.bailian`）都按此方式接入。

**④ 环境变量**（优先级最高）：通用规则 `<PROVIDER>_API_KEY`，如 `DEEPSEEK_API_KEY`、`QWEN_API_KEY`、`OPENAI_API_KEY`（兼容历史 `GPT_API_KEY`）、`BAILIAN_API_KEY`；`SHENLAN_API_KEY` 为通用 fallback；`SHENLAN_BASE_URL` / `SHENLAN_MODEL` 可整体覆盖。

**⑤ 命令行（`shenlan config`，与 TUI 内 `/config` 等价）**：列出全部配置项与环境变量（敏感值掩码），`set` / `get` / `unset` 修改：
```bash
shenlan config set providerKeys.deepseek sk-xx --global
shenlan config set providerBaseUrls.claude https://api.anthropic.com
shenlan config get model.model
```
TUI 内直接输入 `/config`（不带参数）打开交互面板：↑/↓ 选择、**←/→ 切换布尔/枚举值**（如 `costGuardrails.enabled`、`permissions.mode`）、**Enter 行内编辑**文本/数字/Key（预填当前值）、`d` 恢复默认、`g`/`p` 切全局/项目作用域、Esc 关闭；修改即时写入并**对当前会话立即生效**（无需重启）。

界面语言经 `language` 键设置（`en` / `zh-CN`，**默认英文**）：`shenlan config set language zh-CN --global`，或在面板中选中 `language` 行用 ←/→ 切换；配置注释与 `/config` 面板文案随语言即时切换。

### 1.3 自动路由（默认 cost-first，开箱即用）

按「哪些 provider 有 key」+ 任务类型动态选型，无需干预：

| 任务 | 自动选择 |
|------|----------|
| 普通闲聊 | 可用集中**最便宜**（如 qwen-turbo 0.9 < gpt-5.4-mini） |
| 编码 / 推理 / 长上下文 | 同档**最强**（如 qwen3.7-max / gpt-5.4） |
| 发 `@图片.png` | 自动切**视觉模型**（qwen-vl-max / gpt-5.4），图片以 image_url 直传 |
| `quality-first` 策略 | 一律最强 |

要点：
- **会话粘性**：本会话首轮路由结果在后续轮次沿用；中途发图会**单向升级**为视觉模型（文本轮不回退）
- **价格驱动**：按生效价格（手动 > 自动同步 > 内置）择优；`/prices check` 联网同步官方价后立即影响下次路由
- **目录外模型**（自定义录入的）：直接采用为默认模型，不参与自动路由；内置目录见 README 模型表（`npm run docs:models` 从代码自动生成）
- **故障转移**（可选）：`/config set providerFailover.enabled true` —— 当前模型 5xx/402/429/网络/超时错误时自动切同档模型重试一次
- 未知 provider 未配 baseUrl 时会**显式报错引导**（不再静默回退 DeepSeek）

### 1.4 手动控制

```bash
/model                 # 查看当前模型/策略
/model                 # （无参进入面板时）按目录分组查看全部模型、可用性、价格
/model gpt-5.4         # 锁定单一模型（policy → manual，持久化，重启恢复）
/model quality-first   # 策略：一律最强
/model cost-first      # 策略：按价格（默认）
/model auto            # 恢复自动路由（保留配置基线）
```
锁定与策略切换均持久化到配置（`routing` 字段）；`/model` 面板中手动锁定后 ✔ 只在锁定行。

## 二、权限与安全网

### 2.1 权限模式（Shift+Tab 循环切换）

| 模式 | 标签 | 行为 |
|------|------|------|
| `default` | NORMAL | 写文件/执行外部命令需确认 |
| `plan` | PLAN | 只读规划态：write/edit/shell 拒绝（只放行 read/search 与 `planMode.readonlyCommands` 白名单命令） |
| `acceptEdits` | ACCEPT EDITS | 文件编辑自动接受，shell 仍确认 |
| `bypassPermissions` | BYPASS | 全部放行（危险操作仍受安全网拦截） |

`/permissions` 查看当前模式与配置的 allow/deny 列表；权限配置可改 `permissions.allow` / `permissions.deny`（工具名：read/write/edit/shell/search/glob 等）。

### 2.2 动作安全网（配置 `actionSafety`，默认生效）

- **高危命令硬拦截**：`highRiskActions` 默认 `deny`（`rm -rf`、`git push --force`、`format` 等），改 `confirm` 后需输入确认短语（`confirmPhrase`，默认 `yes`）二次确认
- **写保护**：`protectedPaths` 命中（realpath + glob）时 write/edit 直接拒绝
- **敏感命令无条件 deny**：`env`/`printenv`、密钥路径读取等
- **审计**：所有动作审计事件落 `.shenlan/audit.jsonl`（高危类不可关闭）；`/audit` 查看，`shenlan audit` 命令等价

### 2.3 确认弹窗（Codex 审批样式）

模态框显示要执行的操作（shell 命令带 `$` 前缀、写/改文件为 `✎ path`），三个选项固定：**通过(y) / 拒绝(d) / 终止(Esc)**，支持上下键选择 + Enter 确认。弹窗显示期间输入框隐藏，已输入内容保留；终止会清理未完成的 tool_calls 并停止本次任务。

### 2.4 提交安全检查（/security）

`/security` 面板一键安装 pre-commit 钩子：git 提交时扫描暂存区，命中 `.env*`、`.shenlan/config.json`、密钥等敏感内容时**拦截提交**。面板支持安装/重装、卸载、重扫；已存在他人钩子时不覆盖。

## 三、成本与预算

### 3.1 成本护栏（配置 `costGuardrails`，默认启用）

- 默认上限：**会话 ¥5 / 单日 ¥20**（`enabled: false` 可整体关闭）
- 每次 LLM 调用前检查；**超限停止当前任务并弹窗**，弹窗可选：停止 / 继续本次（豁免会话）/ 调整上限
- 会话成本 `/clear` 重置；单日账本持久化在 `~/.shenlan/cost-ledger.json`（跨会话累计）

### 3.2 查看与调整

```bash
/cost                     # 本会话 token 用量与折算 CNY（无 usage 时回退估算）
/budget                   # 护栏状态、会话/今日用量进度、豁免信息
/prices                   # 价格表（manual > auto > 内置，来源标注）
/prices check             # 联网同步官方价格（新模型自动新增、差异自动更新）
/config get costGuardrails            # 查看护栏配置
/config set costGuardrails.maxCostPerSession 10   # 调会话上限
/config set costGuardrails.enabled false          # 关闭护栏
```
手动调价：编辑 `~/.shenlan/prices.json` 的 `manual` 分区（如 `{"gpt-5.4": {"inputPrice": 20}}`），**立即影响 cost-first 路由**。

### 3.3 余额预检

启动时自动预检 DeepSeek 账户余额（仅当主力模型在 DeepSeek 上时执行）：余额不可用/偏低给出警告，失败不阻断启动；可通过 `costGuardrails.balanceCheckBeforeStart` 关闭。

## 四、扩展能力

### 4.1 MCP 接入

配置 `mcpServers`（HTTP 与 stdio 两种 transport，见 README 配置 MCP Server 一节）；密钥用 `env:变量名` 引用环境变量避免入文件。接入后工具自动注册，工具名 `mcp__<server>__<tool>`；`/mcp` 面板管理连接状态（启停/重连/刷新）。

### 4.2 Skills

每个 skill 是一个含 `SKILL.md` 的目录（frontmatter：`name` + `description`）：

```
.shenlan/skills/my-skill/SKILL.md    # 当前项目（跟仓库走）
~/.config/shenlan/skills/...          # 本机所有项目
```

- **显式触发**：输入 `$my-skill` 强制调用
- **自动触发**：AI 根据 description 匹配
- **`$create-skill`**：内置 skill，直接让 AI 帮你创建新 skill

### 4.3 长任务与规划

```bash
/goal 把全部测试跑绿      # 长任务目标模式（最大步数独立、完成自动收尾并调用 goal_complete）
/plan                     # 规划模式：先只读分析（write/edit/shell 拒绝）
/plan save [标题]         # 保存规划到 .shenlan/plans/
/agents <任务>            # 拆解为编号子任务并行执行（/a 同义）
```
后台探索 agent：长任务中 AI 可自动派发 `background_agent` 子任务（并发上限 3），动态区显示 `⏳ bg: …`；`/stop` 终止当前任务（含全部后台任务）。

### 4.4 会话管理

```bash
shenlan --continue        # 继续上次会话
shenlan --resume <id>     # 恢复指定会话（/sessions 查看列表）
/clear                    # 清空会话（状态/成本/todos/plan 重置；历史保留在终端滚动区可上滑查看）
/undo                     # 撤销上次文件修改（快照）
/trash [empty]            # 回收站（删除的文件可恢复，restore 工具；empty 清空）
/compact [聚焦主题]       # 手动压缩上下文（LLM 摘要或规则摘要，保留最近 N 轮）
/context                  # 上下文占用分析（token 分布、压缩记录）
/cleanup                  # 清理快照
```

### 4.5 其他常用

```bash
/config get|set|unset <key> [--global]   # 通用配置机制（Tab 键路径补全）
/pitfall [add <内容> | import]           # 坑记忆：已知坑动作前拦截（hard）/ 命中统计（soft）
/memory on|off                           # 自动记忆开关（.shenlan/memories 落盘，下轮注入）
/security                                # 提交安全检查钩子
/help                                    # 全部命令
```

## 五、命令速查

| 命令 | 作用 |
|------|------|
| `/model [auto\|cost-first\|quality-first\|<模型名>]` | 路由策略与手动锁定（持久化） |
| `/keys` `/mcp` `/skills` `/security` | 配置面板 |
| `/permissions` `/plan` | 权限模式查看 / 规划模式 |
| `/cost` `/budget` `/prices [check]` | 成本、护栏、价格 |
| `/context` `/compact` `/undo` `/trash` `/cleanup` `/clear` | 会话与上下文管理 |
| `/goal` `/agents` `/stop` | 长任务与子代理 |
| `/config` `/pitfall` `/memory` `/audit` | 配置与记忆 |
| `/sessions` `/help` `/quit` | 会话列表 / 帮助 / 退出 |

快捷键：`Shift+Tab` 切换权限模式，`Esc` 关闭弹窗/终止确认，`↑/↓` 输入历史，Tab 补全（斜杠命令与 /config 键路径）。
