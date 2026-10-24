#!/bin/sh
# shenlan-dev — 本地源码版 shenlan 启动器（任意目录可用）
#
# 等价于「先增量构建，再以源码版 CLI 启动」，但保留启动时的 cwd
# （项目配置/会话按启动目录生效，与安装版行为一致）。
#
# 安装（加到 PATH）：
#   ln -s "$(pwd)/scripts/shenlan-dev.sh" ~/.local/bin/shenlan-dev
#
# 用法：shenlan-dev [参数...]（如 --version、run "任务"）
set -e

# 解析可能的符号链接，得到脚本真实路径（macOS readlink 无 -f）
SCRIPT_PATH=$0
RESOLVED=$(readlink "$SCRIPT_PATH" 2>/dev/null || echo "$SCRIPT_PATH")
case "$RESOLVED" in
  /*|[A-Za-z]:/*) ;;  # 绝对路径含 Windows 盘符（shim 以 D:/... 调用时）
  *) RESOLVED="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)/$RESOLVED" ;;
esac

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$RESOLVED")/.." && pwd)
ORIG_DIR=$(pwd)

cd "$REPO_DIR"
npm run build >/dev/null
cd "$ORIG_DIR"

exec node "$REPO_DIR/packages/cli/dist/index.js" "$@"
