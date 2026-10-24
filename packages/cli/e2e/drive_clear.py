#!/usr/bin/env python3
"""/clear 回归：不发清屏序列（旧内容压入滚动区可上滑）+ 视觉重置到窗口顶部
（logo + 输入框）+ 确认提示紧贴输入框 + 清空后仍可继续对话。

覆盖根因：<Static> 只追加不擦除且 index 只增不减——/clear 必须主动发出
清屏序列会直接删除终端缓冲内容（xterm.js 系终端 2J 不滚入滚动区），旧历史
将无法上滑查看，因此 /clear 不发任何清屏序列（无 2J/3J），旧内容保留在
滚动区（2026-08-22 起改用换行推屏 + 光标归位，见 screen-reset.ts）；
新会话 logo 渲染在窗口顶部、输入框紧随其下。“Context cleared”确认提示走
SET_NOTICE 渲染在输入框上方（紧贴分隔线），不进滚动区、提交后清除。
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
import re

PORT = 9912
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work-clear"
HOME = SCRATCH + "/home-clear"
CAPTURE = SCRATCH + "/typescript-clear"
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)

count = 0
lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global count
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
        with lock:
            count += 1
            n = count
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delta = {"choices": [{"delta": {"content": "第%d次回复。" % n}}]}
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
        if marker in out.decode("utf-8", errors="replace"):
            return True
        if not drain(0.5):
            return False
    return marker in out.decode("utf-8", errors="replace")


def send(text):
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.4)
    os.write(fd, b"\r")


fails = []


def check(name, cond, detail=""):
    print("%-5s %s %s" % ("PASS" if cond else "FAIL", name, detail), flush=True)
    if not cond:
        fails.append(name)


def strip_ansi(data):
    return re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", data).decode("utf-8", errors="replace")


drain(5.0)

# 1) 正常对话一轮
send("你好")
check("first reply", wait_until("第1次回复。"))

# 2) /clear：必须发出清屏序列，且确认消息能被 Static 重绘出来
before = len(out)
send("/clear")
check("clear confirmation shown", wait_until("Context cleared — 新会话，输入继续"))
tail = out[before:]
# 不发任何清屏/清滚动区序列：旧内容压入滚动区，历史可上滑查看
check(
    "no screen clear (2J)",
    b"\x1b[2J" not in tail,
    "has_2J=%s" % (b"\x1b[2J" in tail),
)
check("no scrollback clear (3J)", b"\x1b[3J" not in tail)
# 2026-08-22：视觉重置 = 换行推屏 + 光标归位（\x1b[H），新 logo 画在归位之后
home_idx = tail.find(b"\x1b[H")
check("cursor home emitted", home_idx >= 0, "has_H=%s" % (home_idx >= 0))
logo_idx = tail.find(b"SHENLAN")
check(
    "logo after cursor home",
    home_idx >= 0 and logo_idx > home_idx,
    "logo=%s home=%s" % (logo_idx, home_idx),
)
# 新会话渲染在旧内容之后（追加式，未擦除旧消息）
check(
    "old content precedes new session",
    out.find("第1次回复".encode()) >= 0 and out.find("第1次回复".encode()) < out.find("Context cleared".encode()),
)
# 确认提示必须紧贴输入框分隔线（无大段空白）：提示行的下一行就是分隔线
lines = [strip_ansi(l) for l in tail.split(b"\r\n")]
msg_idx = next((i for i, l in enumerate(lines) if "Context cleared" in l), -1)
next_line = lines[msg_idx + 1] if msg_idx >= 0 else ""
check(
    "confirmation adjacent to input divider",
    msg_idx >= 0 and next_line.lstrip().startswith("─") and len(next_line.strip()) > 10,
    "next=%r" % next_line,
)

# 3) 清空后仍可继续对话（agent loop 未被 /clear 打断）
send("还能用吗")
check("responsive after clear", wait_until("第2次回复。"))
check("requests == 2（/clear 不发起 LLM）", count == 2, "count=%d" % count)

send("/exit")
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
print("requests:", count)
print("RESULT:", "PASS" if not fails else "FAIL %s" % fails)
raise SystemExit(0 if not fails else 1)
