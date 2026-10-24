/**
 * 挂起透明化 — SIGTSTP / SIGCONT 优雅处理（不屏蔽 Ctrl+Z）
 *
 * raw 模式下 ^Z 仍是普通字节（保持现状，不绑定）；
 * 这里只处理真实停止信号：
 *   - SIGTSTP：恢复终端 → 打印提示 → 移除自身 handler → re-raise SIGTSTP
 *     让进程按系统默认行为真正挂起（50ms 后 SIGSTOP 兜底，防个别环境 TSTP 被忽略）；
 *   - SIGCONT：重新注册 SIGTSTP handler、恢复 raw 模式、emit resize 强制重绘，
 *     并通过 App 暴露的 __shenlanDispatch 追加一条系统消息“已恢复（曾被挂起）”。
 */
let tstpInstalled = false;
let wasSuspended = false;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function onTstp(): void {
  wasSuspended = true;
  // 1) 恢复终端：raw 模式下进程停止后 shell 无法接管终端
  try { process.stdin.setRawMode(false); } catch { /* stdin 非 TTY 时忽略 */ }
  // 2) 打印提示（走 Ink 补丁后的 console，正文留在回滚区）
  try { console.log('⏸ shenlan 已挂起 — 输入 fg 恢复'); } catch { /* SIGHUP 等场景忽略 */ }
  // 3) 移除 handler 后 re-raise，恢复系统默认 stop 语义
  process.removeListener('SIGTSTP', onTstp);
  tstpInstalled = false;
  stopTimer = setTimeout(() => {
    // 兜底：个别环境 TSTP 被忽略时用 SIGSTOP 强制挂起
    try { process.kill(process.pid, 'SIGSTOP'); } catch { /* ignore */ }
  }, 50);
  stopTimer.unref?.();
  try { process.kill(process.pid, 'SIGTSTP'); } catch { /* ignore */ }
}

function onCont(): void {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  // 重新注册 SIGTSTP handler：下次挂起仍走优雅流程
  installTstpHandler();
  // 恢复 raw 模式 + 强制重绘（Ink 与 App 都监听 resize，会重新计算布局）
  try { process.stdin.setRawMode(true); } catch { /* stdin 非 TTY 时忽略 */ }
  try { process.stdout.emit('resize'); } catch { /* ignore */ }
  if (wasSuspended) {
    wasSuspended = false;
    (globalThis as any).__shenlanDispatch?.({
      type: 'ADD_SYSTEM_MSG',
      content: '  已恢复（曾被挂起）',
    });
  }
}

export function installTstpHandler(): void {
  if (tstpInstalled) return;
  tstpInstalled = true;
  process.on('SIGTSTP', onTstp);
}

/** 安装挂起透明化处理（仅交互模式调用） */
export function installSuspendHandlers(): void {
  installTstpHandler();
  process.on('SIGCONT', onCont);
}
