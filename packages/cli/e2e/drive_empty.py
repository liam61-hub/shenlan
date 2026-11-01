#!/usr/bin/env python3
"""空回复兜底回归：

仓库内 E2E 回归脚本（沉淀自 /private/tmp/shenlan-pty-check）。
1) 工具轮后模型返回空 assistant 消息 → CLI 不应推入会话，应自动重试一次
2) 连续两次空回复 → 提示「模型返回了空回复」并优雅收尾
3) 全程 mock 校验：任何请求都不含「无 content 且无 tool_calls 的 assistant 消息」
   （这是 DeepSeek 400 content or tool_calls must be set 的根因）
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

PORT = 9905
# scratch 目录可用环境变量覆盖（默认 /private/tmp/shenlan-pty-check）
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work12"
HOME = SCRATCH + "/home12"
CAPTURE = SCRATCH + "/typescript-empty"
# 从脚本位置推导项目根（packages/cli/e2e → 仓库根）
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)

count = 0
lock = threading.Lock()
payload_checks = []


def write_delta(path):
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
                    "function": {"name": "write", "arguments": json.dumps({"file_path": path, "content": "x"})},
                }],
            }
        }]
    }


def empty_delta():
    return {"choices": [{"delta": {"content": ""}}]}


def text_delta(content):
    return {"choices": [{"delta": {"content": content}}]}


script = [
    lambda: write_delta("e1.txt"),
    empty_delta,
    lambda: text_delta("第一次空回复已兜底。"),
    lambda: text_delta("一切正常。"),
    empty_delta,
    empty_delta,
    lambda: text_delta("最后正常。"),
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
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {}
        with lock:
            count += 1
            n = count
            msgs = parsed.get("messages", [])
            bad = [m for m in msgs if m.get("role") == "assistant"
                   and not m.get("content") and not m.get("tool_calls")]
            payload_checks.append({"n": n, "bad_count": len(bad), "user_msgs": sum(1 for m in msgs if m.get("role") == "user")})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        fn = script[n - 1] if n <= len(script) else (lambda: text_delta("（结束）"))
        delta = fn()
        self.wfile.write(("data: " + json.dumps(delta) + "\n\n").encode())
        done = {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 10}}
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

# 1) 工具轮 → 弹窗 → y → 模型返回空回复（应自动重试）
send("写个文件")
check("popup shown", wait_until("e1.txt"))
os.write(fd, b"y")
check("empty reply retried", wait_until("第一次空回复已兜底。"))

# 2) 问「好了吗?」→ 请求不应含空 assistant（400 根因回归）
send("好了吗?")
check("follow-up works", wait_until("一切正常。"))

# 3) 再来 → 连续两次空回复 → 提示并收尾，之后仍可用
send("再来")
check("double-empty notice", wait_until("模型返回了空回复，本次运行未产生输出"))
send("还能用吗")
check("usable after empty", wait_until("最后正常。"))

with lock:
    bad_total = sum(c["bad_count"] for c in payload_checks)
    reqs = count
check("no empty assistant in any payload", bad_total == 0, "bad=%s" % bad_total)
check("requests advanced", reqs >= 7, "reqs=%s" % reqs)

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
print("payload checks:", payload_checks, flush=True)
print("RESULT:", "PASS" if not fails else "FAIL %s" % fails)
raise SystemExit(0 if not fails else 1)
