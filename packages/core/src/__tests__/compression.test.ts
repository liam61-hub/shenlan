import { describe, it, expect, vi } from 'vitest';
import {
  estimateTotalTokens,
  compressMessages,
  compressMessagesV2,
  sanitizeMessagePairing,
  buildRuleSummary,
  isSummaryMessage,
  SUMMARY_MARKER,
} from '../compression.js';
import type { Message } from '../provider.js';

const tc = (id: string) => ({
  id,
  type: 'function' as const,
  function: { name: 'read', arguments: '{}' },
});
const calls = (ids: string[]): Message => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map(tc),
});
const toolReply = (id: string): Message => ({
  role: 'tool',
  content: `result ${id}`,
  tool_call_id: id,
  name: 'read',
});

/** 校验序列不破坏 tool_calls ↔ tool 响应配对（API 400 的充分条件） */
function expectPairingValid(msgs: Message[]): void {
  let expected = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      expect(expected.size, '上一个 assistant(tool_calls) 未全部回复').toBe(0);
      expected = new Set(m.tool_calls.map(t => t.id));
    } else if (m.role === 'tool' && m.tool_call_id) {
      expect(expected.has(m.tool_call_id), `孤立 tool: ${m.tool_call_id}`).toBe(true);
      expected.delete(m.tool_call_id);
    } else {
      expect(expected.size, `未回复的 assistant(tool_calls) 之后出现 ${m.role}`).toBe(0);
    }
  }
  expect(expected.size, '结尾存在未回复的 assistant(tool_calls)').toBe(0);
}

describe('estimateTotalTokens', () => {
  it('estimates tokens from message content', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'You are an AI assistant.' },
      { role: 'user', content: 'Hello world' },
    ];
    const tokens = estimateTotalTokens(msgs);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns 0 for empty messages', () => {
    expect(estimateTotalTokens([])).toBe(0);
  });

  it('多模态消息（ContentPart[]）按 JSON 长度估算', () => {
    const msgs: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100) } },
      ],
    }];
    const tokens = estimateTotalTokens(msgs);
    // JSON 序列化长度 / 4 向上取整，> 纯文本长度/4（图片 URL 计入）
    expect(tokens).toBeGreaterThan(20);
  });

  it('压缩多模态 user 消息：摘要保留图片占位而非空壳', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'q4' },
      { role: 'assistant', content: 'a4' },
    ];
    const out = compressMessages(msgs, 1, 3);
    const summary = out.find((m) =>
      m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[Previous conversation summary'));
    expect(summary).toBeTruthy();
    expect((summary!.content as string)).toContain('看这张图');
    expect((summary!.content as string)).toContain('[图片:');
  });
});

