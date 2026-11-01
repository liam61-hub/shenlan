import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink';
import { renderMarkdown } from '../components/MessageItem.js';
import { StreamingLine } from '../components/StreamingLine.js';
import { TableBlock } from '../components/Blocks.js';
import { ingestStreamLine, flushPendingBlock } from '../stream-blocks.js';
import { splitStreaming } from '../streaming.js';
import { reducer } from '../app.js';
import { TuiHarness, baseState } from './scrollback-harness.js';
import { makeTtyStream } from './scrollback-harness.js';

const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';

/** 渲染 React 节点到纯文本（剥掉 ANSI 颜色码） */
function renderToText(node: React.ReactElement): string {
  const stdout = makeTtyStream('stdout');
  const stdin = makeTtyStream('stdin');
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const { unmount } = render(node, {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  unmount();
  return Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
}

// 2026-08-22 运行日志（debug-2026-08-22.log 13:28:09 条目）里真实回复的完整正文
// （nginx-rs 项目分析，含行内代码 + 表格），原样固定为回归数据。
const LOG_CONTENT = [
  "我已经把项目状态摸清了。结论很明确：**下一步就是接着把 HTTP/2 收尾**——因为工作区里已经有人开了个头（未提交），而且它是 P1 仅剩的一项。",
  "",
  "## 现状速览",
  "",
  "- 项目是 Rust 版 nginx，里程碑 M0→M4 已完成，`cargo build` 零告警、`cargo test` 109 全绿（刚验证构建通过）。",
  "- `docs/NEXT.md` 明确写着：M4（P1）仅剩 **HTTP/2**；建议下一步「HTTP/2 或压测门禁」。",
  "- **关键发现**：当前工作区（branch `test`）有 6 个文件未提交，正是 HTTP/2 的**前期脚手架**：",
  "",
  "| 文件 | 已完成的改动 |",
  "|---|---|",
  "| `Cargo.toml` | 新增 `h2 = \"0.4\"`、`http = \"1\"`、`bytes = \"1\"` 依赖 |",
  "| `src/core/config/mod.rs` | 新增 `http2: bool` 配置项 + 校验（开启须配 `tls`） |",
  "| `src/core/http/mod.rs` | `Method::parse` 改为 `pub(crate)`（供 h2 请求转换复用） |",
  "| `src/modules/tls/mod.rs` | `build_acceptor`/`build_sni_acceptor` 支持 ALPN 协商（`h2` 优先、`http/1.1` 回退） |",
  "| `src/core/event/mod.rs` | ① 把请求管线抽成可复用 `process_request()` 返回 `RequestOutcome`；② 监听级 ALPN 一致性校验 |",
  "",
  "## 还差什么才能跑通 h2",
  "",
  "脚手架搭了 80%，但**核心的 h2 连接处理还没写**。具体缺口：",
  "",
  "1. **ALPN 分流点**：`accept_loop`（`src/core/event/mod.rs:832`）里 TLS 握手成功后，现在无条件走 `handle_connection` 的 HTTP/1.1 keep-alive 循环。需要在 `pick_server` 之后判断 `tls_stream.get_ref().1.alpn_protocol()`，若为 `b\"h2\"` 则分发到新的 h2 连接处理器。",
  "2. **h2 连接处理器**：用 `h2::server::handshake()` + connection 循环，把 h2 请求转成内部 `Request` → 调 `process_request()`（已抽好）→ 写回 h2 响应。",
  "3. **头/请求体转换**：内部 `Request`/`Response` 与 `http::Request<RecvStream>`/`http::Response<SendStream>` 的互转、流控、data frame。",
  "4. **集成测试**：h2 客户端用例（可用 `h2` crate 当客户端，或 curl `--http2`）。",
  "",
  "## 建议的具体顺序",
  "",
  "1. 先把现有未提交改动 **提交**（这是完整的可编译重构 + ALPN + 配置，独立成 commit 更清晰）。",
  "2. 实现 ALPN 分流 + `handle_h2_connection`（复用 `process_request`）。",
  "3. 头/body 转换 + 流控。",
  "4. 补 h2 集成测试 + 更新 `README`/`NEXT.md`。",
  "5. `cargo build`（零告警）+ `cargo test` 全绿，收尾 M4。",
  "",
  "## 备选方向（如果暂时不想啃 h2）",
  "",
  "- **压测门禁**（`NEXT.md` 里的另一建议）：50k 静态 / 10k 反代 QPS，需 Linux + wrk——但它偏「验证」，不增加能力，适合放在 h2 之后当 P1 收官验收。",
  "",
  "要我直接动手做哪一步？我建议从「提交现有改动」开始，然后写 h2 连接处理器——需要的话我现在就开工。",
].join('\n');

describe('表格行内代码反引号（日志复现回归）', () => {
  it('完成态 renderMarkdown 不残留反引号', () => {
    const text = renderToText(
      <Box flexDirection="column">{renderMarkdown(LOG_CONTENT)}</Box>,
    );
    expect(text).not.toContain('`');
    expect(text.replace(/\n/g, ' ')).toContain('cargo build');
    expect(text).toContain('Cargo.toml');
  });

  it('代码块使用简洁语言标识，不绘制盒状边框', () => {
    const text = renderToText(
      <Box flexDirection="column">{renderMarkdown('```ts\nconst value = 1;\n```')}</Box>,
    );
    expect(text).toContain('ts');
    expect(text).toContain('const value = 1;');
    expect(text).not.toContain('┌');
    expect(text).not.toContain('└');
  });

  it('流式冻结路径（assistant-line + table 块）不残留反引号', () => {
    let pending: ReturnType<typeof ingestStreamLine>['pendingBlock'] = null;
    const lines: Array<{ text: string; kind?: string }> = [];
    for (const raw of splitStreaming(LOG_CONTENT).completed) {
      const res = ingestStreamLine(raw, pending);
      pending = res.pendingBlock;
      for (const item of res.flush) {
        lines.push({
          text: item.content,
          kind: item.role === 'assistant-block' ? item.blockKind : undefined,
        });
      }
    }
    for (const item of flushPendingBlock(pending)) {
      lines.push({
        text: item.content,
        kind: item.role === 'assistant-block' ? item.blockKind : undefined,
      });
    }

    const text = renderToText(
      <Box flexDirection="column">
        {lines.map((l, i) => (
          l.kind === 'table'
            ? <TableBlock key={i} content={l.text} />
            : <StreamingLine key={i} text={l.text} />
        ))}
      </Box>,
    );
    expect(text).not.toContain('`');
    expect(text).toContain('cargo build');
    expect(text).toContain('Cargo.toml');
  });

  it('TUI 全链路：日志正文按 token 流式派发后，回滚区输出无裸反引号', () => {
    // 与真实流式一致：把完整正文切块喂 TOKEN action，走 reducer 的
    // ingestStreamLine 逐行冻结（inline/table 缓冲），再用 TuiHarness 渲染
    let state = baseState({ phase: 'streaming' });
    const tokens = [
      LOG_CONTENT.slice(0, 137),
      LOG_CONTENT.slice(137, 512),
      LOG_CONTENT.slice(512),
    ];
    for (const tok of tokens) {
      state = reducer(state, { type: 'TOKEN', token: tok });
    }

    const stdout = makeTtyStream('stdout');
    const stdin = makeTtyStream('stdin');
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const { unmount } = render(
      React.createElement(TuiHarness, { state }),
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    unmount();

    const bytes = Buffer.concat(chunks).toString('utf8');
    expect(bytes).not.toContain('`');
    expect(bytes).toContain('cargo build');
    expect(bytes).toContain('Cargo.toml');
    expect(bytes).not.toContain(CLEAR_TERMINAL);
  });
});
