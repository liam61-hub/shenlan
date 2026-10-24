#!/usr/bin/env python3
"""会话持久化 + 挂起/信号端到端验证（shenlan 防“无声挂起/丢会话”加固）：

仓库内 E2E 回归脚本（沉淀自 /private/tmp/shenlan-pty-check）。
  1. /exit → 输出含 `shenlan --resume <id>`，sessions 目录存在 <id>.jsonl 且含消息
  2. --resume <id> 重启 → mock 收到的首个请求包含恢复的历史消息（user 消息数 ≥ 2）
  3. 运行中 SIGTSTP → ps 状态为 T；SIGCONT → 状态恢复、输出“已恢复”、输入仍可响应
  4. 运行中 SIGTERM → 会话落盘、打印 resume 命令、退出码 0
  5. /clear 不发任何清屏/清滚动区序列（\\x1b[2J、\\x1b[3J 均不出现），
     旧内容保留在屏幕/滚动区可上滑查看
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

PORT = 9895
# scratch 目录可用环境变量覆盖（默认 /private/tmp/shenlan-pty-check）
SCRATCH = os.environ.get("SHENLAN_E2E_SCRATCH", "/private/tmp/shenlan-pty-check")
WORK = SCRATCH + "/work6"
HOME = SCRATCH + "/home6"
SESSIONS = HOME + "/.local/share/shenlan/sessions"
CAPTURE = SCRATCH + "/typescript-resume"
# 从脚本位置推导项目根（packages/cli/e2e → 仓库根）
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CLI = str(PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js")

os.makedirs(WORK, exist_ok=True)
os.makedirs(HOME, exist_ok=True)

requests = []
lock = threading.Lock()


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
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {}
        with lock:
            requests.append(parsed)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delta = {"choices": [{"delta": {"content": "这是 mock 回复。"}}]}
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


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


server = Server(("127.0.0.1", PORT), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()


def spawn(args):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["HOME"] = HOME
        os.environ["XDG_DATA_HOME"] = HOME + "/.local/share"
        os.environ["XDG_CONFIG_HOME"] = HOME + "/.config"
        os.environ["SHENLAN_BASE_URL"] = "http://127.0.0.1:%d" % PORT
        os.environ["SHENLAN_API_KEY"] = "test-key"
        os.chdir(WORK)
        node = shutil.which("node")
        os.execv(node, [node, CLI] + args)
    return pid, fd


def drain(fd, out, timeout):
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


def send(fd, text):
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.4)
    os.write(fd, b"\r")


def wait_still(fd, out, quiet=4.0, cap=60):
    """连续 quiet 秒无新输出视为静止（上限 cap 秒）"""
    deadline = time.time() + cap
    while time.time() < deadline:
        before = len(out)
        if not drain(fd, out, quiet):
            return False
        if len(out) == before:
            return True
    return True


def ps_state(pid):
    return os.popen("ps -o stat= -p %d" % pid).read().strip()


def wait_exit(pid, fd, out, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True, 0
        if wpid == pid:
            drain(fd, out, 1.0)
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
            return True, code
        drain(fd, out, 0.4)
        time.sleep(0.2)
    return False, -1


fails = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print("%-5s %s %s" % (status, name, detail))
    if not cond:
        fails.append(name)


def resume_id_from(out):
    m = re.search(rb"shenlan --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", out)
    return m.group(1).decode() if m else None


def jsonl_messages(sid):
    path = os.path.join(SESSIONS, sid + ".jsonl")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        lines = [l for l in f.read().splitlines() if l.strip()]
    return [json.loads(l) for l in lines]


all_out = bytearray()

# ============ Phase 1: /exit → 落盘 + resume 提示 ============
pid, fd = spawn([])
out = bytearray()
drain(fd, out, 5.0)
send(fd, "第一轮对话")
wait_still(fd, out)
send(fd, "/exit")
exited, code = wait_exit(pid, fd, out)
check("p1 exit code", exited and code == 0, "code=%s" % code)
text = out.decode("utf-8", errors="replace")
sid1 = resume_id_from(out)
check("p1 resume hint printed", sid1 is not None, "sid=%s" % sid1)
msgs1 = jsonl_messages(sid1) if sid1 else None
check(
    "p1 jsonl persisted",
    msgs1 is not None and any("第一轮对话" in str(m.get("content", "")) for m in msgs1),
    "msgs=%s" % (len(msgs1) if msgs1 else 0),
)
all_out += out

# ============ Phase 2: --resume <id> 恢复历史 ============
with lock:
    base_req_count = len(requests)
pid, fd = spawn(["--resume", sid1])
out = bytearray()
drain(fd, out, 5.0)
check("p2 resumed banner", "Resumed session" in out.decode("utf-8", errors="replace"))
send(fd, "第二轮追问")
wait_still(fd, out)
with lock:
    reqs = list(requests)[base_req_count:]
user_count = 0
last_req_msgs = []
for r in reqs:
    msgs = r.get("messages", [])
    last_req_msgs = msgs
    user_count = max(user_count, sum(1 for m in msgs if m.get("role") == "user"))
check(
    "p2 resumed history sent to mock",
    user_count >= 2,
    "user_msgs=%s" % user_count,
)
check(
    "p2 old content in request",
    any("第一轮对话" in str(m.get("content", "")) for m in last_req_msgs),
)
send(fd, "/quit")
exited, code = wait_exit(pid, fd, out)
check("p2 exit code", exited and code == 0, "code=%s" % code)
sid2 = resume_id_from(out)
check("p2 new session id", sid2 is not None and sid2 != sid1, "sid2=%s" % sid2)
all_out += out

# ============ Phase 3: SIGTSTP / SIGCONT / SIGTERM ============
pid, fd = spawn([])
out = bytearray()
drain(fd, out, 5.0)
send(fd, "信号测试")
wait_still(fd, out)
check("p3 running before signals", "T" not in ps_state(pid), "stat=%s" % ps_state(pid))

os.kill(pid, signal.SIGTSTP)
time.sleep(0.8)
drain(fd, out, 0.5)
st = ps_state(pid)
check("p3 stopped by SIGTSTP", "T" in st, "stat=%s" % st)

os.kill(pid, signal.SIGCONT)
time.sleep(1.5)
drain(fd, out, 1.0)
st = ps_state(pid)
check("p3 resumed by SIGCONT", "T" not in st, "stat=%s" % st)
check("p3 resumed notice", "已恢复" in out.decode("utf-8", errors="replace"))

send(fd, "挂起后继续")
wait_still(fd, out)
check(
    "p3 input works after resume",
    "mock 回复" in out.decode("utf-8", errors="replace"),
)

os.kill(pid, signal.SIGTERM)
exited, code = wait_exit(pid, fd, out)
check("p3 SIGTERM exit code", exited and code == 0, "code=%s" % code)
sid3 = resume_id_from(out)
check("p3 SIGTERM resume hint", sid3 is not None, "sid3=%s" % sid3)
msgs3 = jsonl_messages(sid3) if sid3 else None
check(
    "p3 SIGTERM jsonl persisted",
    msgs3 is not None and any("挂起后继续" in str(m.get("content", "")) for m in msgs3),
    "msgs=%s" % (len(msgs3) if msgs3 else 0),
)
all_out += out

# ============ Phase 4: SIGINT 兜底（真实 kill -INT） ============
pid, fd = spawn([])
out = bytearray()
drain(fd, out, 5.0)
send(fd, "中断测试")
wait_still(fd, out)
os.kill(pid, signal.SIGINT)
exited, code = wait_exit(pid, fd, out)
check("p4 SIGINT exit code", exited and code == 0, "code=%s" % code)
sid4 = resume_id_from(out)
check("p4 SIGINT resume hint", sid4 is not None, "sid4=%s" % sid4)
msgs4 = jsonl_messages(sid4) if sid4 else None
check(
    "p4 SIGINT jsonl persisted",
    msgs4 is not None and any("中断测试" in str(m.get("content", "")) for m in msgs4),
    "msgs=%s" % (len(msgs4) if msgs4 else 0),
)
all_out += out

# ============ Phase 5: /clear 后落盘重置，旧消息不残留 ============
pid, fd = spawn([])
out = bytearray()
drain(fd, out, 5.0)
send(fd, "将被清除的消息")
wait_still(fd, out)
send(fd, "/clear")
drain(fd, out, 1.5)
send(fd, "清除后的消息")
wait_still(fd, out)
send(fd, "/exit")
exited, code = wait_exit(pid, fd, out)
check("p5 exit code", exited and code == 0, "code=%s" % code)
sid5 = resume_id_from(out)
check("p5 resume hint printed", sid5 is not None, "sid5=%s" % sid5)
msgs5 = jsonl_messages(sid5) if sid5 else None
contents5 = " ".join(str(m.get("content", "")) for m in (msgs5 or []))
check(
    "p5 cleared msg removed from jsonl",
    msgs5 is not None and "将被清除的消息" not in contents5 and "清除后的消息" in contents5,
    "msgs=%s" % (len(msgs5) if msgs5 else 0),
)
all_out += out

# ============ 回归：无任何清屏/清滚动区序列 ============
# /clear 不发清屏序列（xterm.js 系终端的 2J 会直接删除缓冲内容，丢历史），
# 旧内容保留在屏幕/滚动区；全程 2J（Ink 帧溢出等）与 3J（清滚动区）均不允许。
j2_count = all_out.count(b"\x1b[2J")
j3_count = all_out.count(b"\x1b[3J")
check("no screen-clear sequence (2J)", j2_count == 0, "count=%s" % j2_count)
check("no scrollback-clear sequence (3J)", j3_count == 0, "count=%s" % j3_count)

server.shutdown()
with open(CAPTURE, "wb") as f:
    f.write(all_out)

print("captured bytes:", len(all_out))
print("RESULT:", "PASS" if not fails else "FAIL %s" % fails)
raise SystemExit(1 if fails else 0)
