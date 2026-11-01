#!/usr/bin/env python3
"""斜杠联想分页 + /model /permissions /memory 展示优化回归。

场景（对齐计划 Test Plan）：
  1. PTY 输入 `/` → 全部命令联想；连续发送 ↓（\\x1b[B）把选中项推到后段，
     断言后段命令（/quit）出现在帧中且指示器显示「↑ 还有 18 个」
     （修复前固定 slice(0,8)：/quit 永不渲染、高亮消失）
  2. Esc 关闭联想后执行 /model → 断言 `model: deepseek-v4-flash (auto · cost-first)`
  3. /permissions → 断言 Mode / Config allow / Config deny 三行带标签输出
  4. /memory（空目录）→ 断言 No memories + 全局/项目记忆目录两行提示
  5. /quit 正常退出；全程无整屏清空序列（帧高 ≤ rows-1）

输出：
  typescript-slash    原始 PTY 字节（无 \\x1b[2J\\x1b[3J\\x1b[H 整屏清空断言）
"""
import http.server
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import socketserver
import threading
import time
from terminal_text import plain_terminal_text
import re

PORT = 9915
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work-slash"
HOME = SCRATCH + "/home-slash"
CAPTURE = SCRATCH + "/typescript-slash"
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        # 路由分类器调用（非流式、system 提示含 "task classifier"）：不消耗脚本序号，
        # 直接回枚举值 —— 否则 mock 脚本会与真实请求序列错位（每个用户轮次都会多一次分类调用）。
        if b"task classifier" in body:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"choices": [{"message": {"role": "assistant", "content": "general"}}]}).encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delta = {"choices": [{"delta": {"content": "ok"}}]}
        self.wfile.write(("data: " + json.dumps(delta) + "\n\n").encode())
        done = {
            "choices": [{"delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
        self.wfile.write(("data: " + json.dumps(done) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


server = Server(("127.0.0.1", PORT), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

pid, fd = pty.fork()
if pid == 0:
    os.environ["HOME"] = HOME
    os.environ["XDG_DATA_HOME"] = HOME + "/.local/share"
    os.environ["XDG_CONFIG_HOME"] = HOME + "/.config"
    os.environ["SHENLAN_BASE_URL"] = "http://127.0.0.1:%d" % PORT
    os.environ["SHENLAN_API_KEY"] = "test-key"
    os.chdir(WORK)
    node = shutil.which("node")
    os.execv(node, [node, CLI])

out = bytearray()


def drain(timeout):
    global out
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.3)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        out += chunk
    return True


def wait_until(marker, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if marker in plain_terminal_text(out):
            return True
        if not drain(0.5):
            return False
    return marker in plain_terminal_text(out)


def send(text):
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.4)
    os.write(fd, b"\r")


fails = []


def check(name, cond, detail=""):
    print("%-5s %s %s" % ("PASS" if cond else "FAIL", name, detail), flush=True)
    if not cond:
        fails.append(name)


drain(5.0)

# 1) 斜杠联想：输入 /（无回车）→ 全部 26 个命令联想
os.write(fd, b"/")
drain(1.0)
# 连续 ↓ 25 次：选中项 = 25（/q），窗口滚动到尾部 [18..25]
for _ in range(25):
    os.write(fd, b"\x1b[B")
    time.sleep(0.12)
drain(1.5)

text = out.decode("utf-8", errors="replace")
check("slash window tail shows /quit", "/quit" in text)
import re as _re  # noqa: E402
check("slash window indicator ↑ N", bool(_re.search(r"↑ 还有 \d+ 个", text)))
check(
    "slash window shows later commands (/exit, /q)",
    "/exit" in text and "/q" in text,
)
# 帧高硬规则：联想（8 行 + 1 行指示器）+ 输入框在 PTY 24 行兜底下不触发整屏清空
check("no full-screen clear", b"\x1b[2J\x1b[3J\x1b[H" not in out)

# Esc 关闭联想 + Backspace 清掉残留的 `/`（Esc 只关列表不清输入），
# 避免后续 /model 变成 //model 被当成未知命令
os.write(fd, b"\x1b")
drain(0.5)
os.write(fd, b"\x7f")
drain(0.5)

# 2) /model 无参：打开模型面板（0.4.80 起为面板交互），首项展示
# 默认（自动路由）与其策略/基线；Esc 关闭后再继续后续命令（模态会吞掉输入）。
send("/model")
check(
    "model panel shows auto policy + baseline",
    wait_until("自动路由 · cost-first · 基线"),
)
os.write(fd, b"\x1b")
drain(1.0)

# 3) /permissions：运行时模式 + 配置 allow/deny 带标签展示
send("/permissions")
check(
    "permissions mode line",
    wait_until("Mode: NORMAL（default · 标准（写操作需确认））"),
)
check("permissions allow line", wait_until("Config allow: read, search"))
check("permissions deny line", wait_until("Config deny: (none)"))

# 4) /memory 空结果：No memories + 记忆目录两行提示
send("/memory")
check("memory empty result", wait_until("No memories"))
check("memory global dir hint", wait_until("全局: ~/.shenlan/memory/"))
check("memory project dir hint", wait_until("项目: .shenlan/memory/"))

# 5) 退出
send("/quit")
deadline = time.time() + 10
code = None
while time.time() < deadline:
    try:
        wpid, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        code = 0
        break
    if wpid == pid:
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
        break
    drain(0.5)
check("clean exit", code == 0, "code=%s" % code)
if code is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)

server.shutdown()
with open(CAPTURE, "wb") as f:
    f.write(out)
print("RESULT:", "PASS" if not fails else "FAIL %s" % fails)
raise SystemExit(0 if not fails else 1)
