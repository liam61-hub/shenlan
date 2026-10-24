/**
 * 分割线工具函数
 */
import { execSync } from 'node:child_process';

function gitBranch(): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

/**
 * 输入框顶部分隔线：`─── master ───`。
 * 总宽 width−1：帧内任何行都不许恰满终端宽度（满宽行把光标停在末列，
 * Windows/Wave 下帧间 \n 列错位会触发物理折行 → 逐帧漂移）；
 * 不设最小宽度下限（窄终端上 40 列下限恒溢出）。
 */
export function dividerText(width: number): string {
  const branch = gitBranch();
  const info = branch ? ` ${branch} ` : ' shenlan ';
  const w = Math.max(0, width - 1);
  if (info.length >= w) return '─'.repeat(w);
  const mid = Math.floor((w - info.length) / 2);
  const end = w - mid - info.length;
  return '─'.repeat(mid) + info + '─'.repeat(end);
}
