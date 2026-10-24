/**
 * 视图重置 — `/clear` 的「视觉全新 + 保留历史」实现（2026-08-22 定）
 *
 * 不发任何清屏序列（`2J`/`3J`）：xterm.js 系终端对 `2J` 是直接删除缓冲内容而非
 * 滚入滚动区，发清屏必然丢历史。改用跨终端可靠的三步推屏：
 *   1. 光标移到末行（`\x1b[{rows};1H`，超出自动钳制）
 *   2. 写 rows 个换行 → 整屏内容逐行滚入滚动区（旧历史始终可上滑查看）
 *   3. 光标归位（`\x1b[H`）→ 下一次渲染从窗口顶部开始
 *
 * 随后重置 Ink 帧状态（镜像 Ink 自身 `endSuspend` 的恢复路径：`lastOutput` /
 * `lastOutputHeight` 归零 + `log.reset()`），让下一次 onRender 把动态帧画在新
 * 静态内容（logo）之后，而不是按旧帧坐标去擦除错位。
 */
export function resetViewportToTop(termHeight: number): void {
  const rows = Math.max(1, termHeight || process.stdout.rows || 24);

  process.stdout.write(`\x1b[${rows};1H`);
  process.stdout.write('\n'.repeat(rows));
  process.stdout.write('\x1b[H');

  const ink = (globalThis as any).__shenlanInk as
    | {
        lastOutput?: string;
        lastOutputToRender?: string;
        lastOutputHeight?: number;
        log?: { reset?: () => void };
      }
    | undefined;
  if (ink) {
    ink.lastOutput = '';
    ink.lastOutputToRender = '';
    ink.lastOutputHeight = 0;
    ink.log?.reset?.();
  }
}
