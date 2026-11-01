/**
 * 确认弹窗选项构建 — Codex CLI 审批样式
 *
 * 按操作类型生成上下文相关的标题、详情与选项：
 *   - edit：Would you like to make the following edits?  + 文件列表
 *   - command：Would you like to run the following command? + $ cmd
 *   - plan：Implement this plan?（/plan off 时询问是否进入实施）
 */
import type { ConfirmKind, ConfirmOption } from './context.js';
import { capLine } from './streaming.js';
import { displayWidth } from './markdown-utils.js';
import type { Lang } from '@shenlan/core';

/** 命令详情最多显示宽度（截断用） */
const DETAIL_MAX_WIDTH = 78;
/** 命令前缀在选项标签中的最大显示宽度 */
const PREFIX_MAX_WIDTH = 50;

export function buildConfirmTitle(kind: ConfirmKind, language: Lang = 'en'): string {
  if (language === 'zh-CN') {
    switch (kind) {
      case 'create': return '要创建这个文件吗？';
      case 'edit': return '要修改这些文件吗？';
      case 'external': return '要执行这个外部工具吗？';
      case 'destructive': return '要执行这个破坏性操作吗？';
      case 'command': return '要运行这条命令吗？';
      case 'plan': return '要实施这个计划吗？';
      case 'delete': return '要删除这条记忆吗？';
      case 'high-risk': return '⚠️ 高危命令：请输入确认短语';
    }
  }
  switch (kind) {
    case 'create': return 'Would you like to create this file?';
    case 'external': return 'Would you like to run this external tool?';
    case 'destructive': return 'Would you like to run this destructive action?';
    case 'edit':
      return 'Would you like to make the following edits?';
    case 'command':
      return 'Would you like to run the following command?';
    case 'plan':
      return 'Implement this plan?';
    case 'delete':
      return 'Delete this memory?';
    case 'high-risk':
      return '⚠️ High-risk command — enter the confirmation phrase';
  }
}

/** 详情行：edit=每个文件一行（✎ 前缀由渲染层加），command=命令原文 */
export function buildConfirmDetail(kind: ConfirmKind, info: { paths?: string[]; command?: string; pattern?: string }, language: Lang = 'en'): string[] {
  if (kind === 'edit' || kind === 'create') {
    const paths = (info.paths || []).map(p => capLine(p, DETAIL_MAX_WIDTH));
    return paths.length > 0 ? paths : [capLine(info.command || '', DETAIL_MAX_WIDTH)];
  }
  if (kind === 'command') {
    const cmd = info.command || '';
    return wrapCommand(cmd);
  }
  if (kind === 'high-risk') {
    const lines = wrapCommand(info.command || '');
    if (info.pattern) lines.push(capLine(`${language === 'zh-CN' ? '命中规则' : 'matched pattern'}: ${info.pattern}`, DETAIL_MAX_WIDTH));
    return lines;
  }
  if (kind === 'external' || kind === 'destructive') return [capLine(info.command || '', DETAIL_MAX_WIDTH)];
  return [];
}

/**
 * 长命令按显示宽度换行（最多 3 行），避免撑高动态帧。
 * 超过 3 行的部分在最后一行以 … 结尾。
 */
function wrapCommand(cmd: string, maxWidth = DETAIL_MAX_WIDTH, maxLines = 3): string[] {
  const words = cmd.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [capLine(cmd, maxWidth)];

  const lines: string[] = [];
  let current = '';
  let truncated = false;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) > maxWidth && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

  const shown = lines.join(' ').replace(/…$/, '');
  if (truncated || shown.length < cmd.trim().length) {
    lines[lines.length - 1] = capLine(lines[lines.length - 1] || '', maxWidth - 1) + '…';
  }
  return lines.map(l => capLine(l, maxWidth));
}

export function buildConfirmOptions(
  kind: ConfirmKind,
  info: { paths?: string[]; prefix?: string; family?: boolean } = {},
  language: Lang = 'en',
): ConfirmOption[] {
  const zh = language === 'zh-CN';
  if (kind === 'plan') {
    return [
      { label: zh ? '实施此计划' : 'Yes, implement this plan', key: '1', value: 'allow' },
      { label: zh ? '清空上下文后实施' : 'Yes, clear context and implement', key: '2', value: 'allow_clear' },
      { label: zh ? '留在计划模式' : 'No, stay in Plan mode', key: '3', value: 'deny' },
    ];
  }
  if (kind === 'delete') {
    return [
      { label: zh ? '删除这条记忆' : 'Yes, delete this memory', key: 'y', value: 'allow' },
      { label: zh ? '保留' : 'No, keep it', key: 'n', value: 'deny' },
    ];
  }
  if (kind === 'command') {
    const prefix = capLine(info.prefix || '', PREFIX_MAX_WIDTH);
    return [
      { label: zh ? '仅本次执行' : 'Yes, proceed once', key: 'y', value: 'allow' },
      {
        label: zh ? `本会话允许${info.family ? '命令族' : '精确命令'} ${prefix}` : `Allow ${info.family ? 'command family' : 'exact command'} ${prefix} this session`,
        key: 'p',
        value: 'allow_prefix',
      },
      { label: zh ? '拒绝并说明原因' : 'No, and tell me what to do differently', key: 'esc', value: 'feedback' },
    ];
  }
  if (kind === 'high-risk') {
    // 唯一选项：进入反馈输入模式，输入确认短语后 Enter 提交（Esc 拒绝）
    return [{ label: zh ? '输入确认短语后回车' : 'Enter the confirmation phrase', key: 'y', value: 'feedback' }];
  }
  if (kind === 'destructive') return [
    { label: zh ? '仅本次允许' : 'Allow once', key: 'y', value: 'allow' },
    { label: zh ? '拒绝并说明原因' : 'No, and tell me what to do differently', key: 'esc', value: 'feedback' },
  ];
  if (kind === 'external') return [
    { label: zh ? '仅本次允许' : 'Allow once', key: 'y', value: 'allow' },
    { label: zh ? '本会话允许此工具' : 'Allow this tool for this session', key: 'a', value: 'allow_session' },
    { label: zh ? '拒绝并说明原因' : 'No, and tell me what to do differently', key: 'esc', value: 'feedback' },
  ];
  return [
    { label: zh ? (kind === 'create' ? '仅本次创建' : '仅本次修改') : 'Yes, proceed once', key: 'y', value: 'allow' },
    { label: zh ? '本会话允许此路径' : 'Allow this path for this session', key: 'a', value: 'allow_paths' },
    { label: zh ? '拒绝并说明原因' : 'No, and tell me what to do differently', key: 'esc', value: 'feedback' },
  ];
}
