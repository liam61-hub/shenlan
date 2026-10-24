#!/usr/bin/env python3
"""PTY 回归驱动 + 本地 mock LLM（自包含，无需外部网络）。

仓库内 E2E 回归脚本（沉淀自 /private/tmp/shenlan-pty-check）。

场景（对齐计划 Test Plan）：
  1. 启动 CLI（env 指向本地 mock，HOME/工作目录用 scratch，不碰真实配置）
  2. 提交长任务"权益卡逻辑介绍一下" → mock 连续返回 35 轮工具调用（>30 轮不报错）
  3. 再提交追问"你好" → 验证会话级模型粘性（第 37 个请求仍应路由 pro）
  4. /quit 退出

输出：
  mock-requests.log      每个请求的 model（路由/粘性断言）
  typescript-mock        原始 PTY 字节（无 \\x1b[2J\\x1b[3J\\x1b[H 整屏清空断言）
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

PORT = 9888
# scratch 目录可用环境变量覆盖（默认 /private/tmp/shenlan-pty-check）
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work2"
HOME = SCRATCH + "/home2"
LOG = SCRATCH + "/mock-requests.log"
CAPTURE = SCRATCH + "/typescript-mock"
TOOL_ROUNDS = 35
# 从脚本位置推导项目根（packages/cli/e2e → 仓库根）
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)
try:
    os.remove(LOG)
except FileNotFoundError:
    pass

count = 0
lock = threading.Lock()


def noop_tool_delta():
    n = count
    call_id = "call_%d" % n
    args = json.dumps({"file_path": "f%d.txt" % n})
    return {
        "choices": [{
            "delta": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "index": 0,
                    "id": call_id,
                    "type": "function",
                    "function": {"name": "noop_tool", "arguments": args},
                }],
            }
        }]
    }


def write_tool_delta():
    return {
        "choices": [{
            "delta": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "index": 0,
                    "id": "w_%d" % count,
                    "type": "function",
                    "function": {
                        "name": "write",
                        "arguments": json.dumps({"file_path": "perm.txt", "content": "hi"}),
                    },
                }],
            }
        }]
    }


def text_delta(content="任务完成，这是最终答案。"):
    return {"choices": [{"delta": {"content": content}}]}


# 请求脚本：35 轮 noop 工具 → 两条最终答案 → /compact 摘要请求（chat 解析失败降级）→
# 权限阶段 A（write 弹确认）→ 最终答案 → 权限阶段 B（write，bypass 不弹）→ 最终答案
script = (
    [noop_tool_delta] * TOOL_ROUNDS
    + [text_delta, text_delta, text_delta]
    + [write_tool_delta, text_delta, write_tool_delta, text_delta]
)


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
        with open(LOG, "a") as f:
            f.write("%d\t%s\n" % (n, model))

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
send("权益卡逻辑介绍一下")

# 等待第一轮完成：连续 6 秒无新输出视为静止（上限 120s）
deadline = time.time() + 120
while time.time() < deadline:
    before = len(out)
    if not drain(6.0):
        break
    if len(out) == before:
        break

send("你好")
deadline = time.time() + 60
while time.time() < deadline:
    before = len(out)
    if not drain(6.0):
        break
    if len(out) == before:
        break

# 斜杠命令端到端验证：/context 构成 → /compact 压缩（LLM 摘要走 mock 会失败降级规则）→ /model 切换
send("/context")
drain(2.0)
send("/compact")
drain(4.0)
send("/model deepseek-v4-pro")
drain(2.0)
send("/model")
drain(2.0)

# ---- 权限模式端到端验证 ----
# 阶段 A：default 模式 → write 工具应弹出确认
send("写个文件")
drain(3.0)          # 等确认弹窗出现
os.write(fd, b"y")  # Yes, proceed
deadline = time.time() + 60
while time.time() < deadline:
    before = len(out)
    if not drain(6.0):
        break
    if len(out) == before:
        break

# Shift+Tab ×2：default → acceptEdits → bypassPermissions
os.write(fd, b"\x1b[Z")
time.sleep(0.5)
os.write(fd, b"\x1b[Z")
drain(1.5)

# 阶段 B：bypass 模式 → write 工具不再弹确认
send("再写一个文件")
deadline = time.time() + 60
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
    _, status = os.waitpid(pid, 0)
    exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
except ChildProcessError:
    exit_code = 0

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


# 请求数：35 轮 noop + 3 文本 + 2 次 write 权限阶段 + /compact 等，合计应 ≥ 40
expect(count >= 40, "请求数 ≥ 40（实际 %d）" % count)
# 模型粘性：会话内第 1-37 个请求都应路由 pro（/model 切换前）
try:
    with open(LOG) as f:
        models = [line.split("\t")[1].strip() for line in f if "\t" in line]
    expect(len(models) >= 37, "模型日志行数 ≥ 37（实际 %d）" % len(models))
    expect(all(m == "deepseek-v4-pro" for m in models[:37]), "第 1-37 个请求模型粘性保持 pro")
except FileNotFoundError:
    expect(False, "mock-requests.log 存在")

# 无整屏清空序列（Ink 动态帧越界的经典回归）
expect("\x1b[2J\x1b[3J\x1b[H" not in text, "无整屏清空序列")
# 退出码 0（/quit 正常退出）
expect(exit_code == 0, "退出码 0（实际 %d）" % exit_code)

print("failed:", failed)
if failed:
    raise SystemExit(1)
