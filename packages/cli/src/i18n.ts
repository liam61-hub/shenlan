/**
 * 配置界面（/config 面板与 shenlan config 命令）的双语文案。
 * 语言来自 config.language（默认 en）；配置项描述走 core 的 descText。
 */
import type { Lang } from '@shenlan/core';

/** 归一化语言取值：非 'zh-CN' 一律按 en（默认语言） */
export function langOf(language: unknown): Lang {
  return language === 'zh-CN' ? 'zh-CN' : 'en';
}

export interface ConfigUiStrings {
  panelSubtitle: string;
  scopeLabel: (scope: 'global' | 'project') => string;
  footerList: (scopeLabel: string) => string;
  footerEdit: string;
  editPrefix: string;
  saved: (scopeLabel: string) => string;
  resetDefault: (scopeLabel: string) => string;
  notSet: (scopeLabel: string) => string;
  fromEnv: string;
  isArray: string;
  enterToEdit: string;
  usage: string;
  missingKey: string;
  missingArgs: string;
  unknownKey: (key: string) => string;
  removed: (scopeLabel: string) => string;
  cmdNotSet: string;
  unknownSub: (sub: string) => string;
  sourceDefault: string;
  sourceUnset: string;
  sourceProject: string;
  sourceGlobal: string;
  providerKeyTag: string;
  providerUrlTag: string;
}

export const UI: Record<Lang, ConfigUiStrings> = {
  en: {
    panelSubtitle: 'List all settings; changes are saved and applied immediately',
    scopeLabel: (s) => (s === 'global' ? 'Global' : 'Project'),
    footerList: (scope) =>
      `Scope: ${scope} (g/p toggle) · ←/→ toggle · Enter edit · d reset default · Esc close`,
    footerEdit: 'Enter save · Esc cancel',
    editPrefix: 'Edit',
    saved: (scope) => `saved (${scope})`,
    resetDefault: (scope) => `reset to default (${scope})`,
    notSet: (scope) => `not set in ${scope} config`,
    fromEnv: 'set by environment variable; edit the env var instead',
    isArray: 'is an array; edit the config file',
    enterToEdit: 'Press Enter to edit this value',
    usage: 'Usage: /config [get <key> | set <key> <value> [--global] | unset <key> [--global]]',
    missingKey: 'Missing key.',
    missingArgs: 'Missing arguments.',
    unknownKey: (key) => `Unknown config key: ${key} (run /config to list all keys)`,
    removed: (scope) => `removed (default restored, ${scope})`,
    cmdNotSet: 'not set',
    unknownSub: (sub) => `Unknown subcommand: ${sub}.`,
    sourceDefault: 'default',
    sourceUnset: 'unset',
    sourceProject: 'project',
    sourceGlobal: 'global',
    providerKeyTag: 'API key',
    providerUrlTag: 'endpoint override',
  },
  'zh-CN': {
    panelSubtitle: '列出全部配置项，修改即时写入并生效',
    scopeLabel: (s) => (s === 'global' ? '全局' : '项目'),
    footerList: (scope) =>
      `作用域：${scope}（g/p 切换） · ←/→ 切换 · Enter 编辑 · d 恢复默认 · Esc 关闭`,
    footerEdit: 'Enter 保存 · Esc 取消',
    editPrefix: '编辑',
    saved: (scope) => `已写入（${scope}）`,
    resetDefault: (scope) => `已恢复默认（${scope}）`,
    notSet: (scope) => `未在 ${scope} 配置中设置`,
    fromEnv: '来自环境变量，请修改环境变量',
    isArray: '为数组，请编辑配置文件',
    enterToEdit: 'Enter 编辑该值',
    usage: '用法: /config [get <key> | set <key> <value> [--global] | unset <key> [--global]]',
    missingKey: '缺 key。',
    missingArgs: '缺参数。',
    unknownKey: (key) => `未知配置项: ${key}（/config 查看全部可配键）`,
    removed: (scope) => `已移除（恢复默认，${scope}）`,
    cmdNotSet: '未设置',
    unknownSub: (sub) => `未知子命令: ${sub}。`,
    sourceDefault: '默认',
    sourceUnset: '未设置',
    sourceProject: '项目',
    sourceGlobal: '全局',
    providerKeyTag: 'API Key',
    providerUrlTag: '请求端点',
  },
};
