# 贡献指南

感谢参与深蓝。请先在 [Issues](https://github.com/liam61-hub/shenlan/issues) 描述较大的功能或行为变更；小修复可直接提交 PR，目标分支为 `master`。

## 本地验证

使用 Node.js 22+。在仓库根目录运行：

```bash
npm ci
npm run build
npm test
npm run docs:site:build
```

TypeScript 使用 strict mode 和 NodeNext；相对导入写 `.js` 后缀。`core` 不依赖 UI，`cli` 负责终端交互。提交保持聚焦，使用 `feat:`、`fix:`、`docs:`、`test:`、`refactor:` 或 `chore:` 前缀；UI 变更请附截图或终端录屏。PR 需通过 Ubuntu 和 Windows 的 CI。

请勿提交 `.env`、`.npmrc`、`.shenlan/`、API Key、会话、个人数据或本机路径。发现安全漏洞请阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中披露细节。

源码使用 [MIT License](LICENSE)。贡献者提交代码即同意该贡献按 MIT License 发布。
