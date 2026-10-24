/**
 * 工具路径辅助 — 把 `~` / `~/...` 展开为当前用户主目录。
 *
 * shell 工具走 /bin/sh 会自动展开 `~`，但 glob/read/write/edit 是直接
 * 用 Node fs，`~` 会被当成字面目录名。统一在这里展开，避免模型对
 * `~/work/...` 类路径反复试错。
 */
import { homedir } from 'node:os';

export function expandHome(path: string): string {
  if (!path || path === '~') return path === '~' ? homedir() : path;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return homedir() + path.slice(1);
  }
  return path;
}
