# shenlan 项目规范

@AGENTS.md

## Claude Code 约定

- 修改 TUI 前先读 AGENTS.md 的 TUI 架构约束（`<Static>` 原生回滚区 + 有界动态区 + InputBox，勿引入内部滚动视口）
- 构建/测试：`npm run build && npm test`；本地启动 `node packages/cli/dist/index.js`
- GitHub 主仓 `master` 的变更先经过 PR 和 CI；npm 发布仍需单独审批
- 共享规范一律以 AGENTS.md 为准，不要把 AGENTS.md 内容复制到本文件
- hooks、自定义 slash 命令等 Claude 专属配置放 `.claude/` 目录
