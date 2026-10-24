# PTY E2E 回归套件

真实 PTY + 本地 mock LLM 的端到端回归（不依赖外部网络，不碰真实配置）。
每个 `drive_*.py` 自包含：启动本地 mock 服务器 → 伪终端拉起 CLI → 模拟输入 →
断言字节流/磁盘/请求日志，失败时退出码非 0。

## 运行

```bash
npm run test:e2e        # 等价于 npm run build && python3 packages/cli/e2e/run_e2e.py
```

runner 会依次运行全部 `drive_*.py`，再运行真机脚本（`LIVE_SCRIPTS`，默认 SKIP），
最后汇总三态。退出码契约（脚本 → runner 汇总）：

| 脚本退出码 | 汇总显示 | 影响总体 exit code |
|---|---|---|
| `0` | `PASS` | 否 |
| `77` | `SKIP(原因)` | **否**（未跑不等于失败，但必须单独成行可见） |
| 其他 | `FAIL(n)` | 是（总体 exit 1） |

77 取 autotools 的 SKIP 约定。SKIP 不能用 0：真机脚本没跑却显示 PASS，
等于让发布清单靠一个从未执行的脚本打勾。

## 前提

- macOS / Linux（脚本用 `pty.fork`，Windows 不支持）
- 已 `npm run build`（runner 会检查 `dist/index.js`）
- 本地端口空闲：9888（mock）、9895（resume）、9901（confirm）、9905（empty）、9910（filecard）、9911（resume_toolcard）、9912（clear）、9921（typewin）
- 运行环境允许绑定 localhost 端口（沙箱/审批场景需先授权）

运行时 scratch 目录默认 `/private/tmp/shenlan-pty-check`，可用环境变量覆盖：

```bash
SHENLAN_E2E_SCRATCH=/tmp/my-e2e python3 packages/cli/e2e/run_e2e.py
```

## 驱动清单

| 脚本 | 覆盖场景 |
|------|----------|
| `drive_mock.py` | 35 轮长任务、模型粘性、write 权限弹窗（y/Shift+Tab bypass）、退出码、无整屏清空 |
| `drive_resume.py` | /exit 落盘、--resume 恢复历史、SIGTSTP/SIGCONT、SIGTERM/SIGINT 兜底落盘、/clear 重置（无任何清屏/清滚动区序列，旧内容保留可上滑） |
| `drive_confirm.py` | 确认弹窗 y/Enter/Esc→反馈/Ctrl+C 终止/shell 弹窗，弹窗后界面仍可响应 |
| `drive_empty.py` | 空回复自动重试、连续空回复兜底、请求负载无空 assistant 消息 |
| `drive_filecard.py` | write 新增/覆盖/edit 三张变更卡片：✏️ Added/Updated、预览行、滚动区持久、磁盘验证 |
| `drive_resume_toolcard.py` | 旧会话（含工具历史）恢复：工具行仍为单行摘要、无卡片残留、不崩溃 |
| `drive_clear.py` | /clear：不清屏（无 `\x1b[2J`/`\x1b[3J`）、旧内容保留可上滑、确认提示紧贴输入框、清空后继续对话、不发起 LLM |
| `drive_typewin.py` | 输入行水平开窗（Windows 左移修复）：193×50 与 60×20 两档 PTY，打字全程无 2J/3J、帧内无满宽行、超宽输入窗口化（… + 光标 █ 恒可见）、DSR 帧尾列 0、中文输入、退出码 0 |
| `vision_e2e.mjs` | **真机**（默认 SKIP）：qwen-vl-max 收到 OpenAI 兼容 `image_url` 内容块并返回描述，见下节 |

## 维护约定

- 新增回归场景时在 e2e 目录加 `drive_*.py`，runner 自动纳入。
- 脚本保持自包含（mock、PTY、断言都在一个文件内），便于单跑排查：
  `python3 packages/cli/e2e/drive_filecard.py`

## 视觉真机验证（清单 #11）

`vision_e2e.mjs` 真实验证 qwen-vl-max 收到 OpenAI 兼容 `image_url` 内容块。
它是**唯一打真端点、消耗真实 token 的脚本**，所以双重 opt-in：既要
`SHENLAN_E2E_LIVE=1`，也要本机有 qwen key，任一缺失即 `exit 77` SKIP。

```bash
# 默认：随套件跑，汇总里显示 SKIP(live test not enabled ...)，不花钱
npm run test:e2e

# 真机：需 SHENLAN_E2E_LIVE=1 + providerKeys.qwen / QWEN_API_KEY
SHENLAN_E2E_LIVE=1 npm run test:e2e
SHENLAN_E2E_LIVE=1 node packages/cli/e2e/vision_e2e.mjs   # 单跑
```

- 不是 `pty.fork`，是普通 node 脚本，**Windows 也能跑**
- PASS 判定：HTTP 200 + 模型返回非空图片描述（1x1 透明 PNG）
- 退出码：`0` PASS / `77` SKIP（未 opt-in 或无 key）/ 其他 FAIL
- 若 FAIL：检查 `QWEN_API_KEY` / `providerKeys.qwen` 与 dashscope 端点连通性
