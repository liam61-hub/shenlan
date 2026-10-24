/**
 * 工具循环检测共享模块 — repl.ts 与 run.ts 共用
 *
 * 语义键签名：工具名 + 按工具类型提取的语义键，整体 md5。
 * 连续出现判定：同一签名「连续」出现计数（轮次粒度），跨轮中断即重置，
 * 不再用会话累计计数（累计计数会把「分块读取 / 边改边读」误判为循环）。
 */
import { createHash } from 'node:crypto';

/** 同签名连续出现达到该次数触发纠正（repl）或判失败（run） */
export const LOOP_REPEAT_THRESHOLD = 5;

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/** 规范化 shell 命令：trim + 折叠连续空白（忽略 timeout 等非语义字段） */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** 按键排序的稳定 JSON 序列化（未知工具 / MCP 工具） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * 构造工具调用的语义签名。
 *
 * 参数为原始 arguments JSON 字符串，内部解析后按工具类型提取语义键：
 *   - read：路径 + offset + limit（offset 缺省按工具默认 1 处理）
 *   - edit：路径 + old_string + new_string
 *   - write：路径 + 内容 md5
 *   - search：路径 + pattern（忽略 output_mode）
 *   - glob：pattern + path
 *   - shell：规范化命令（忽略 timeout）
 *   - ref_retrieve：ref_id
 *   - 其他（含 mcp__*、web_search、pitfall_search、agent 等）：完整参数按键排序的稳定 JSON
 * 参数非法 JSON 时回退为原始字符串 trim 后 md5。
 */
export function computeToolSig(toolName: string, argsStr: string): string {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsStr || '{}');
    args = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // 非法 JSON 回退：原始字符串 trim 后参与签名
    return md5(`${toolName}:${argsStr.trim()}`);
  }

  let key: string;
  switch (toolName) {
    case 'read': {
      const offset = Number(args.offset) || 1;
      const limit = args.limit == null ? '' : String(args.limit);
      key = `${String(args.file_path ?? '')}|${offset}|${limit}`;
      break;
    }
    case 'edit': {
      key = [
        String(args.file_path ?? ''),
        String(args.old_string ?? ''),
        String(args.new_string ?? ''),
      ].join('|');
      break;
    }
    case 'write': {
      key = `${String(args.file_path ?? '')}|${md5(String(args.content ?? ''))}`;
      break;
    }
    case 'search': {
      // 忽略 output_mode：同 pattern + path 视为同一调用语义
      key = `${String(args.pattern ?? '')}|${String(args.path ?? '')}`;
      break;
    }
    case 'glob': {
      key = `${String(args.pattern ?? '')}|${String(args.path ?? '')}`;
      break;
    }
    case 'shell': {
      // 忽略 timeout / cwd 差异：命令语义相同即视为重复
      key = normalizeCommand(String(args.command ?? ''));
      break;
    }
    case 'ref_retrieve': {
      key = String(args.ref_id ?? '');
      break;
    }
    default: {
      // 未知工具（含 mcp__*、web_search、pitfall_search、agent 等）：按键排序的稳定 JSON
      key = stableStringify(args);
      break;
    }
  }
  return md5(`${toolName}:${key}`);
}

/**
 * 连续出现计数。
 *
 * track(sig, round) 返回该签名当前的连续出现长度：
 *   - 同一轮内多次出现 → 递增
 *   - 上一轮（轮次相邻）出现过同一签名 → 续接递增
 *   - 否则 → 重置为 1
 */
export class RepeatTracker {
  private counts = new Map<string, number>();
  private lastRoundBySig = new Map<string, number>();

  track(sig: string, round: number): number {
    const lastRound = this.lastRoundBySig.get(sig);
    let count = this.counts.get(sig) ?? 0;
    if (lastRound === undefined) {
      count = 1;
    } else if (round === lastRound || round === lastRound + 1) {
      count += 1;
    } else {
      count = 1;
    }
    this.counts.set(sig, count);
    this.lastRoundBySig.set(sig, round);
    return count;
  }
}

/**
 * 结果变化跟踪：记录每个签名上次的成败 + 内容哈希。
 *
 * changed(sig, ok, content) 返回该签名相对上一次调用是否发生变化：
 *   - 内容变化或成功态翻转 → true
 *   - 内容与成败均未变 → false
 *   - 首次出现 → false（新签名本身不算进展）
 */
export class OutcomeTracker {
  private lastBySig = new Map<string, { ok: boolean; hash: string }>();

  changed(sig: string, ok: boolean, content: string): boolean {
    const hash = md5(content);
    const prev = this.lastBySig.get(sig);
    if (!prev) {
      this.lastBySig.set(sig, { ok, hash });
      return false;
    }
    const changed = prev.ok !== ok || prev.hash !== hash;
    this.lastBySig.set(sig, { ok, hash });
    return changed;
  }
}
