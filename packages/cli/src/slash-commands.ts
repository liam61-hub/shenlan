/**
 * 斜杠命令路由 — 只有已注册命令名开头的输入才走命令处理，
 * 其他以 / 开头的输入（如绝对路径 /Users/...）按普通用户消息提交，
 * 避免粘贴路径被误判为未知命令。
 */

/** 已注册斜杠命令（含别名），命令路由与 Tab 补全共用 */
export const SLASH_COMMANDS = [
  '/help', '/h',
  '/model',
  '/keys',
  '/security',
  '/goal',
  '/mcp',
  '/skills',
  '/memory',
  '/config',
  '/permissions',
  '/sessions',
  '/plan',
  '/agents', '/a',
  '/cost',
  '/prices',
  '/update',
  '/context',
  '/compact',
  '/undo',
  '/pitfall',
  '/trash',
  '/temp', '/audit',
  '/cleanup',
  '/clear',
  '/stop',
  '/quit', '/exit', '/q',
] as const;

/** 斜杠命令说明（联想列表展示用，对齐 Claude Code /mcp 的 name + description 行） */
export const SLASH_COMMAND_DESCRIPTIONS: Record<string, string> = {
  '/help': '显示命令帮助',
  '/h': '显示命令帮助',
  '/model': '切换模型',
  '/keys': '管理 API Key（掩码显示，全局/项目级）',
  '/security': '提交时安全检查（pre-commit 钩子）',
  '/goal': '长任务目标模式（/goal <目标>，pause|resume|clear）',
  '/mcp': '管理 MCP servers',
  '/skills': '列出已安装 skills',
  '/memory': '查看本地记忆（edit <name> 编辑 / rm 删除 / open 目录）',
  '/config': '查看/修改配置项（get|set|unset，Tab 补全键路径）',
  '/permissions': '查看权限模式',
  '/sessions': '列出会话',
  '/plan': '计划模式 / 计划落盘',
  '/agents': '子代理分解执行任务',
  '/cost': '查看本会话成本',
  '/prices': '查看价格表（/prices check 手动同步）',
  '/update': '立即检查 shenlan CLI 新版本',
  '/context': '上下文构成与压缩阈值',
  '/compact': '手动压缩上下文',
  '/undo': '撤销快照恢复',
  '/pitfall': '查看坑记录（add 添加 / import 从 CLAUDE.md·AGENTS.md 导入）',
  '/trash': '回收站管理',
  '/temp': '查看快照数量',
  '/audit': '会话与模型审计',
  '/cleanup': '清理快照文件',
  '/clear': '清空会话',
  '/stop': '停止当前任务',
  '/quit': '退出',
  '/exit': '退出',
  '/q': '退出',
};

const SLASH_COMMAND_SET = new Set<string>(SLASH_COMMANDS);

/** 输入是否为已注册斜杠命令（按首词匹配，大小写不敏感） */
export function isSlashCommand(input: string): boolean {
  const first = input.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  // Keep the retired command on the slash-command path so users receive “Unknown” locally.
  return SLASH_COMMAND_SET.has(first) || first === '/budget';
}

/**
 * 解析带引号的命令行参数（用于 /mcp add 等斜杠子命令）。
 * 支持双引号/单引号，双引号内反斜杠可转义 " 与 \，其余字符原样保留。
 */
export function parseShellArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        cur += input[++i];
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}