describe('compressMessages', () => {
  const msgs: Message[] = [
    { role: 'system', content: 'System prompt' },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `Message number ${i} with some additional content to make it longer for token estimation purposes`,
    })),
  ];

  it('compresses when over token limit', () => {
    const originalTokens = estimateTotalTokens(msgs);
    const compressed = compressMessages(msgs, 100, 5);  // very low limit to force compression
    const compressedTokens = estimateTotalTokens(compressed);
    expect(compressedTokens).toBeLessThan(originalTokens);
  });

  it('keeps system message and tail messages', () => {
    const compressed = compressMessages(msgs, 100, 3);
    const sysMsgs = compressed.filter(m => m.role === 'system');
    expect(sysMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('returns original if under limit', () => {
    const small: Message[] = [{ role: 'user', content: 'hi' }];
    const result = compressMessages(small, 10000, 5);
    expect(result).toEqual(small);
  });

  function toolConversation(): Message[] {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user task' },
    ];
    const pushRound = (ids: string[]) => {
      msgs.push(calls(ids));
      for (const id of ids) msgs.push(toolReply(id));
    };
    pushRound(['a1', 'a2', 'a3']);
    pushRound(['b1', 'b2']);
    pushRound(['c1']);
    pushRound(['d1']);
    return msgs;
  }

  it('边界落在 tool 响应上时左扩到 assistant(tool_calls)，输出无孤立 tool', () => {
    // 旧实现 keepLast=5 的保留区以 tool b2 开头（其 assistant 被摘要掉）→ DeepSeek 400
    const out = compressMessages(toolConversation(), 1, 5);
    expectPairingValid(out);
    expect(out.filter(m => m.role === 'system').length).toBe(1);
    expect(
      out.some(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[Previous conversation summary')),
    ).toBe(true);
    // b 轮整组保留（assistant + 两条响应）
    expect(
      out.some(m => m.role === 'assistant' && m.tool_calls?.map(t => t.id).join() === 'b1,b2'),
    ).toBe(true);
    expect(out.some(m => m.role === 'tool' && m.tool_call_id === 'b1')).toBe(true);
    expect(out.some(m => m.role === 'tool' && m.tool_call_id === 'b2')).toBe(true);
    // a 轮的 tool 响应不裸留在保留区（只出现在摘要文本里）
    expect(out.filter(m => m.role === 'tool' && m.tool_call_id?.startsWith('a')).length).toBe(0);
  });

  it('结尾未回复的 assistant(tool_calls) 整段移出保留区', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user task' },
      calls(['a1', 'a2']),
      toolReply('a1'),
      calls(['b1']), // 中断残留：未回复
    ];
    const out = compressMessages(msgs, 1, 2);
    expectPairingValid(out);
    expect(out.some(m => m.role === 'assistant' && m.tool_calls?.some(t => t.id === 'b1'))).toBe(false);
  });

  it('历史损坏：保留区内残留的孤立 tool 被丢弃', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user task' },
      calls(['a1']),
      toolReply('a1'),
      toolReply('orphan1'), // 旧版压缩留下的孤立 tool
      calls(['c1']),
      toolReply('c1'),
    ];
    const out = compressMessages(msgs, 1, 4);
    expectPairingValid(out);
    expect(out.some(m => m.role === 'tool' && m.tool_call_id === 'orphan1')).toBe(false);
  });

  it('无可压缩中间段时返回原列表，不生成空摘要', () => {
    const msgs = toolConversation();
    const out = compressMessages(msgs, 1, 100);
    expect(out).toBe(msgs);
  });
});

describe('sanitizeMessagePairing', () => {
  it('有效序列原样保留', () => {
    const msgs: Message[] = [calls(['a1', 'a2']), toolReply('a1'), toolReply('a2')];
    expect(sanitizeMessagePairing(msgs)).toEqual(msgs);
  });

  it('丢弃孤立 tool 响应', () => {
    const out = sanitizeMessagePairing([
      calls(['a1']),
      toolReply('a1'),
      toolReply('orphan'),
    ]);
    expect(out.map(m => (m.role === 'tool' ? m.tool_call_id : m.role))).toEqual([
      'assistant',
      'a1',
    ]);
  });

  it('未回复的 assistant(tool_calls) 连同部分响应整段移除', () => {
    const out = sanitizeMessagePairing([
      calls(['a1', 'a2']),
      toolReply('a1'),
      { role: 'assistant', content: 'next' },
    ]);
    expect(out).toEqual([{ role: 'assistant', content: 'next' }]);
  });

  it('结尾未回复段被移除', () => {
    const out = sanitizeMessagePairing([
      calls(['a1']),
      toolReply('a1'),
      calls(['b1']),
    ]);
    expectPairingValid(out);
    expect(out.some(m => m.tool_calls?.some(t => t.id === 'b1'))).toBe(false);
  });

  it('丢弃空 assistant 消息（无 content 且无 tool_calls，DeepSeek 400 根因）', () => {
    const out = sanitizeMessagePairing([
      { role: 'assistant', content: '正常回答' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '好了吗?' },
    ]);
    expect(out).toEqual([
      { role: 'assistant', content: '正常回答' },
      { role: 'user', content: '好了吗?' },
    ]);
  });

  it('空 assistant 夹在工具段后：段关闭且丢弃，后续消息保留', () => {
    const out = sanitizeMessagePairing([
      calls(['a1']),
      toolReply('a1'),
      { role: 'assistant', content: null },
      { role: 'user', content: '继续' },
    ]);
    expectPairingValid(out);
    expect(out).toEqual([
      calls(['a1']),
      toolReply('a1'),
      { role: 'user', content: '继续' },
    ]);
  });

  it('有 content 或 tool_calls 的 assistant 正常保留', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: 'ok' },
      calls(['a1']),
      toolReply('a1'),
    ];
    expect(sanitizeMessagePairing(msgs)).toEqual(msgs);
  });
});

