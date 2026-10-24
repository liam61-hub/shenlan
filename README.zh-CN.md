# 深蓝（shenlan）

运行在本地终端上的开源 Agent 工作台：模型自带（BYOK），会话、密钥和记忆默认保存在本机。调用模型时，请求内容会发送给你配置的模型服务商。深蓝兼容 OpenAI 兼容端点，内置多模型路由、成本护栏和动作安全网。

> 📖 详细使用手册（多模型路由 / 权限与安全网 / 成本预算 / MCP·Skill·长任务）：[docs/user-guide.md](docs/user-guide.md)

## 从源码运行

```bash
git clone https://github.com/liam61-hub/shenlan.git
cd shenlan
npm ci
npm run build
node packages/cli/dist/index.js --version
node packages/cli/dist/index.js
```

需要 Node.js 22+。公开 npm 包尚未发布；已有私有包用户继续使用各自的本机 registry 配置。源码更新请从 GitHub 拉取后重新构建。

## 参与贡献与报告漏洞

提交改动请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。普通问题使用 [GitHub Issues](https://github.com/liam61-hub/shenlan/issues)；安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，避免公开漏洞细节。

## 快速开始

### 首次使用（3 分钟上手）

1. 安装完成后运行 `shenlan`。首次启动会自动生成两个配置目录（内含配置样例）：
   - 全局 `~/.shenlan/`：`config.json` + `config.sample.json` + `README.md` + `env.example`
   - 项目 `.shenlan/`：同上（在新目录第一次使用 CLI 时自动生成）
2. 未配置 API Key 时，欢迎引导自动弹出：`Enter` 进入配置 → 粘贴 Key → `Enter` 保存（自动测连通性）→ 展示快速上手（`/model` `/goal` `/security` `/keys` `/help`）→ `Enter` 开始使用。可随时 `Esc` 跳过，之后用 `/keys` 或 `shenlan --setup` 再配。
3. 直接输入问题开始对话；`/help` 查看全部命令，`Shift+Tab` 切换权限模式。

### 配置 API Key（5 种方式）

优先级：真实环境变量 > 项目 `.env` > 全局 `~/.shenlan/.env` > 项目配置 > 全局配置。

1. **界面配置**：首次运行欢迎引导、`/keys` 面板（掩码显示、支持粘贴、保存后自动测连通性、`g`/`p` 切全局/项目作用域）、`shenlan --setup` 向导。
2. **命令行配置**：`shenlan config` 列出全部配置项与环境变量（敏感值掩码），`shenlan config set/get/unset` 修改配置（与 TUI 内 `/config` 等价）：
   ```bash
   shenlan config set providerKeys.deepseek sk-xxx --global
   shenlan config set language zh-CN --global   # 界面语言（默认 en）
   shenlan config get model.model
   ```
3. **手动编辑配置文件**：在 `~/.shenlan/config.json`（全局）或 `.shenlan/config.json`（项目）写 `providerKeys`：
   ```json
   { "providerKeys": { "deepseek": "sk-xxx", "qwen": "sk-xxx" } }
   ```
   字段说明与完整样例见 `~/.shenlan/config.sample.json` 与 `~/.shenlan/README.md`。
4. **环境变量**：通用规则 `<PROVIDER>_API_KEY`，`SHENLAN_API_KEY` 为通用 fallback。环境变量优先级最高。
   ```bash
   export DEEPSEEK_API_KEY=sk-xxx
   # 或通用 fallback
   export SHENLAN_API_KEY=sk-xxx
   ```
5. **.env 文件**：项目 `cwd/.env` 或全局 `~/.shenlan/.env` 写 `KEY=VALUE`；真实环境变量优先，项目 `.env` 优先于全局 `.env`。格式样例见 `.shenlan/env.example`。
   ```bash
   DEEPSEEK_API_KEY=sk-xxx
   QWEN_API_KEY=sk-xxx
   ```

> ⚠️ `.env*` 与 `.shenlan/config.json` 会被提交时安全检查（`shenlan security` / pre-commit 钩子）拦截，不要提交到 git。

### 验证

```bash
# 启动交互式 REPL
shenlan

# 或单次任务
shenlan run "读取 README.md，总结一下项目功能"
shenlan run --readonly "读取 README.md，总结一下项目功能"   # readonly 仅放行 read/search 工具
```

## 日常使用

```bash
# 交互模式
shenlan                          # 进入 REPL，对话式交互
shenlan --continue               # 继续上次会话
shenlan --resume <id>            # 恢复指定会话

# 单任务模式
shenlan run "修复 src/index.ts 的类型错误"
shenlan run --readonly "巡检项目状态"

# 首次设置向导
shenlan --setup

# 查看 / 修改配置（同 /config，敏感值掩码）
shenlan config
shenlan config set agent.maxSteps 100

# 查看版本
shenlan --version
```

### REPL 交互示例

```
❯ 帮我创建一个新的 skill
❯ 读取 package.json，看看有哪些依赖
❯ /plan               进入规划模式，先只读分析
❯ /keys               配置 / 查看 API Key（掩码显示）
❯ /config             交互配置面板：←/→ 切换，Enter 编辑，改完即生效
❯ /goal 把全部测试跑绿   长任务目标模式（完成自动收尾）
❯ /security           提交时安全检查（pre-commit 钩子）
❯ /cost               查看 token 消耗
❯ /budget             成本护栏状态（进度 / 豁免 / goal）
❯ /undo               撤销上次文件修改
❯ Shift+Tab           切换权限模式
```

### 配置 MCP Server

编辑 `~/.shenlan/config.json`（全局）或 `.shenlan/config.json`（项目），添加 `mcpServers`：

**HTTP 方式：**

```json
{
  "mcpServers": [{
    "name": "my-knowledge",
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": {
      "X-Api-Key": "env:MY_MCP_KEY"
    }
  }]
}
```

**stdio 方式（本地命令行启动）：**

```json
{
  "mcpServers": [{
    "name": "my-knowledge-mcp",
    "transport": "stdio",
    "command": "my-knowledge-mcp",
    "args": [],
    "env": {
      "KNOWLEDGE_API_URL": "http://your-server:8100",
      "KNOWLEDGE_API_KEY": "your-api-key"
    }
  }]
}
```

启动后 MCP 工具自动注册，工具名格式为 `mcp__<server>__<tool>`。`env:变量名` 引用环境变量，避免密钥入文件。

### 使用 Skill

每个 skill 是一个目录，包含 `SKILL.md`：

```
.shenlan/skills/
├── my-skill/
│   └── SKILL.md          # skill 定义（必需）
└── another-skill/
    ├── SKILL.md
    └── references/        # 参考文件（可选）
```

**SKILL.md 格式：**

```markdown
---
name: my-skill
description: 一句话描述，AI 据此决定何时触发
---

# My Skill

具体的指令内容，告诉 AI 如何使用这个 skill
```

**触发方式：**
- 显式：输入 `$my-skill` 强制调用
- 自动：AI 根据 description 匹配合适时自动加载

**存放位置：**

| 位置 | 范围 |
|------|------|
| `.shenlan/skills/` | 当前项目，跟仓库走 |
| `~/.config/shenlan/skills/` | 本机所有项目 |

shenlan 内置了 `$create-skill` skill，可直接让 AI 帮你创建新 skill。

首次运行会自动创建全局 `~/.shenlan/` 与项目 `.shenlan/` 目录：`config.json`（实际生效）+ `config.sample.json`（完整样例）+ `README.md`（字段说明）+ `env.example`（.env 样例）。项目配置优先级高于全局配置。

## 项目结构

```
shenlan/
├── packages/core/   # @shenlan/core — 内核（LLM 调用、工具系统、会话存储、配置、MCP/Skill/权限，零 UI 依赖，可独立单测）
├── packages/cli/    # @shenlan/cli — 终端（Ink 7 TUI、Agent 循环、slash 命令、内置 skills）
├── tsconfig.base.json
└── package.json     # npm workspaces
```

**依赖方向**: `cli` → `core`，core 零 UI 依赖。

## 技术栈

- **语言**: TypeScript (strict mode, ES2022 + NodeNext)
- **运行时**: Node.js 22+
- **包管理**: npm workspaces (monorepo)
- **终端**: Ink 7.1（React 19）TUI，有界动态区 + 原生滚动回滚区
- **LLM**: 原生 fetch 调用 OpenAI 兼容 API（DeepSeek / Qwen / OpenAI / 任意 OpenAI 兼容网关）
- **存储**: JSONL 文件存储会话

## 支持的模型

<!-- model-table:start -->
| 模型 | 定位 | 上下文 |
|------|------|--------|
| `deepseek-v4-flash` | 快速/经济 | 1M tokens |
| `deepseek-v4-pro` | 强推理 | 1M tokens |
| `deepseek-v4-pro-0813` | 强推理 | 1M tokens |
| `qwen-turbo` | 快速/经济 | 1M tokens |
| `qwen-plus` | 均衡 | 128K tokens |
| `qwen-max` | 最强推理 | 128K tokens |
| `qwen3.7-flash` | 快速/经济 | 1M tokens |
| `qwen3.7-plus` | 均衡 | 128K tokens |
| `qwen3.7-max` | 最强推理 | 128K tokens |
| `qwen3.8-max` | 最强推理 | 128K tokens |
| `qwen3.8-2.4t-a95b` | 最强推理 | 128K tokens |
| `qwen-vl-max` | 最强（视觉） | 131K tokens |
| `gpt-5.4` | 强推理（视觉） | 400K tokens |
| `gpt-5.4-mini` | 快速/经济 | 400K tokens |
<!-- model-table:end -->

路由默认 cost-first：按生效价格（手动 > 自动同步 > 内置）动态选型，普通任务选最便宜，编码 / 推理 / 长上下文自动切最强；`/model auto|cost-first|quality-first|<模型名>` 可切换并持久化（重启恢复）。模型表由 `npm run docs:models` 从代码目录（MODEL_CATALOG）自动生成。

### 接入任意 OpenAI 兼容模型（第三方网关 / Anthropic / Gemini / xAI / Mistral …）

shenlan 全链路走 OpenAI 兼容协议，任何提供兼容端点的模型都能接：

1. 运行 `shenlan --setup`，选择 `4 Custom OpenAI-compatible`（或 `/keys` 里选中 Custom 行按 Enter），三步录入：
   - **Base URL**：兼容端点根路径（如 `https://openrouter.ai/api`；留空 = 按模型名自动推导官方端点）
   - **API Key**：留空取消
   - **模型名**：自由文本（如 `gpt-5.4`、`claude-sonnet-4-5`、`deepseek-v4-pro-0813`、`llama-3.1-70b`），按前缀自动归属 provider（`gpt-*` → openai、`deepseek-v4-pro-0813` → 百炼等）
2. 或直接改配置文件：`providerKeys` 写 key、`providerBaseUrls` 写端点（带 `/v1` 后缀会自动归一化，避免双重拼接）。
3. 目录外模型 + 有效 key 会被直接采用为默认模型（不参与自动路由）；目录内模型（上表）按 cost-first 自动路由。

**只配 key 就能用的 provider（端点内置，无需 Base URL）**：deepseek、qwen、百炼（bailian）、openai，以及豆包 / 智谱 / Kimi：

| 模型名前缀 | provider | 环境变量 | 内置端点 |
|---|---|---|---|
| `doubao-*` / `skylark-*` | doubao | `DOUBAO_API_KEY` | 火山方舟 `ark.cn-beijing.volces.com/api/v3` |
| `glm-*` | zhipu | `ZHIPU_API_KEY` | 智谱 `open.bigmodel.cn/api/paas/v4` |
| `moonshot-*` | kimi | `KIMI_API_KEY` | Moonshot 国内站 `api.moonshot.cn` |

这三家不进模型目录（价格/窗口未核实），走「目录外模型 + 有效 key 直接采用」路径，成本按同档回退估算记账。海外账号 key 与国内不互通，需覆盖端点：`providerBaseUrls` 写 `{"kimi": "https://api.moonshot.ai"}`。

示例（Claude 经 Anthropic 官方 OpenAI 兼容端点、百炼托管快照）：

```json
{
  "providerKeys": { "claude": "sk-ant-xxx", "bailian": "sk-百炼key" },
  "providerBaseUrls": { "claude": "https://api.anthropic.com" }
}
```

环境变量等价写法：`export ANTHROPIC_BASE_URL=...`、`export BAILIAN_API_KEY=sk-xxx`（通用规则 `<PROVIDER>_API_KEY`，openai 兼容 `OPENAI_API_KEY` 与历史 `GPT_API_KEY`）。

## 配置

配置优先级（高到低）：真实环境变量 > 项目 `.env` > 全局 `~/.shenlan/.env` > 项目 `.shenlan/config.json` > 全局 `~/.shenlan/config.json`

首次运行自动生成 `~/.shenlan/` 与项目 `.shenlan/` 目录：`config.json`（实际生效）+ `config.sample.json`（完整字段样例）+ `README.md`（字段说明）+ `env.example`（.env 样例）。样例文件缺失时会在下次启动自动补写，已存在的文件不会被覆盖。

### 环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `OPENAI_API_KEY` / `BAILIAN_API_KEY` | 各 provider 的 API Key（通用规则 `<PROVIDER>_API_KEY`；也可写入配置 `providerKeys`，环境变量优先；`OPENAI_API_KEY` 兼容历史 `GPT_API_KEY`） |
| `SHENLAN_API_KEY` | 通用 fallback Key |
| `SHENLAN_BASE_URL` | API 端点覆盖（默认按模型 provider 自动解析：deepseek → `api.deepseek.com`，qwen → dashscope compatible-mode） |
| `SHENLAN_MODEL` | 模型名覆盖 |
| `TAVILY_API_KEY` | Tavily 搜索 Key（无原生搜索的模型联网搜索 fallback） |

### .env 文件

- 位置：项目 `cwd/.env`（优先）或全局 `~/.shenlan/.env`（兜底）。
- 格式：每行 `KEY=VALUE`，支持 `#` 注释、`export ` 前缀与引号；真实环境变量（shell export）优先于 `.env`。
- 样例：`.shenlan/env.example`（新目录首跑自动生成）。

```bash
# 项目根目录 .env
DEEPSEEK_API_KEY=sk-xxx
QWEN_API_KEY=sk-xxx
```

### 配置文件

配置写在 `~/.shenlan/config.json`（全局）或 `.shenlan/config.json`（项目），示例：

```json
{
  "model": {
    "baseUrl": "",
    "apiKey": "",
    "model": "deepseek-v4-flash",
    "maxTokens": 8192
  },
  "providerKeys": {
    "deepseek": "sk-xxx",
    "qwen": "sk-xxx"
  },
  "permissions": {
    "mode": "default",
    "allow": ["read", "search"],
    "deny": []
  },
  "skills": [],
  "mcpServers": []
}
```

`model.baseUrl` 留空时按模型 provider 自动解析端点；API Key 优先级：环境变量 `<PROVIDER>_API_KEY` > `providerKeys` > `model.apiKey`。`--setup` 向导可同时配置 DeepSeek / qwen（key 写入 `providerKeys`，选择默认模型并逐个连通性测试）。

完整字段样例见 `~/.shenlan/config.sample.json`（全局）与 `.shenlan/config.sample.json`（项目），字段说明见各目录下的 `README.md`。密钥相关文件权限为 0600、全局目录 0700，仅本用户可读。

### 权限模式

| 模式 | 读操作 | 写操作 | Shell |
|------|--------|--------|-------|
| `default` | 自动放行 | 需确认 | 需确认 |
| `acceptEdits` | 自动放行 | 自动放行 | 需确认 |
| `bypassPermissions` | 自动放行 | 自动放行 | 自动放行 |
| `plan` | 只读规划态 | 一律拒绝 | 一律拒绝 |

> plan 态优先级最高：write / edit / shell 一律拒绝（即使此前处于 bypass），其余工具放行。

## 内置工具

| 工具 | 说明 |
|------|------|
| `read` | 读取文件，支持行范围 |
| `write` | 写入文件（自动快照，可 /undo） |
| `edit` | 精确字符串替换编辑（自动快照） |
| `shell` | Shell 命令执行（高危命令拦截；超时转后台不杀进程） |
| `shell_status` / `shell_kill` | 查看后台 shell 命令状态 / 终止（shell 超时后产生） |
| `search` | 正则内容搜索（ripgrep） |
| `glob` | 文件名模式匹配（支持 ** 递归） |
| `web_search` | 联网搜索（DeepSeek / qwen 原生，其他模型走 Tavily；原生失败不降级） |
| `web_fetch` | 抓取网页内容 |
| `pitfall_search` | 按 trigger / symptom 检索坑记录 |
| `ref_outline` / `ref_retrieve` | 查看外置引用目录 / 取回全文 |
| `restore` | 从回收站恢复文件（配合 /trash） |
| `todo_write` / `update_plan` | 任务待办与执行计划（动态区最小 UI） |
| `agent` | 派生子 agent 独立执行子任务（主循环内串行，/agents 并行编排） |
| `memory_save` | 保存跨会话记忆（/memory 查看；memory.autoSave=false 时不可见） |
| MCP 动态工具 | 按配置挂载 server 自动注册 |

## Slash 命令

| 命令 | 说明 |
|------|------|
| `/help` `/h` | 显示帮助 |
| `/model [name]` | 查看或切换模型 |
| `/keys` | 配置 / 查看 API Key（掩码显示，全局/项目级，支持粘贴） |
| `/security` | 提交时安全检查（pre-commit 钩子状态 / 安装卸载 / 手动扫描） |
| `/goal [目标]` | 长任务目标模式（`/goal <可验证目标>`，`pause`/`resume`/`clear`） |
| `/mcp` | 管理 MCP servers |
| `/skills` | 列出已安装 skills |
| `/memory` | 查看本地记忆 |
| `/permissions` | 查看权限模式 |
| `/sessions` | 列出会话 |
| `/plan [save]` | 进入 Plan Mode（/plan off 退出需确认，/plan save [标题] 落盘计划） |
| `/agents` `/a` | 子代理分解执行任务 |
| `/cost` | 查看本会话成本 |
| `/budget` | 成本护栏状态（进度 / 豁免 / goal） |
| `/prices` | 查看价格表（/prices check 手动触发官方同步） |
| `/context` | 上下文构成与压缩阈值 |
| `/compact` | 手动压缩上下文 |
| `/undo` | 撤销上次 write/edit |
| `/pitfall` | 查看项目坑记录 |
| `/trash` | 回收站管理 |
| `/temp` `/audit` | 查看快照数量 / 会话与模型审计 |
| `/cleanup` | 清理快照文件 |
| `/clear` | 清空会话（不清屏、保留滚动区，确认提示紧贴输入框） |
| `/stop` | 停止当前任务 |
| `/quit` `/exit` `/q` | 退出 |

## 会话存储

会话以 JSONL 格式存储在 `~/.local/share/shenlan/sessions/` 目录下（macOS/Linux；Windows 为 `%LOCALAPPDATA%\shenlan\sessions`），每行一个消息事件。

## 开发

```bash
# 编译
npm run build

# 运行全部单测（vitest）
npm test

# 监听编译
npm run dev

# PTY 端到端测试（macOS/Linux，需 python3，见 packages/cli/e2e/README.md）
npm run test:e2e

# 清理编译产物
npm run clean
```

## 设计原则

- **内核零 UI 依赖**: 所有决策逻辑在 core，CLI 只做渲染与输入
- **可测试性优先**: 每个模块独立，可单测
- **配置驱动**: 模型名、权限规则、skill 目录全部可配置

## 版本

当前 **v0.4.90**（以 [CHANGELOG.md](./CHANGELOG.md) 为准）

## License

MIT
