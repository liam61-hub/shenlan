#!/usr/bin/env python3
"""PTY 回归驱动 + 本地 mock LLM — 后台 Explore agent（background_agent）端到端（自包含）。

场景（§26.8 PTY e2e）：
  1. 启动 CLI（env 指向本地 mock，scratch 目录隔离，不碰真实配置）
  2. 提交任务 → mock 第一轮返回 background_agent 工具调用（goal=bg-probe）
  3. 后台子任务独立发起 LLM 请求（mock 按消息内容识别子任务并返回调研结论）
  4. 主循环下一轮 LLM 请求携带注入的调研结论（mock 路由：含 '[background task' → 最终答复）
  5. 断言：调研结论渲染进最终答复、✓ bg 完成瞬态通知、无整屏清空序列、退出码 0

维护约定（README）：macOS / Linux 运行（pty.fork，Windows 不支持），
runner 自动纳入 drive_*.py；单跑：python3 packages/cli/e2e/drive_bg.py
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

PORT = 9902
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work-bg"
HOME = SCRATCH + "/home-bg"
CAPTURE = SCRATCH + "/typescript-bg"
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)

count = 0
lock = threading.Lock()

FINDING = "后台调研结论：Tavily 按月计费，基础版 ¥0 起"
# 注入链路观测：主循环第 2 轮请求里应带上「[background task …]」注入（上下文变更，非终端渲染）
saw_injection = False


def bg_tool_delta():
    return {
        "choices": [{
            "delta": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "index": 0,
                    "id": "bg_call_1",
                    "type": "function",
                    "function": {
                        "name": "background_agent",
                        "arguments": json.dumps(
                            {"goal": "bg-probe", "task": "调研 Tavily 定价并给出结论"}
                        ),
                    },
                }],
            }
        }]
    }


def text_delta(content):
    return {"choices": [{"delta": {"content": content}}]}


class Handler(http.server.BaseHTTPRequestHandler):
    """按请求消息内容路由（主循环与子任务共用端点，非按序脚本，避免竞态）：
      - 含 'Complete this subtask independently' → 子任务请求 → 返回调研结论（子任务完成）
      - 含 '[background task' → 主循环已注入结果 → 最终答复
      - 其他 → 主循环第一轮 → 派发 background_agent 工具调用
    """

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
        joined = json.dumps(parsed.get("messages", []), ensure_ascii=False)

        global saw_injection
        if "Complete this subtask independently" in joined:
            content = FINDING
        elif "[background task" in joined:
            saw_injection = True
            content = "已结合后台调研结论作答。"
        else:
            content = None  # 工具调用轮

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        delta = text_delta(content) if content else bg_tool_delta()
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
send("派一个后台任务调研 Tavily 定价")

# 等待静默（连续 6 秒无新输出；上限 120s）
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


# 至少 3 个请求：主循环派发轮 + 子任务轮 + 注入后的最终答复轮
expect(count >= 3, "请求数 ≥ 3（实际 %d）" % count)
# 注入链路闭环：子任务调研结论注入主循环并被最终答复引用
expect(saw_injection, "后台调研结论已注入主循环（LLM 上下文含 [background task]）")
expect("已结合后台调研结论作答。" in text, "注入后的最终答复已渲染")
# 完成瞬态通知（SET_NOTICE，渲染在输入框上方）
expect("✓ bg: bg-probe done" in text, "后台任务完成瞬态通知")
# 无整屏清空序列（动态区帧高回归的经典断言）
expect("\x1b[2J\x1b[3J\x1b[H" not in text, "无整屏清空序列")
# 退出码 0（/quit 正常退出）
expect(exit_code == 0, "退出码 0（实际 %d）" % exit_code)

if failed:
    print("\n%d assertion(s) failed" % len(failed))
    raise SystemExit(1)
print("\nALL PASS")
