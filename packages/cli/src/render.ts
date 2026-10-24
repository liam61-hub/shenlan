/**
 * 流式渲染 — 流式 Markdown 解析
 */
import chalk from 'chalk';

// ---- 流式 Markdown 渲染器 ----

interface MdState {
  /** 行 buffer */
  buf: string;
  /** 是否在 ```code block``` 内 */
  codeBlock: boolean;
}

const st: MdState = { buf: '', codeBlock: false };

/** 渲染一行中的行内格式 */
function renderInline(text: string): string {
  // NOTE: 顺序不能变——`**` 必须在 `*` 之前处理，` `` ` 优先
  // `code`
  text = text.replace(/`([^`]+)`/g, (_, m) => chalk.cyan(m));
  // **bold**
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, m) => chalk.bold(m));
  // *italic*
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, m) => chalk.italic(m));
  // ~~strikethrough~~
  text = text.replace(/~~([^~]+)~~/g, (_, m) => chalk.strikethrough ? chalk.strikethrough(m) : m);

  return text;
}

/** 渲染一个完整行（非 code block 内） */
function renderLine(line: string): string {
  // 代码块分界
  if (line.startsWith('```')) {
    st.codeBlock = !st.codeBlock;
    return chalk.dim(line);
  }

  if (st.codeBlock) {
    return chalk.dim(line);
  }

  // 标题
  const hMatch = line.match(/^(#{1,6})\s+(.+)/);
  if (hMatch) {
    return chalk.bold(hMatch[2]);
  }

  // 无序列表
  const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
  if (ulMatch) {
    return ulMatch[1] + chalk.dim('• ') + renderInline(ulMatch[2]);
  }

  // 有序列表
  const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
  if (olMatch) {
    return olMatch[1] + renderInline(olMatch[2]);
  }

  // 引用
  const bqMatch = line.match(/^>\s?(.+)/);
  if (bqMatch) {
    return chalk.dim('│ ') + chalk.dim(renderInline(bqMatch[1]));
  }

  // 水平线
  if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
    return chalk.dim('─'.repeat(process.stdout.columns || 40));
  }

  return renderInline(line);
}

/** 推送 token 到行 buffer，有完整行时写出 */
function pushToken(token: string): void {
  // 将 token 中的 \n 拆分为完整行
  // 直接用 \n split 不合适，需要保留换行符语义
  st.buf += token;

  while (true) {
    const nl = st.buf.indexOf('\n');
    if (nl === -1) break;

    const line = st.buf.slice(0, nl + 1);  // 含 \n
    st.buf = st.buf.slice(nl + 1);

    const rendered = renderLine(line.replace(/\n$/, ''));
    process.stdout.write(rendered + '\n');
  }
}

/** 流结束时 flush 剩余 buffer */
function flushBuffer(): void {
  if (st.buf) {
    // 最后残留的文本（没遇到 \n），作为不完整行写出
    process.stdout.write(renderInline(st.buf));
    st.buf = '';
  }
}

/** 重置渲染器状态（新一条消息开始时） */
function resetState(): void {
  st.buf = '';
  st.codeBlock = false;
}

// ---- 公开接口 ----

/** 开始流式输出 */
export function startStream(): void {
  resetState();
}

/** 打印 token（流式 markdown） */
export function printToken(token: string): void {
  pushToken(token);
}

/** 结束流式输出 */
export function endStream(): void {
  flushBuffer();
  process.stdout.write('\n');
}

/** 打印工具调用状态 */
export function printToolStatus(toolName: string, status: 'running' | 'done' | 'error', detail?: string): void {
  const icons: Record<string, string> = {
    running: chalk.yellow('⏳'),    // ⏳
    done: chalk.green('✓'),         // ✓
    error: chalk.red('✗'),          // ✗
  };
  const icon = icons[status] || '';

  // 格式化工具名和详情
  const label = toolName.replace(/_/g, ' ');
  const showDetail = detail || '';
  const display = showDetail
    ? `  ${icon} ${chalk.bold(label)} ${chalk.dim(showDetail)}`
    : `  ${icon} ${chalk.bold(label)}`;

  process.stdout.write(display + '\n');
}

/** 格式化 token 数 */
export function formatTokens(total: number): string {
  if (total >= 1000) {
    return `${(total / 1000).toFixed(1)}k`;
  }
  return String(total);
}

/** 欢迎信息 */
export function printWelcome(version: string, model: string): void {
  console.log(chalk.dim(`⏣ 深蓝 shenlan v${version}`) + chalk.dim(`  ·  ${model}`));
  console.log('');
}
