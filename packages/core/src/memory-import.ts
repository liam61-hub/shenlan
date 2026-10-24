/**
 * @import 递归展开 — 记忆正文与项目指令共用
 *
 * 语法：`@import <相对路径 | ~/绝对路径>` 独占一行，导入目标文件全文并原地替换。
 * 展开发生在 token 预算**之前**（否则预算可被 import 绕过），所以本模块只做
 * 有硬边界的展开：深度 ≤ 5、realpath 环检测、单文件字节上限、代码围栏内不解析、
 * 路径过 isPathSafe。所有拒绝都产内联标记 `<!-- @import skipped: … -->` 而非静默丢弃。
 */
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { isPathSafe } from './security.js';

/** `@import <路径>` 独占一行 */
const IMPORT_RE = /^@import\s+(.+)$/;
/** 默认最大嵌套深度（根文件 = 0，其导入 = 1，依此类推） */
export const IMPORT_MAX_DEPTH = 5;
/** 默认单文件字节上限（含被导入文件） */
export const IMPORT_MAX_FILE_BYTES = 64 * 1024;

export interface ExpandImportsOptions {
  maxDepth?: number;
  maxFileBytes?: number;
}

export interface ExpandImportsResult {
  /** 展开后的全文（拒绝处保留内联跳过标记） */
  text: string;
  /** 成功展开的文件（realpath，按展开顺序） */
  imported: string[];
  /** 被拒绝的导入（带原因） */
  skipped: { path: string; reason: string }[];
}

/**
 * 展开 text 中围栏外的 @import 行。
 *
 * @param baseDir 相对路径的解析基准（根文件所在目录）
 */
export function expandImports(
  text: string,
  baseDir: string,
  options: ExpandImportsOptions = {},
): ExpandImportsResult {
  const maxDepth = options.maxDepth ?? IMPORT_MAX_DEPTH;
  const maxFileBytes = options.maxFileBytes ?? IMPORT_MAX_FILE_BYTES;
  const imported: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const importedSet = new Set<string>();
  /** 当前递归链上的 realpath（环检测：A→B→A 与自引用都命中） */
  const stack = new Set<string>();

  function skipMark(spec: string, reason: string): string {
    skipped.push({ path: spec, reason });
    return `<!-- @import skipped: ${spec} (${reason}) -->`;
  }

  function resolveImport(spec: string, fromDir: string): string {
    const expanded = spec.startsWith('~')
      ? join(homedir(), spec.slice(1))
      : spec;
    return isAbsolute(expanded) ? expanded : resolve(fromDir, expanded);
  }

  /**
   * 展开单段文本（一个文件的全部行）。
   * 围栏状态在本段内跟踪 —— 被导入文件自己的围栏保护它自己的 @import 行，
   * 关闭判定只认同种字符（``` 内的 ~~~ 不是关闭）。
   */
  function expandBlock(block: string, fromDir: string, depth: number): string {
    const out: string[] = [];
    let fence: '`' | '~' | null = null;

    for (const line of block.split('\n')) {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const kind = fenceMatch[1]![0] as '`' | '~';
        // 打开或关闭当前围栏（同种字符才关；异种字符当内容）
        fence = fence === null ? kind : fence === kind ? null : fence;
        out.push(line);
        continue;
      }
      if (fence !== null) {
        out.push(line); // 围栏内原样保留
        continue;
      }

      const m = line.match(IMPORT_RE);
      if (!m) {
        out.push(line);
        continue;
      }

      const spec = m[1]!.trim();
      if (!spec) {
        out.push(skipMark('', '空路径'));
        continue;
      }
      if (depth >= maxDepth) {
        out.push(skipMark(spec, `深度超限（>${maxDepth}）`));
        continue;
      }

      const target = resolveImport(spec, fromDir);
      const safe = isPathSafe(target);
      if (!safe.safe) {
        out.push(skipMark(spec, safe.reason ?? '路径不安全'));
        continue;
      }
      if (!existsSync(target)) {
        out.push(skipMark(spec, '文件不存在'));
        continue;
      }

      let real: string;
      try {
        real = realpathSync(target);
      } catch {
        out.push(skipMark(spec, '无法解析路径'));
        continue;
      }
      if (stack.has(real)) {
        out.push(skipMark(spec, '循环导入'));
        continue;
      }

      let size = 0;
      try {
        size = statSync(target).size;
      } catch { /* 下面 readFileSync 会再次报错 */ }
      if (size > maxFileBytes) {
        out.push(skipMark(spec, `文件超限（>${maxFileBytes} 字节）`));
        continue;
      }

      let fileText: string;
      try {
        fileText = readFileSync(target, 'utf-8');
      } catch {
        out.push(skipMark(spec, '读取失败'));
        continue;
      }

      stack.add(real);
      out.push(expandBlock(fileText, dirname(target), depth + 1));
      stack.delete(real);
      if (!importedSet.has(real)) {
        importedSet.add(real);
        imported.push(real);
      }
    }

    return out.join('\n');
  }

  const text2 = expandBlock(text, baseDir, 0);
  return { text: text2, imported, skipped };
}
