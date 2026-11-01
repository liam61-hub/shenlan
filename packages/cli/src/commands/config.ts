/**
 * /config 命令 — schema 驱动的通用配置管理（get / set / unset / 无参展示）
 *
 * 键目录在 core config-schema.ts（CONFIG_KEYS + providerKeys 前缀规则），
 * 新增配置开关只需加一条 schema 条目，类型校验/掩码/补全自动生效。
 * 文案与配置描述随 config.language 双语切换（默认 en）。
 */
import chalk from 'chalk';
import {
  loadConfig,
  readRawConfig,
  updateConfig,
  writeConfigFile,
  globalConfigPath,
  projectConfigPath,
  CONFIG_KEYS,
  lookupConfigKey,
  parseConfigValue,
  getNested,
  setNested,
  deleteNested,
  maskSecret,
  ENV_VARS,
  descText,
  type ShenlanConfig,
  type ConfigKeyMeta,
  type Lang,
} from '@shenlan/core';
import { UI, langOf } from '../i18n.js';

/** 环境变量来源映射（get 展示值来源用）；providerKeys.<p> 动态映射 <P>_API_KEY */
const ENV_SOURCES: Record<string, string> = {
  'model.model': 'SHENLAN_MODEL',
  'model.baseUrl': 'SHENLAN_BASE_URL',
  'model.apiKey': 'SHENLAN_API_KEY',
};

/** 敏感键掩码展示（非敏感键原样转字符串；未设置显示 —） */
function maskValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return '—';
  const meta = lookupConfigKey(key);
  if (meta?.secret && typeof value === 'string' && value !== '') return maskSecret(value);
  return String(value);
}

/** 值来源：环境变量 → 项目配置 → 全局配置 → 默认。
 *  全局值等于 schema 默认时视为「默认」——首次运行自动生成的全局文件即默认值。 */
function valueSource(key: string, cwd: string): 'env' | 'project' | 'global' | 'default' {
  const envVar = ENV_SOURCES[key]
    || (key.startsWith('providerKeys.') ? `${key.split('.')[1]?.toUpperCase()}_API_KEY` : '');
  if (envVar && process.env[envVar]) return 'env';
  if (getNested(readRawConfig(projectConfigPath(cwd)) || {}, key) !== undefined) return 'project';
  const gVal = getNested(readRawConfig(globalConfigPath()) || {}, key);
  if (gVal !== undefined) {
    const meta = lookupConfigKey(key);
    if (meta?.default !== undefined && gVal === meta.default) return 'default';
    return 'global';
  }
  return 'default';
}

/** 来源标签按语言展示（面板与文本清单共用） */
export function sourceLabel(src: 'env' | 'project' | 'global' | 'default', lang: Lang): string {
  switch (src) {
    case 'env': return 'env';
    case 'project': return UI[lang].sourceProject;
    case 'global': return UI[lang].sourceGlobal;
    default: return UI[lang].sourceDefault;
  }
}

/** unset 后把被掏空的父对象整块移除，保持配置文件整洁 */
function pruneEmptyParents(obj: Record<string, unknown>, key: string): void {
  const parts = key.split('.');
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const parent = getNested(obj, parts.slice(0, depth).join('.'));
    if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return;
    if (Object.keys(parent).length === 0) {
      deleteNested(obj, parts.slice(0, depth).join('.'));
    } else {
      return;
    }
  }
}

/** 解析 --global 标志（出现在任意参数位） */
function parseArgs(args: string): { tokens: string[]; scope: 'project' | 'global' } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const isGlobal = tokens.includes('--global');
  return { tokens: tokens.filter(t => t !== '--global'), scope: isGlobal ? 'global' : 'project' };
}

/**
 * /config get|set|unset 的键路径 Tab 补全（InputBox 接入）：
 * 唯一匹配补全完整键，多匹配补全到最长公共前缀；无法推进返回 null。
 */
export function completeConfigKey(input: string): string | null {
  const m = input.trim().match(/^\/config\s+(get|set|unset)\s+([\w.]*)$/i);
  if (!m) return null;
  const prefix = m[2] ?? '';
  const matches = Object.keys(CONFIG_KEYS).filter((k) => k.startsWith(prefix));
  if (matches.length === 0) return null;
  const sub = m[1]!.toLowerCase();
  if (matches.length === 1) return `/config ${sub} ${matches[0]!}`;
  let lcp = matches[0]!;
  for (const k of matches) {
    while (!k.startsWith(lcp)) lcp = lcp.slice(0, -1);
  }
  if (lcp === prefix) return null;
  return `/config ${sub} ${lcp}`;
}

