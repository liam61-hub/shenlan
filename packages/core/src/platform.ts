/**
 * 跨平台路径层 — macOS XDG / Windows APPDATA
 *
 * macOS:   ~/.config/shenlan/  ~/.local/share/shenlan/
 * Windows: %APPDATA%/shenlan/  %LOCALAPPDATA%/shenlan/
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

const isWindows = process.platform === 'win32';

/** 配置目录 */
export function configDir(): string {
  if (isWindows) return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'shenlan');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'shenlan');
}

/** 数据目录（会话、临时文件） */
export function dataDir(): string {
  if (isWindows) return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'shenlan');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'shenlan');
}

/** 平台标识 */
export function platformId(): string {
  return isWindows ? 'win32' : process.platform;
}
