#!/usr/bin/env python3
"""输入行水平开窗回归（Windows 左移修复）：打字全程无整屏清屏序列、
帧内无满宽行、超宽输入时光标窗口化（左指示符 … + 光标块 █ 恒可见）。

背景：Windows/Wave 下每次按键整体左移——帧内全宽行（分隔线恰 w 列）把光标
停在末列，帧间 \\n 列错位时物理折行 → Ink eraseLines 垂直记账错位 → 逐帧漂移；
超宽输入行经 Ink 折行把帧撑满 → Windows 分支每帧发 2J/3J 清屏。
修复：输入行按显示列水平开窗（光标 █ 恒可见）、帧内任何行 ≤ w−1、分隔线 w−1。

断言基线（也是回归语料）：
1. 全程无 \\x1b[2J / \\x1b[3J；
2. 剥离 ANSI 后每一行显示宽 < COLS（无满宽行）；
3. DSR 空闲帧尾光标列 == 0（不支持 DSR 的平台降级为报告不 fail）；
4. 超宽输入时窗口贴右缘：左指示符 … + a*预算 + █ 可见，中文输入完整渲染；
5. /exit 干净退出。
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
import struct
import termios
import fcntl
import unicodedata

PORT = 9921
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

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

fails = []


def check(name, cond, detail=""):
    print("%-5s %s %s" % ("PASS" if cond else "FAIL", name, detail), flush=True)
    if not cond:
        fails.append(name)


def strip_ansi(data):
    return re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", data).decode("utf-8", errors="replace")


def disp_width(s):
    """近似仓库 displayWidth：EAW W/F 计 2 列（Ambiguous 计 1，与 string-width 一致）"""
    w = 0
    for ch in s:
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def run_case(cols, rows, tag):
    global count
    work = SCRATCH + "/work-typewin-" + tag
    home = SCRATCH + "/home-typewin-" + tag
    os.makedirs(work, exist_ok=True)
    os.makedirs(home, exist_ok=True)

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["HOME"] = home
        os.environ["XDG_DATA_HOME"] = home + "/.local/share"
        os.environ["XDG_CONFIG_HOME"] = home + "/.config"
        os.environ["SHENLAN_BASE_URL"] = "http://127.0.0.1:%d" % PORT
        os.environ["SHENLAN_API_KEY"] = "test-key"
        os.chdir(work)
        # 子进程 exec 前设定 PTY 尺寸：Node 启动时 stdout.columns 读到目标宽高
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        node = shutil.which("node")
        os.execv(node, [node, CLI])

    out = bytearray()

    def drain(timeout):
        # out 是 run_case 的局部变量；`out += chunk` 会让它在本函数内被视为局部名，
        # 必须显式 nonlocal，否则首次累加即 UnboundLocalError。
        nonlocal out
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
        """整行提交（文本 + Enter）"""
        os.write(fd, text.encode("utf-8"))
        time.sleep(0.4)
        os.write(fd, b"\r")

    def type_text(text):
        """只打字不提交（模拟按键）"""
        os.write(fd, text.encode("utf-8"))
        time.sleep(0.4)

    # 1) 首轮对话：确保输入框已渲染（可能的首次引导已过），并激活 agent loop
    drain(5.0)
    send("hi")
    ok = wait_until("第%d次回复。" % (count + 1))
    check("[%s] first reply" % tag, ok)

    # 2) DSR：空闲时帧尾光标应在列 0（1-based 报第 1 列）——帧内全宽行修复的验证
    dsr_start = len(out)
    os.write(fd, b"\x1b[6n")
    drain(0.8)
    m = re.search(rb"\x1b\[(\d+);(\d+)R", out[dsr_start:])
    if m:
        check(
            "[%s] idle cursor col == 1" % tag,
            int(m.group(2)) == 1,
            "col=%s" % m.group(2).decode(),
        )
    else:
        print("INFO [%s] DSR unsupported, col check skipped" % tag)

    # 3) 短输入 10 个 a（普通打字）
    type_text("a" * 10)
    drain(0.5)

    # 4) 追加 290 个 a → 超宽：窗口贴右缘，左指示符 … + a*预算 + █
    budget = cols - 1 - 1 - 3 - 2  # w−1 − █1 − 提示符3 − 指示符预留2
    type_text("a" * 290)
    drain(0.5)
    check(
        "[%s] windowed run a*%d+█" % (tag, budget),
        ("a" * budget + "█").encode() in out,
        "cols=%d budget=%d" % (cols, budget),
    )
    check("[%s] left indicator …" % tag, "…".encode() in out)

    # 5) 中文输入：完整渲染（显示宽 20 列 < 预算，不被裁）
    type_text("这是中文输入测试")
    drain(0.5)
    check("[%s] chinese input rendered" % tag, "这是中文输入测试".encode() in out)

    # 6) Backspace ×10：输入编辑不触发清屏
    for _ in range(10):
        os.write(fd, b"\x7f")
    drain(0.5)

    # 7) Enter 提交 → mock 回复，agent loop 存活
    os.write(fd, b"\r")
    check("[%s] reply after submit" % tag, wait_until("第%d次回复。" % (count + 1)))

    # 8) 全流断言：无整屏清屏、无满宽行
    check("[%s] no screen clear (2J)" % tag, b"\x1b[2J" not in out)
    check("[%s] no scrollback clear (3J)" % tag, b"\x1b[3J" not in out)
    text = strip_ansi(out)
    # 只校验 Ink 帧内的行：首帧之前的启动期 console.log（如余额预检告警）不在
    # Ink 行计数内，天然换行，不参与「满宽行」判定。
    _i = text.find("SHENLAN v")
    frame_text = text[_i:] if _i >= 0 else text
    # 行尾 \r（Ink 清行残留）不计入显示宽度，否则 cols-1 宽的分隔线会被误判为满宽
    over = [l for l in frame_text.replace("\r\n", "\n").split("\n")
            if disp_width(l.rstrip("\r")) >= cols]
    check(
        "[%s] no full-width line (>=%d cols)" % (tag, cols),
        not over,
        "over=%r" % over[:3],
    )

    # 9) 干净退出
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
    check("[%s] clean exit" % tag, code == 0, "code=%s" % code)
    if code is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)

    with open(SCRATCH + "/typescript-typewin-" + tag, "wb") as f:
        f.write(out)


run_case(193, 50, "193x50")  # 复刻 win1 实测 .shenlan/.term-width=193
run_case(60, 20, "60x20")   # 窄终端：输入折行/满屏分支

server.shutdown()
print("requests:", count)
print("RESULT:", "PASS" if not fails else "FAIL %s" % fails)
raise SystemExit(0 if not fails else 1)
