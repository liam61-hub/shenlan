#!/usr/bin/env python3
"""文件变更卡片端到端回归（本地 mock LLM，真实工具执行）：
仓库内 E2E 回归脚本（沉淀自 /private/tmp/shenlan-pty-check）。
  mock 依次返回 write 新文件 → write 已有文件 → edit → 最终文本。
  断言：
    - 滚动区出现 ✏️ Added <路径> / ✏️ Updated <路径> 及内容预览行（各恰好一次）
    - 完成后（phase idle）卡片仍在（<Static> 持久，不重绘）
    - 全程无 \\x1b[2J\\x1b[3J\\x1b[H 整屏清空序列
    - 真实工具确实执行：磁盘上 newfile.txt 创建、existing.txt 被覆盖、editme.txt 被替换
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

PORT = 9910
# scratch 目录可用环境变量覆盖（默认 /private/tmp/shenlan-pty-check）
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work13"
HOME = SCRATCH + "/home13"
CAPTURE = SCRATCH + "/typescript-filecard"
# 从脚本位置推导项目根（packages/cli/e2e → 仓库根）
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)

# 重置工作区：newfile.txt 删除（保证 add 判定），existing/editme 重建（保证 update 判定）
for f in ("newfile.txt", "existing.txt", "editme.txt"):
    try:
        os.remove(os.path.join(WORK, f))
    except FileNotFoundError:
        pass
with open(os.path.join(WORK, "existing.txt"), "w") as f:
    f.write("old content\n")
with open(os.path.join(WORK, "editme.txt"), "w") as f:
    f.write("old line\n")

# 项目配置：bypassPermissions 避免写工具弹确认，聚焦卡片本身
os.makedirs(os.path.join(WORK, ".shenlan"), exist_ok=True)
with open(os.path.join(WORK, ".shenlan", "config.json"), "w") as f:
    json.dump({
        "model": {"baseUrl": "https://api.deepseek.com", "apiKey": "", "model": "deepseek-v4-flash", "maxTokens": 8192},
        "permissions": {"mode": "bypassPermissions", "allow": [], "deny": []},
        "skills": [],
        "mcpServers": [],
    }, f, indent=2)

try:
    os.remove(CAPTURE)
except FileNotFoundError:
    pass

count = 0
lock = threading.Lock()


def tool_call_delta(name, args):
    n = count
    return {
        "choices": [{
            "delta": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "index": 0,
                    "id": "fc_%d" % n,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                }],
            }
        }]
    }


def text_delta(content="全部完成，这是最终答案。"):
    return {"choices": [{"delta": {"content": content}}]}


script = [
    lambda: tool_call_delta("write", {"file_path": "newfile.txt", "content": "hello\nworld"}),
    lambda: tool_call_delta("write", {"file_path": "existing.txt", "content": "replacement\nline2"}),
    lambda: tool_call_delta("edit", {"file_path": "editme.txt", "old_string": "old line", "new_string": "new line"}),
    lambda: text_delta(),
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
            json.loads(body)
        except Exception:
            pass
        with lock:
            count += 1
            n = count

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        fn = script[n - 1] if n <= len(script) else (lambda: text_delta("（结束）"))
        delta = fn()
        self.wfile.write(("data: " + json.dumps(delta) + "\n\n").encode())
        done = {
            "choices": [{"delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10},
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
    os.execv(node, [node, CLI])

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


drain(5.0)  # 启动 + 渲染
send("依次写入新文件、覆盖已有文件、再编辑一个文件")

# 等待完成：连续 6 秒无新输出视为静止（上限 120s）
deadline = time.time() + 120
while time.time() < deadline:
    before = len(out)
    if not drain(6.0):
        break
    if len(out) == before:
        break

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
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

server.shutdown()

bytes_out = bytes(out)
text = bytes_out.decode("utf-8", errors="replace")
with open(CAPTURE, "wb") as f:
    f.write(bytes_out)

print("captured bytes:", len(out))
print("requests:", count)

failed = []

def expect(cond, label):
    if cond:
        print("PASS:", label)
    else:
        print("FAIL:", label)
        failed.append(label)


# 卡片首行与预览行各恰好一次（<Static> 增量写入，不重绘）
expect(text.count("✏️ Added newfile.txt") == 1, "✏️ Added newfile.txt 恰好一次")
expect(text.count("✏️ Updated existing.txt") == 1, "✏️ Updated existing.txt 恰好一次")
expect(text.count("✏️ Updated editme.txt") == 1, "✏️ Updated editme.txt 恰好一次")
expect("hello" in text and "world" in text, "write 新文件内容预览行")
expect("replacement" in text and "line2" in text, "write 已有文件内容预览行")
expect("- old line" in text and "+ new line" in text, "edit -/+ 预览块")
# 完成后（phase idle）卡片仍在：文本回复出现在卡片之后
expect(text.index("全部完成") > text.index("✏️ Added newfile.txt"), "完成后卡片仍在滚动区")
# 无整屏清空序列
expect("\x1b[2J\x1b[3J\x1b[H" not in text, "无整屏清空序列")
# 无错误行
expect("✖" not in text, "无错误行")
# 真实工具执行（磁盘验证）
with open(os.path.join(WORK, "newfile.txt")) as f:
    new_content = f.read()
expect(new_content == "hello\nworld", "newfile.txt 已创建且内容正确")
with open(os.path.join(WORK, "existing.txt")) as f:
    existing_content = f.read()
expect(existing_content == "replacement\nline2", "existing.txt 已被覆盖")
with open(os.path.join(WORK, "editme.txt")) as f:
    edit_content = f.read()
expect(edit_content == "new line\n", "editme.txt 已被替换")

print("failed:", failed)
if failed:
    raise SystemExit(1)
