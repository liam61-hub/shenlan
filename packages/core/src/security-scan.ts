/**
 * 提交时安全检查 — 在暂存内容/文本里扫描疑似密钥与硬禁止配置文件。
 *
 * 规则表（按声明顺序匹配，先命中的规则优先）：
 *   - 常见 API key 前缀（sk- / sk-ant- / AKIA / ghp_ / github_pat_ / AIza / xox*）
 *   - Authorization: Bearer <token>
 *   - 通用赋值（api_key|secret|token|password = <16+ 位字母数字>）
 *   - 硬禁止路径：.shenlan/config.json、.env、.env.*
 *
 * 输出 matched 一律掩码（保留首 4 + **** + 尾 4），不泄露完整密钥。
 */

export interface SecretMatch {
  /** 扫描的文件名（原样透传） */
  file: string;
  /** 行号（1-based；硬禁止路径为 0） */
  line: number;
  /** 命中规则名（安全提示文案用） */
  rule: string;
  /** 掩码后的命中内容 */
  matched: string;
}

interface SecretRule {
  id: string;
  label: string;
  re: RegExp;
}

const RULES: SecretRule[] = [
  { id: 'sk-ant-key', label: 'Anthropic API key (sk-ant-)', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', label: 'OpenAI-style API key (sk-)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aws-key', label: 'AWS Access Key (AKIA)', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-classic-token', label: 'GitHub token (ghp_)', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { id: 'github-fine-grained-token', label: 'GitHub fine-grained token (github_pat_)', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'google-key', label: 'Google API key (AIza)', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack-token', label: 'Slack token (xox*)', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'bearer-token', label: 'Authorization Bearer token', re: /Authorization:\s*["'`]?Bearer\s+["'`]?[A-Za-z0-9._\-]{20,}/gi },
  {
    id: 'generic-secret',
    label: '疑似密钥赋值（api_key/secret/token/password = <16+ 位>）',
    re: /(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._\-]{16,}/gi,
  },
];

/** 掩码：保留首 4 + **** + 尾 4 */
export function maskSecret(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return '****';
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

function maskMatch(text: string, fullMatch: string): string {
  // 通用赋值规则：只掩码值部分，保留 key 名（api_key=****abcd）
  const assign = fullMatch.match(/^([A-Za-z0-9_]+)\s*[:=]\s*(.+)$/i);
  if (assign) return `${assign[1]}=${maskSecret(assign[2].replace(/^["']|["']$/g, ''))}`;
  // Bearer 规则：保留 Authorization: Bearer 前缀
  const bearer = fullMatch.match(/^(Authorization:\s*Bearer\s+)(.+)$/i);
  if (bearer) return `${bearer[1]}${maskSecret(bearer[2])}`;
  return maskSecret(text);
}

/** 硬禁止路径：.shenlan/config.json、.env、.env.*（任意目录层级） */
export function isBlockedPath(filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  if (/\.shenlan\/config\.json$/i.test(normalized)) return true;
  const base = normalized.split('/').pop() || '';
  return base === '.env' || /^\.env\.[A-Za-z0-9._-]+$/.test(base);
}

/**
 * 扫描文本中的疑似密钥。按行扫描输出 line 号；
 * 硬禁止路径直接返回单条 blocked-path 记录（不扫描内容）。
 */
export function scanForSecrets(text: string, filename: string): SecretMatch[] {
  if (isBlockedPath(filename)) {
    return [{
      file: filename,
      line: 0,
      rule: 'blocked-path',
      matched: `<${filename}> 是配置文件（禁止提交），请从版本控制移除`,
    }];
  }

  const matches: SecretMatch[] = [];
  const lines = text.split('\n');
  const seen = new Set<string>(); // 同一 (line, 掩码) 去重

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(line)) !== null) {
        const key = `${i + 1}:${maskMatch(m[0], m[0])}`;
        // 防止规则间重叠（如 sk-ant- 同时匹配 sk-）产生重复噪音
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          file: filename,
          line: i + 1,
          rule: rule.label,
          matched: maskMatch(m[0], m[0]),
        });
      }
    }
  }

  return matches;
}