/** 无参：列出全部 schema 键的生效值与来源（敏感键掩码）+ 动态前缀键 + 环境变量区 */
function renderAll(cwd: string): string {
  const config = loadConfig(cwd);
  const lang = langOf(config.language);
  const ui = UI[lang];
  const lines: string[] = [];
  for (const key of Object.keys(CONFIG_KEYS).sort()) {
    const meta = CONFIG_KEYS[key]!;
    lines.push(
      `${chalk.dim(key + ':')} ${maskValue(key, getNested(config, key))} ${chalk.dim(`(${sourceLabel(valueSource(key, cwd), lang)}) ${descText(meta.description, lang)}`)}`,
    );
  }
  // 动态前缀键单独列出（providerKeys.<provider>）
  for (const [provider, v] of Object.entries(config.providerKeys || {})) {
    const key = `providerKeys.${provider}`;
    lines.push(
      `${chalk.dim(key + ':')} ${maskSecret(String(v))} ${chalk.dim(`(${sourceLabel(valueSource(key, cwd), lang)}) ${ui.providerKeyTag}`)}`,
    );
  }
  // 请求端点覆盖（providerBaseUrls.<provider>）
  for (const [provider, v] of Object.entries(config.providerBaseUrls || {})) {
    const key = `providerBaseUrls.${provider}`;
    lines.push(
      `${chalk.dim(key + ':')} ${maskSecret(String(v))} ${chalk.dim(`(${sourceLabel(valueSource(key, cwd), lang)}) ${ui.providerUrlTag}`)}`,
    );
  }
  // 环境变量区：已设置显示（敏感掩码），未设置显示 —
  for (const ev of ENV_VARS) {
    if (ev.name === '<PROVIDER>_API_KEY') {
      // 模式行：枚举已设置的 provider key 环境变量，全部未设置时显示模式行本身
      const setKeys = Object.keys(process.env)
        .filter((k) => /^[A-Z0-9]+_API_KEY$/.test(k) && k !== 'SHENLAN_API_KEY')
        .sort();
      if (setKeys.length === 0) {
        lines.push(`${chalk.dim(ev.name + ':')} — ${chalk.dim(`(${ui.sourceUnset}) ${descText(ev.description, lang)}`)}`);
      } else {
        for (const k of setKeys) {
          lines.push(`${chalk.dim(k + ':')} ${maskSecret(process.env[k]!)} ${chalk.dim('(env)')}`);
        }
      }
      continue;
    }
    const raw = process.env[ev.name];
    const shown = raw === undefined ? '—' : ev.secret ? maskSecret(raw) : raw;
    lines.push(
      `${chalk.dim(ev.name + ':')} ${shown} ${chalk.dim(`(${raw === undefined ? ui.sourceUnset : 'env'}) ${descText(ev.description, lang)}`)}`,
    );
  }
  return lines.join('\n');
}

export function configCommand(args: string, cwd = process.cwd()): string {
  const { tokens, scope } = parseArgs(args);
  const sub = (tokens[0] || '').toLowerCase();
  const lang = langOf(loadConfig(cwd).language);
  const ui = UI[lang];
  const scopeText = ui.scopeLabel(scope);

  if (!sub) return renderAll(cwd);

  if (sub === 'get') {
    const key = tokens[1];
    if (!key) return `${ui.missingKey} ${ui.usage}`;
    if (!lookupConfigKey(key)) return ui.unknownKey(key);
    const value = getNested(loadConfig(cwd), key);
    return `${chalk.dim(key + ':')} ${maskValue(key, value)} ${chalk.dim(`(${sourceLabel(valueSource(key, cwd), lang)})`)}`;
  }

  if (sub === 'set') {
    const key = tokens[1];
    const raw = tokens[2];
    if (!key || raw === undefined) return `${ui.missingArgs} ${ui.usage}`;
    const parsed = parseConfigValue(key, raw);
    if (!parsed.ok) return parsed.error;
    const patch = setNested({}, key, parsed.value) as unknown as Parameters<typeof updateConfig>[0];
    updateConfig(patch, { scope, cwd });
    return `${chalk.dim(key + ' =')} ${maskValue(key, parsed.value)} ${chalk.dim(`(${scopeText})`)}`;
  }

  if (sub === 'unset') {
    const key = tokens[1];
    if (!key) return `${ui.missingKey} ${ui.usage}`;
    if (!lookupConfigKey(key)) return ui.unknownKey(key);
    const file = scope === 'global' ? globalConfigPath() : projectConfigPath(cwd);
    const raw = readRawConfig(file);
    if (!raw || !deleteNested(raw, key)) return `${key} ${ui.cmdNotSet}`;
    pruneEmptyParents(raw, key);
    writeConfigFile(file, raw);
    return `${chalk.dim(key)} ${ui.removed(scopeText)}`;
  }

  return `${ui.unknownSub(sub)} ${ui.usage}`;
}