describe('compressMessagesV2', () => {
  /** 构造 N 个 user 轮：每轮 user 提问 + assistant 回答 */
  function conversation(turns: number): Message[] {
    const msgs: Message[] = [{ role: 'system', content: 'System prompt' }];
    for (let i = 0; i < turns; i++) {
      msgs.push({ role: 'user', content: `第 ${i} 个问题：需要分析的上下文内容填充文本 ${'x'.repeat(100)}` });
      msgs.push({ role: 'assistant', content: `第 ${i} 个回答：结果摘要 ${i}` });
    }
    return msgs;
  }

  it('未超阈值时原样返回（method=none）', async () => {
    const msgs = conversation(3);
    const result = await compressMessagesV2(msgs, { maxTokens: 1_000_000 });
    expect(result.method).toBe('none');
    expect(result.messages).toBe(msgs);
  });

  it('超阈值时压缩，保留 system 与最近 N 轮，中间生成单条 _summary', async () => {
    const msgs = conversation(30);
    const before = estimateTotalTokens(msgs);
    const result = await compressMessagesV2(msgs, {
      maxTokens: 200,
      keepRecentTurns: 5,
    });
    expect(result.method).toBe('rule');
    const out = result.messages;
    expect(estimateTotalTokens(out)).toBeLessThan(before);

    // system 保留
    expect(out.filter(m => m.role === 'system').length).toBe(1);
    // 摘要只有一条（user 角色，带标记）
    const summaries = out.filter(m => isSummaryMessage(m));
    expect(summaries.length).toBe(1);
    expect(summaries[0].role).toBe('user');
    expect(summaries[0].content).toContain(SUMMARY_MARKER);
    // 最近 5 个 assistant 轮完整保留（含其后的 user/工具消息）
    const tailUsers = out.filter(m => m.role === 'user' && !isSummaryMessage(m));
    expect(tailUsers.length).toBe(4);
    expect(tailUsers[0].content).toContain('第 26 个问题');
    expect(tailUsers[3].content).toContain('第 29 个问题');
    // 被摘要覆盖的轮次不再保留原文（摘要消息本身除外）
    expect(
      out.some(m => m.role === 'user' && !isSummaryMessage(m) && typeof m.content === 'string' && m.content.includes('第 0 个问题')),
    ).toBe(false);
  });

  it('多次压缩只保留最新一条 _summary', async () => {
    let msgs = conversation(30);
    const first = await compressMessagesV2(msgs, { maxTokens: 200, keepRecentTurns: 5 });
    expect(first.method).toBe('rule');
    const second = await compressMessagesV2(first.messages, {
      maxTokens: 300,
      keepRecentTurns: 3,
      summarize: async () => '## 原始请求\n第二次生成的摘要',
    });
    expect(second.method).toBe('llm');
    const summaries = second.messages.filter(m => isSummaryMessage(m));
    expect(summaries.length).toBe(1);
    expect(summaries[0].content).toContain('第二次生成的摘要');
  });

  it('压缩不破坏 tool_calls ↔ tool 响应配对', async () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user task' },
    ];
    for (let i = 0; i < 15; i++) {
      msgs.push(calls([`r${i}a`, `r${i}b`]));
      msgs.push(toolReply(`r${i}a`));
      msgs.push(toolReply(`r${i}b`));
    }
    const result = await compressMessagesV2(msgs, { maxTokens: 100, keepRecentTurns: 3 });
    expect(result.method).toBe('rule');
    expectPairingValid(result.messages);
    expect(result.messages.some(m => isSummaryMessage(m))).toBe(true);
  });

  it('LLM 摘要成功 → method=llm 且内容包含返回文本', async () => {
    const msgs = conversation(20);
    const result = await compressMessagesV2(msgs, {
      maxTokens: 200,
      keepRecentTurns: 4,
      summarize: async (middle, focus) => {
        expect(middle.length).toBeGreaterThan(0);
        return `## 原始请求\n聚焦：${focus ?? '无'}\n## 已完成事项\n- 完成了 X`;
      },
    });
    expect(result.method).toBe('llm');
    const summary = result.messages.find(m => isSummaryMessage(m))!;
    expect(summary.content).toContain('完成了 X');
  });

  it('LLM 摘要失败（抛错）→ 降级规则摘要，不阻断', async () => {
    const msgs = conversation(20);
    const summarize = vi.fn(async () => {
      throw new Error('API timeout');
    });
    const result = await compressMessagesV2(msgs, {
      maxTokens: 200,
      keepRecentTurns: 4,
      summarize,
    });
    expect(result.method).toBe('rule');
    const summary = result.messages.find(m => isSummaryMessage(m))!;
    for (const field of ['## 原始请求', '## 已完成事项', '## 关键发现与引用索引', '## 当前计划', '## 下一步待办', '## 失败与阻塞']) {
      expect(summary.content).toContain(field);
    }
  });

  it('LLM 摘要返回空 → 降级规则摘要', async () => {
    const msgs = conversation(20);
    const result = await compressMessagesV2(msgs, {
      maxTokens: 200,
      keepRecentTurns: 4,
      summarize: async () => null,
    });
    expect(result.method).toBe('rule');
  });

  it('无可压缩中间段 → method=none', async () => {
    const msgs = conversation(2);
    const result = await compressMessagesV2(msgs, { maxTokens: 1, keepRecentTurns: 10 });
    expect(result.method).toBe('none');
    expect(result.messages).toBe(msgs);
  });

  it('force=true 忽略阈值检查，有中间段即压缩（/compact 手动触发语义）', async () => {
    const msgs = conversation(6);
    // 未超阈值：默认不压缩
    const passive = await compressMessagesV2(msgs, { maxTokens: 1_000_000, keepRecentTurns: 2 });
    expect(passive.method).toBe('none');
    // force：强制压缩中间段
    const forced = await compressMessagesV2(msgs, {
      maxTokens: 1_000_000,
      keepRecentTurns: 2,
      force: true,
    });
    expect(forced.method).toBe('rule');
    expect(forced.messages.some(m => isSummaryMessage(m))).toBe(true);
  });
});

describe('buildRuleSummary', () => {
  it('结构化字段完整，包含工具与错误信息', () => {
    const msgs: Message[] = [
      { role: 'user', content: '看看这个项目' },
      calls(['g1']),
      toolReply('g1'),
      { role: 'assistant', content: '发现关键文件 src/main.ts' },
      calls(['e1']),
      { role: 'tool', content: 'ERR_TOOL_TIMEOUT: shell timeout', tool_call_id: 'e1', name: 'shell' },
    ];
    const summary = buildRuleSummary(msgs);
    expect(summary).toContain('## 原始请求');
    expect(summary).toContain('看看这个项目');
    expect(summary).toContain('调用了工具 read');
    expect(summary).toContain('ERR_TOOL_TIMEOUT');
    expect(summary).toContain('src/main.ts');
  });

  it('提取 Ref 引用索引', () => {
    const msgs: Message[] = [
      { role: 'user', content: '查一下' },
      calls(['r1']),
      { role: 'tool', content: '[Ref:a1b2c3d4] Tool read output (12345 chars)', tool_call_id: 'r1', name: 'read' },
    ];
    const summary = buildRuleSummary(msgs);
    expect(summary).toContain('a1b2c3d4');
  });
});
