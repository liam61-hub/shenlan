#!/usr/bin/env node
/**
 * shenlan 轻量 bin 入口（手写 JS，不经 tsc）：
 * --version/--help 只加载 dist/version.js 与 dist/help.js 两个叶子模块，
 * 不触碰主 TUI 栈（React/Ink/@shenlan/core），启动从 ~0.9s 降到 ~0.1s；
 * 其余命令动态 import 主入口 dist/index.js，启动路径与行为不变。
 */
import { VERSION } from '../dist/version.js';
import { printHelp } from '../dist/help.js';

const a = process.argv.slice(2);
if (a.includes('--version') || a.includes('-v')) {
  console.log(`shenlan v${VERSION}`);
  process.exit(0);
}
if (a.includes('--help') || a.includes('-h')) {
  printHelp();
  process.exit(0);
}

// 主入口（TUI / run / mcp / setup 等）
await import('../dist/index.js');