// ===== 交互式 /config 面板数据层 =====

/** 面板行（/config 面板渲染用） */
export interface ConfigRow {
  key: string;
  /** boolean：←/→ 取反；enum：←/→ 循环 allowedValues；string/number：Enter 编辑；array：只读 */
  kind: 'boolean' | 'enum' | 'string' | 'number' | 'array';
  /** 掩码后的展示值 */
  display: string;
  /** 编辑预填的原始值 */
  raw: string;
  /** 值来源标签 */
  source: 'env' | 'project' | 'global' | 'default';
  /** 已按当前语言解析的描述（语言切换后由 buildConfigRows 重建） */
  description: string;
  allowedValues?: string[];
  secret: boolean;
}

/** 面板作用域（与 /config set 默认一致：project） */
export type ConfigPanelScope = 'project' | 'global';

function rowKind(meta: ConfigKeyMeta): ConfigRow['kind'] {
  if (meta.type === 'boolean') return 'boolean';
  if (meta.allowedValues) return 'enum';
  if (meta.type === 'number') return 'number';
  return 'string';
}

/** 动态前缀行（providerKeys.<p> / providerBaseUrls.<p>） */
function dynamicRow(key: string, value: string, lang: Lang, cwd: string): ConfigRow {
  const meta = lookupConfigKey(key)!;
  return {
    key,
    kind: 'string',
    display: value ? maskSecret(value) : '—',
    raw: value,
    source: valueSource(key, cwd),
    description: descText(meta.description, lang),
    secret: true,
  };
}

/** 构建面板行：schema 键全量（排序）+ providerKeys / providerBaseUrls 动态行 */
export function buildConfigRows(config: ShenlanConfig, cwd: string): ConfigRow[] {
  const lang = langOf(config.language);
  const rows: ConfigRow[] = [];
  for (const key of Object.keys(CONFIG_KEYS).sort()) {
    const meta = CONFIG_KEYS[key]!;
    const value = getNested(config, key);
    const isArray = Array.isArray(value);
    rows.push({
      key,
      kind: isArray ? 'array' : rowKind(meta),
      display: isArray ? (value as unknown[]).join(', ') : maskValue(key, value),
      raw: isArray ? (value as unknown[]).join(', ') : (value === undefined || value === null ? '' : String(value)),
      source: valueSource(key, cwd),
      description: descText(meta.description, lang),
      allowedValues: meta.allowedValues,
      secret: meta.secret ?? false,
    });
  }
  for (const [provider, v] of Object.entries(config.providerKeys || {})) {
    rows.push(dynamicRow(`providerKeys.${provider}`, String(v), lang, cwd));
  }
  for (const [provider, v] of Object.entries(config.providerBaseUrls || {})) {
    rows.push(dynamicRow(`providerBaseUrls.${provider}`, String(v), lang, cwd));
  }
  return rows;
}

export type ConfigPanelSetResult = { ok: true; value: string | number | boolean } | { ok: false; error: string };

/** 面板保存统一入口：schema 校验 → 写盘（原子写） */
export function configPanelSet(
  key: string,
  raw: string,
  scope: ConfigPanelScope,
  cwd = process.cwd(),
): ConfigPanelSetResult {
  const parsed = parseConfigValue(key, raw);
  if (!parsed.ok) return parsed;
  const patch = setNested({}, key, parsed.value) as unknown as Parameters<typeof updateConfig>[0];
  updateConfig(patch, { scope, cwd });
  return { ok: true, value: parsed.value };
}

/** 面板恢复默认：删除指定作用域文件中的键；未设置返回 null（调用方提示） */
export function configPanelUnset(key: string, scope: ConfigPanelScope, cwd = process.cwd()): string | null {
  const file = scope === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const raw = readRawConfig(file);
  if (!raw || !deleteNested(raw, key)) return null;
  pruneEmptyParents(raw, key);
  writeConfigFile(file, raw);
  return key;
}

/**
 * 用 loadConfig 的最新结果整体替换会话内 config（保持同一对象引用）。
 * /config 面板写盘后调用：repl 每轮任务读取当前配置
 * 字段，原地替换即让修改对当前会话即时生效，无需重启。
 */
export function reloadConfigInPlace(config: ShenlanConfig, cwd = process.cwd()): void {
  const fresh = loadConfig(cwd);
  const target = config as unknown as Record<string, unknown>;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, fresh as unknown as Record<string, unknown>);
}
