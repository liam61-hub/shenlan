#!/usr/bin/env python3
"""针对性回归：--resume 恢复含工具历史的旧会话。
仓库内 E2E 回归脚本（沉淀自 /private/tmp/shenlan-pty-check）。
  JSONL 手工构造（user + assistant + tool 消息，无 fileChange 字段），
  断言：
    - 不崩溃，正常收到 mock 回复
    - 工具行仍是单行摘要（↳ write ...: done），不出现 ✏️ 卡片
    - 无 \\x1b[2J\\x1b[3J\\x1b[H 整屏清空序列
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

PORT = 9911
# scratch 目录可用环境变量覆盖（默认 /private/tmp/shenlan-pty-check）
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work14"
HOME = SCRATCH + "/home14"
SESSIONS = HOME + "/.local/share/shenlan/sessions"
CAPTURE = SCRATCH + "/typescript-resume-toolcard"
# 从脚本位置推导项目根（packages/cli/e2e → 仓库根）
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")
SID = "toolcard"

os.makedirs(WORK, exist_ok=True)
os.makedirs(SESSIONS, exist_ok=True)
os.makedirs(os.path.join(WORK, ".shenlan"), exist_ok=True)
with open(os.path.join(WORK, ".shenlan", "config.json"), "w") as f:
    json.dump({
        "model": {"baseUrl": "https://api.deepseek.com", "apiKey": "", "model": "deepseek-v4-flash", "maxTokens": 8192},
        "permissions": {"mode": "bypassPermissions", "allow": [], "deny": []},
        "skills": [],
        "mcpServers": [],
    }, f, indent=2)

# 旧会话 JSONL：user + assistant + 工具结果（老格式，无 fileChange）
old_msgs = [
    {"role": "user", "content": "写一个文件并总结"},
    {"role": "assistant", "content": "我先写入文件。"},
    {"role": "tool", "content": "write a.txt: done", "tool_call_id": "old_c1", "name": "write"},
    {"role": "user", "content": "继续"},
    {"role": "assistant", "content": "这是旧会话的最终回答。"},
]
with open(os.path.join(SESSIONS, SID + ".jsonl"), "w") as f:
    for m in old_msgs:
        f.write(json.dumps(m, ensure_ascii=False) + "\n")

try:
    os.remove(CAPTURE)
except FileNotFoundError:
    pass

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
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {}
        with lock:
            count += 1
        user_msgs = [m for m in parsed.get("messages", []) if m.get("role") == "user"]
        tool_msgs = [m for m in parsed.get("messages", []) if m.get("role") == "tool"]
        with open(SCRATCH + "/resume-toolcard-requests.log", "a") as f:
            f.write(json.dumps({"n": count, "user_msgs": len(user_msgs), "tool_msgs": len(tool_msgs)}) + "\n")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        delta = {"choices": [{"delta": {"content": "resume 后 mock 回复。"}}]}
        self.wfile.write(("data: " + json.dumps(delta) + "\n\n").encode())
        done = {
            "choices": [{"delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 5},
        }
        self.wfile.write(("data: " + json.dumps(done) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *args):
        pass


server = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
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
    os.execv(node, [node, CLI, "--resume", SID])

out = bytearray()


def drain(timeout):
    global out
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.5)
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


def send(text):
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.4)
    os.write(fd, b"\r")


drain(5.0)  # 启动 + 渲染旧历史
send("继续")

deadline = time.time() + 60
while time.time() < deadline:
    before = len(out)
    if not drain(6.0):
        break
    if len(out) == before:
        break

send("/exit")
time.sleep(0.5)
send("")
alive = drain(8.0)
if alive:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    drain(1.0)

try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

server.shutdown()

text = bytes(out).decode("utf-8", errors="replace")
with open(CAPTURE, "wb") as f:
    f.write(bytes(out))

print("captured bytes:", len(out))
print("requests:", count)

failed = []


def expect(cond, label):
    if cond:
        print("PASS:", label)
    else:
        print("FAIL:", label)
        failed.append(label)


expect("Resumed session" in text, "resume 横幅显示")
expect("↳ write a.txt: done" in text, "旧工具行保持单行摘要（↳）")
expect("✏️" not in text, "恢复历史不出现文件变更卡片")
expect("resume 后 mock 回复。" in text, "resume 后正常回复（不崩溃）")
expect("\x1b[2J\x1b[3J\x1b[H" not in text, "无整屏清空序列")

print("failed:", failed)
if failed:
    raise SystemExit(1)
