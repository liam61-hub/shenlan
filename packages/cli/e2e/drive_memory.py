#!/usr/bin/env python3
"""Auto Memory E2E 回归：memory_save 工具 + /memory 命令（端口 9916）。

场景（对齐计划 Test Plan）：
  1. 启动 CLI，提交「记住：以后都用 pnpm」→ mock 返回 memory_save 工具调用
     → 断言主题文件 + MEMORY.md 索引生成
  2. /memory → 列表显示新条目（含 project 来源标记）+ Auto memory: ON
  3. /memory off → 下一个请求的工具列表不含 memory_save
  4. 重启会话 → system prompt 含索引行；autoSave 仍为 off
  5. 全程无整屏清空序列、两次退出码均 0

输出：
  memory-requests.log   每个请求的 model / tools / system prompt（JSON lines）
  typescript-memory     原始 PTY 字节
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

PORT = 9916
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work-memory"
HOME = SCRATCH + "/home-memory"
LOG = SCRATCH + "/memory-requests.log"
CAPTURE = SCRATCH + "/typescript-memory"
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

for d in (WORK, HOME):
    shutil.rmtree(d, ignore_errors=True)
os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)
try:
    os.remove(LOG)
except FileNotFoundError:
    pass

count = 0
lock = threading.Lock()


def memory_save_delta():
    args = json.dumps({
        "name": "use-pnpm",
        "description": "Use pnpm for installs",
        "content": "安装依赖一律使用 pnpm，不要用 npm。",
        "scope": "project",
    })
    return {
        "choices": [{
            "delta": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "index": 0,
                    "id": "mem_1",
                    "type": "function",
                    "function": {"name": "memory_save", "arguments": args},
                }],
            }
        }]
    }


def text_delta(content="任务完成，这是最终答案。"):
    return {"choices": [{"delta": {"content": content}}]}


# 请求脚本：1=memory_save 工具调用，2=保存结果确认，3=普通回答，4=重启后普通回答
script = [
    memory_save_delta,
    lambda: text_delta("已记住。"),
    lambda: text_delta("好的。"),
    lambda: text_delta("重启后的回答。"),
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

        model = parsed.get("model", "unknown")
        tools = [t.get("function", {}).get("name") for t in (parsed.get("tools") or [])]
        system = ""
        for m in (parsed.get("messages") or []):
            if m.get("role") == "system":
                system = m.get("content") or ""
        with open(LOG, "a") as f:
            f.write(json.dumps({"n": n, "model": model, "tools": tools, "system": system}) + "\n")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        fn = script[n - 1] if n <= len(script) else (lambda: text_delta("（结束）"))
        delta = fn()
        self.wfile.write(("data: " + json.dumps(delta) + "\n\n").encode())
        done = {
            "choices": [{"delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 10},
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


def spawn_cli():
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
    return pid, fd


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


def wait_quiet(timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        before = len(out)
        if not drain(6.0):
            break
        if len(out) == before:
            break


def quit_cli(pid, fd):
    send("/quit")
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
        _, status = os.waitpid(pid, 0)
        return os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
    except ChildProcessError:
        return 0


fails = []


def check(name, cond, detail=""):
    print("%-5s %s %s" % ("PASS" if cond else "FAIL", name, detail), flush=True)
    if not cond:
        fails.append(name)


# ===== 会话 1：memory_save 工具 + /memory 命令 =====
pid, fd = spawn_cli()
drain(5.0)  # 启动 + 渲染

send("记住：以后都用 pnpm 安装依赖")
wait_quiet(60)

project_mem_dir = os.path.join(WORK, ".shenlan", "memory")
topic_file = os.path.join(project_mem_dir, "use-pnpm.md")
index_file = os.path.join(project_mem_dir, "MEMORY.md")

check("主题文件生成", os.path.exists(topic_file), topic_file)
if os.path.exists(topic_file):
    topic = open(topic_file, encoding="utf-8").read()
    check("主题文件 front-matter", "name: use-pnpm" in topic and "description: Use pnpm for installs" in topic)
    check("主题文件正文", "pnpm" in topic)
check("MEMORY.md 索引生成", os.path.exists(index_file), index_file)
if os.path.exists(index_file):
    index = open(index_file, encoding="utf-8").read()
    check("索引行格式", "- [use-pnpm](use-pnpm.md) — Use pnpm for installs" in index)

send("/memory")
check("memory 列表显示开关状态", wait_until("Auto memory: ON（/memory on|off 切换）"))
check("memory 列表显示新条目", wait_until("use-pnpm — Use pnpm for installs (project)"))

send("/memory off")
check("memory off 写回配置", wait_until("Auto memory: OFF（已写入"))

send("再跑一个任务")
wait_quiet(60)

exit1 = quit_cli(pid, fd)
check("会话 1 退出码 0", exit1 == 0, "code=%s" % exit1)

# ===== 会话 2：重启后 system prompt 含索引、autoSave 仍为 off =====
pid, fd = spawn_cli()
drain(5.0)
send("介绍一下")
wait_quiet(60)

# /memory rm：确认弹窗（y 执行删除）→ 主题文件 + 索引删除
send("/memory rm use-pnpm")
check("rm 弹出确认", wait_until("要删除这条记忆吗？"))
os.write(fd, b"y")
drain(3.0)
check("rm 删除反馈", "Memory deleted" in out.decode("utf-8", errors="replace"))
check("主题文件已删除", not os.path.exists(topic_file))
check("MEMORY.md 已删除", not os.path.exists(index_file))
send("/memory")
check("删除后列表为空", wait_until("No memories"))

exit2 = quit_cli(pid, fd)
check("会话 2 退出码 0", exit2 == 0, "code=%s" % exit2)

server.shutdown()
bytes_out = bytes(out)
text = bytes_out.decode("utf-8", errors="replace")
with open(CAPTURE, "wb") as f:
    f.write(bytes_out)
print("captured bytes:", len(out))
print("requests:", count)

# ===== 请求级断言（tools / system prompt） =====
reqs = []
if os.path.exists(LOG):
    with open(LOG, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                reqs.append(json.loads(line))

check("请求数 ≥ 4", len(reqs) >= 4, "actual=%d" % len(reqs))
if len(reqs) >= 1:
    check("请求 1 工具含 memory_save", "memory_save" in reqs[0]["tools"], str(reqs[0]["tools"]))
if len(reqs) >= 3:
    check("请求 3 工具不含 memory_save", "memory_save" not in reqs[2]["tools"], str(reqs[2]["tools"]))
if len(reqs) >= 4:
    check("重启后 system prompt 含索引", "- [use-pnpm](use-pnpm.md) — Use pnpm for installs" in reqs[3]["system"])
    check("重启后工具仍不含 memory_save", "memory_save" not in reqs[3]["tools"], str(reqs[3]["tools"]))

check("无整屏清空序列", "\x1b[2J\x1b[3J\x1b[H" not in text)

print("RESULT:", "PASS" if not fails else "FAIL %s" % fails)
raise SystemExit(0 if not fails else 1)
