#!/usr/bin/env python3
"""确认弹窗交互回归：覆盖 y / Enter / Esc→反馈 / Ctrl+C / shell 弹窗，
每种弹窗关闭后验证界面仍可响应（再发一条消息能收到回复）。

仓库内 E2E 回归脚本（沉淀自 /private/tmp/shenlan-pty-check）。
"""
import http.server
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import socketserver
import threading
import time

PORT = 9901
# scratch 目录可用环境变量覆盖（默认 /private/tmp/shenlan-pty-check）
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work9"
HOME = SCRATCH + "/home9"
CAPTURE = SCRATCH + "/typescript-confirm"
# 从脚本位置推导项目根（packages/cli/e2e → 仓库根）
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)

count = 0
lock = threading.Lock()


def write_delta(name="write", args=None):
    n = count
    return {
        "choices": [{
            "delta": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "index": 0,
                    "id": "c_%d" % n,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args or {})},
                }],
            }
        }]
    }


# 脚本：write 弹窗(按 y) → 文本 → write 弹窗(按 Enter) → 文本 →
# write 弹窗(按 Esc→反馈→Enter) → 文本 → write 弹窗(按 Ctrl+C 终止) →
# shell sleep(按 y) → 文本 → 之后每次请求返回普通文本
script = [
    lambda: write_delta("write", {"file_path": "a.txt", "content": "a"}),
    lambda: {"choices": [{"delta": {"content": "第一步完成。"}}]},
    lambda: write_delta("write", {"file_path": "b.txt", "content": "b"}),
    lambda: {"choices": [{"delta": {"content": "第二步完成。"}}]},
    lambda: write_delta("write", {"file_path": "c.txt", "content": "c"}),
    lambda: {"choices": [{"delta": {"content": "第三步完成。"}}]},
    lambda: write_delta("write", {"file_path": "d.txt", "content": "d"}),
    lambda: write_delta("shell", {"command": "sleep 2", "timeout": 5000}),
    lambda: {"choices": [{"delta": {"content": "shell 完成。"}}]},
]


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
        fn = script[n - 1] if n <= len(script) else (lambda: {"choices": [{"delta": {"content": "（后续回复）"}}]})
        delta = fn()
        self.wfile.write(("data: " + json.dumps(delta) + "\n\n").encode())
        done = {
            "choices": [{"delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 10},
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
        if marker in ansi_re.sub("", out.decode("utf-8", errors="replace")):
            return True
        if not drain(0.5):
            return False
    return marker in ansi_re.sub("", out.decode("utf-8", errors="replace"))


def send(text):
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.4)
    os.write(fd, b"\r")


def wait_still(quiet=3.0, cap=30):
    deadline = time.time() + cap
    while time.time() < deadline:
        before = len(out)
        if not drain(quiet):
            return
        if len(out) == before:
            return


fails = []


def check(name, cond, detail=""):
    print("%-5s %s %s" % ("PASS" if cond else "FAIL", name, detail), flush=True)
    if not cond:
        fails.append(name)


ansi_re = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\[\?[0-9]+[hl]")


def last_nonempty_line(buf):
    lines = [ansi_re.sub("", l).strip() for l in buf.decode("utf-8", errors="replace").split("\n")]
    lines = [l for l in lines if l]
    return lines[-1] if lines else ""


def nonempty_lines(buf):
    return [l for l in (ansi_re.sub("", l).strip() for l in buf.decode("utf-8", errors="replace").split("\n")) if l]


drain(5.0)

# 1) 弹窗 A：按 y
send("写一个文件 a")
check("popup A shown", wait_until("a.txt"))
check("popup A controls shown", wait_until("Esc 说明原因 · Ctrl+C 终止"))
lines = nonempty_lines(out)
esc_idx = max(i for i, l in enumerate(lines) if "Esc 说明原因 · Ctrl+C 终止" in l)
check(
    "popup A in-flow + input hidden",
    esc_idx == len(lines) - 1 and not any("NORMAL" in l for l in lines[esc_idx + 1:]),
    "last=%r esc_tail=%d" % (lines[-1][-30:], len(lines) - 1 - esc_idx),
)
os.write(fd, b"y")
check("popup A resolved", wait_until("第一步完成。"))

# 2) 弹窗 B：按 Enter（默认选中 Yes）
send("写一个文件 b")
check("popup B shown", wait_until("b.txt"))
os.write(fd, b"\r")
check("popup B resolved", wait_until("第二步完成。"))

# 3) 弹窗 C：Esc → 反馈输入 → Enter（deny_feedback）
send("写一个文件 c")
check("popup C shown", wait_until("c.txt"))
os.write(fd, b"\x1b")
check("feedback mode", wait_until("请说明应如何调整："))
os.write(fd, "换个方式".encode("utf-8"))
time.sleep(0.3)
os.write(fd, b"\r")
check("popup C resolved", wait_until("第三步完成。"))

# 4) 弹窗 D：Ctrl+C 终止任务
send("写一个文件 d")
check("popup D shown", wait_until("d.txt"))
os.write(fd, b"\x03")
check("abort error shown", wait_until("已终止"))

# 5) shell 弹窗：按 y（sleep 2）
send("跑个命令")
check("popup E shown", wait_until("sleep 2"))
os.write(fd, b"y")
check("popup E resolved", wait_until("shell 完成。"))

# 6) 最终响应性检查
send("还能用吗")
check("responsive after popups", wait_until("（后续回复）"))

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
