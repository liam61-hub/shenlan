import { VERSION } from './version.js';

/** --help/-h 静态帮助文本：index.tsx 与 bin/shenlan.js 共用，输出与历史版本逐字节一致。 */
export function printHelp(): void {
  console.log(`深蓝 shenlan v${VERSION}\n`);
  console.log('  shenlan                          interactive TUI REPL');
  console.log('  shenlan --setup                  first-time setup wizard');
  console.log('  shenlan --continue               resume last session');
  console.log('  shenlan --resume <id>            resume specific session');
  console.log('  shenlan run <prompt>              single task (headless)');
  console.log('  shenlan run --readonly <prompt>   read-only single task');
  console.log('  shenlan mcp list|add|remove|refresh   manage MCP servers');
  console.log('  shenlan skills list               list installed skills');
  console.log('  shenlan security status|install|uninstall|scan   pre-commit secret scan');
  console.log('  shenlan audit                     action audit events (recent 20)');
  console.log('  shenlan config [get|set|unset <key>]   view/change config (same as /config)');
}
