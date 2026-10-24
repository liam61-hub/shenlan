# 深蓝（shenlan）项目说明

## 项目概要

深蓝（shenlan）—— 运行在本地终端上的开源 Agent 工作台：会话和密钥默认保存在本机，模型请求发送给用户配置的服务商。TypeScript + Node.js 22+，npm workspaces monorepo，实现 Agent 核心闭环（LLM 调用 → 工具执行 → 结果回填）。

首次运行自动生成 `~/.shenlan/` 与项目 `.shenlan/` 配置目录（含 `config.sample.json` / `README.md` / `env.example` 样例）；API Key 支持界面（欢迎引导、`/keys`、`--setup`）、手动配置文件、环境变量、`.env` 文件四种方式，详见 [README.md](./README.md)「快速开始」。

## 模块结构

```
packages/core/   # @shenlan/core — 内核：LLM 调用、工具系统、会话存储、配置、上下文压缩
packages/cli/    # @shenlan/cli — 终端：Ink 7 TUI（非 alternate screen，原生滚动回滚区模型）、Agent 循环、slash 命令
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
| `npm test` | Vitest 运行全部单测（`packages/*/src/**/*.test.ts`） |
| `npm run test:e2e` | PTY 端到端回归（本地 mock LLM，`packages/cli/e2e/`，macOS/Linux） |
| `npm run dev` | 监听模式增量编译 |
| `npm run clean` | 清理各包 `dist/` 与 `node_modules` |

本地运行 CLI：`node packages/cli/dist/index.js`；单包操作如 `npm run build --workspace @shenlan/core`。

E2E 细节（驱动清单、端口、scratch 目录覆盖）见 [packages/cli/e2e/README.md](./packages/cli/e2e/README.md)。

## 文档体系

```
README.md           → 项目门面（人读）：安装、快速开始、功能一览
SHENLAN.md          → 本文件：人向项目说明（概要、结构、技术栈、命令）
CONTRIBUTING.md     → 贡献流程
SECURITY.md         → 私下报告安全漏洞的方式
```

参与开发时，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。
