/**
 * 工具执行超时保护 — 超时后真正中止底层执行（而非只丢弃结果）
 *
 * 背景：旧实现用 Promise.race 对工具做 60s 硬超时，但超时后工具仍在后台
 * 继续跑（例如 sub-agent 继续消耗 LLM token、shell 子进程继续执行），
 * 既浪费资源又让调用方拿不到部分结果。本模块在超时时 abort 传入工具的
 * AbortSignal，让支持信号的工具（shell 杀进程、agent 停止下一轮）真正停下来。
 */
import type { Tool } from './index.js';

/** 默认单工具超时（60s，与旧行为一致） */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** 各工具推荐超时（主循环 / sub-agent / headless 共用） */
export const TOOL_TIMEOUTS: Record<string, number> = {
  /**
   * shell 超时语义由工具自身管理（对齐 Claude Code：超时后不杀进程，转后台继续运行，
   * 见 tools/shell.ts）。外层不再设硬超时，避免转后台 10s 后又被外层杀死；
   * 用户中止仍通过 abort 信号传递。
   */
  shell: Number.POSITIVE_INFINITY,
  /** 子 Agent 做项目级分析可能持续数分钟（实测单子任务 60s+） */
  agent: 300_000,
  /**
   * web_search：原生搜索单次 60s 超时 + 超时重试 1 次（deepseek 实测约 20s，
   * 历史偶发超时；重试后最长 ~120s）。外层必须宽于内部超时，否则重试永远来不及。
   */
  web_search: 150_000,
};

/** 超时后等待工具返回部分结果的宽限期 */
export const ABORT_GRACE_MS = 2_000;

export interface TimeoutToolResult {
  content: string;
  isError?: boolean;
  timedOut: boolean;
  /** 图片 data URL 数组（透传 ToolResult.images，消息组装时展开为 image_url 内容块） */
  images?: string[];
}

/**
 * 执行工具并附带超时保护。
 *
 * 超时发生时：abort 合并信号 → 底层执行被终止（shell 杀进程、
 * sub-agent 在下一轮检查点返回部分结果）→ 返回超时错误消息。
 */
export async function executeToolWithTimeout(
  tool: Tool,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TimeoutToolResult> {
  const timeoutMs = options.timeoutMs ?? TOOL_TIMEOUTS[tool.name] ?? DEFAULT_TOOL_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const finish = (content: string, isError?: boolean, images?: string[]) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ content, isError: !!isError, timedOut, images });
    };

    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        // 给工具一点时间在被 abort 后返回（如 sub-agent 的部分结论），
        // 但仍以超时消息为准，避免底层错误输出覆盖清晰提示。
        setTimeout(() => {
          const label = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`;
          finish(`command timed out after ${label} — execution aborted`, true);
        }, ABORT_GRACE_MS);
      }, timeoutMs);
    }
    // 非有限超时（如 shell=Infinity）：不设外层定时器，由工具自身管理超时语义；
    // abort 信号照常合并传递，用户中止仍然生效。

    tool.execute(args, signal).then(
      (result) => {
        // 已超时：底层工作已被 abort，统一以超时消息为准
        if (timedOut) return;
        finish(result.content, result.isError, result.images);
      },
      (err) => {
        if (timedOut) return;
        finish(String(err instanceof Error ? err.message : err), true);
      },
    );
  });
}
