#!/usr/bin/env python3
"""E2E PTY 回归 runner。

依次运行 packages/cli/e2e/drive_*.py（每个脚本自带本地 mock LLM 与断言，
失败时退出码非 0），随后运行真机脚本（LIVE_SCRIPTS，默认 SKIP），最后打印汇总。

退出码三态：0=PASS，77=SKIP（不翻转总体 exit code），其他=FAIL。

前提：
  - 已执行 npm run build（dist/index.js 存在）
  - drive_*.py 需要 macOS / Linux（使用 pty.fork，Windows 不支持）；
    LIVE_SCRIPTS 是普通 node 脚本，Windows 也能跑
  - 本地端口 9888/9895/9901/9905/9910/9911/9912/9915/9916 空闲
  - 运行环境允许绑定 localhost 端口（沙箱/审批场景需要授权）
  - 真机脚本需 SHENLAN_E2E_LIVE=1 且有对应 provider key，否则 SKIP
"""
import pathlib
import subprocess
import sys

E2E_DIR = pathlib.Path(__file__).resolve().parent
PROJECT_ROOT = E2E_DIR.parent.parent.parent
CLI = PROJECT_ROOT / "packages" / "cli" / "dist" / "index.js"
PER_SCRIPT_TIMEOUT = 420
SKIP_CODE = 77

# 真机脚本（打真端点、消耗真实 token）：默认 SKIP，需 SHENLAN_E2E_LIVE=1 才实跑
LIVE_SCRIPTS: list[tuple[str, str]] = [("vision_e2e.mjs", "node")]


def main() -> int:
    if not CLI.exists():
        print("未找到 CLI 构建产物：%s" % CLI)
        print("请先运行：npm run build")
        return 1

    drivers = sorted(E2E_DIR.glob("drive_*.py"))
    if not drivers:
        print("e2e 目录下没有 drive_*.py 脚本")
        return 1

    results: list[tuple[str, int, str]] = []
    for d in drivers:
        print("\n===== %s =====" % d.name, flush=True)
        try:
            r = subprocess.run([sys.executable, str(d)], timeout=PER_SCRIPT_TIMEOUT)
            results.append((d.name, r.returncode, ""))
        except subprocess.TimeoutExpired:
            print("TIMEOUT after %ds" % PER_SCRIPT_TIMEOUT, flush=True)
            results.append((d.name, -1, ""))

    # 真机脚本：捕获输出以便把 SKIP 原因带进汇总（"为什么没跑"必须可见）
    for name, runner in LIVE_SCRIPTS:
        script = E2E_DIR / name
        if not script.exists():
            results.append((name, 1, "script missing"))
            continue
        print("\n===== %s =====" % name, flush=True)
        try:
            r = subprocess.run(
                [runner, str(script)],
                timeout=PER_SCRIPT_TIMEOUT,
                capture_output=True,
                # 显式 utf-8：脚本输出含中文，Windows 默认 locale 是 GBK，
                # 用 text=True 走默认编码会在 reader 线程里 UnicodeDecodeError
                encoding="utf-8",
                errors="replace",
            )
            sys.stdout.write(r.stdout)
            sys.stderr.write(r.stderr)
            reason = ""
            if r.returncode == SKIP_CODE:
                for line in r.stdout.splitlines():
                    if line.startswith("SKIP:"):
                        reason = line[len("SKIP:"):].strip()
                        break
                # 汇总行要一眼看完，长原因截断（完整说明已在上面原样输出过）
                if len(reason) > 48:
                    reason = reason[:47] + "…"
                reason = reason or "skipped"
            results.append((name, r.returncode, reason))
        except subprocess.TimeoutExpired:
            print("TIMEOUT after %ds" % PER_SCRIPT_TIMEOUT, flush=True)
            results.append((name, -1, ""))
        except FileNotFoundError:
            print("未找到运行器：%s" % runner, flush=True)
            results.append((name, 1, "runner %s not found" % runner))

    print("\n===== E2E 汇总 =====")
    ok = True
    for name, code, reason in results:
        if code == 0:
            status = "PASS"
        elif code == SKIP_CODE:
            # SKIP 不翻转总体 exit code，但必须单独成行显式可见
            status = "SKIP(%s)" % (reason or "skipped")
        else:
            status = "FAIL(%d)" % code
            ok = False
        print("  %-28s %s" % (name, status))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
