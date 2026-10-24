import { describe, expect, it } from 'vitest';
import { scanForSecrets, isBlockedPath, maskSecret } from '../security-scan.js';

describe('scanForSecrets — 密钥规则命中', () => {
  it('OpenAI sk- 前缀命中并掩码', () => {
    const hits = scanForSecrets(
      'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";',
      'app.ts',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'app.ts', line: 1, rule: expect.stringContaining('sk-') });
    expect(hits[0].matched).toContain('****');
    expect(hits[0].matched).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('sk-ant- 按 Anthropic 规则报告（不被 sk- 通用规则重复）', () => {
    const hits = scanForSecrets('sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789', 'x.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rule).toContain('Anthropic');
  });

  it('AWS AKIA 命中', () => {
    const hits = scanForSecrets('aws_key=AKIAIOSFODNN7EXAMPLE', 'env.ts');
    expect(hits.some(h => h.rule.includes('AWS'))).toBe(true);
  });

  it('GitHub ghp_ 与 github_pat_ 命中', () => {
    const gh = scanForSecrets('token=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ', 'a.ts');
    expect(gh.some(h => h.rule.includes('GitHub'))).toBe(true);
    const pat = scanForSecrets('github_pat_abcdefghijklmnopqrstuvwxyz123456', 'b.ts');
    expect(pat.some(h => h.rule.includes('GitHub'))).toBe(true);
  });

  it('Google AIza 命中', () => {
    const hits = scanForSecrets('apiKey="AIzaSyA12345678901234567890123456789012"', 'c.ts');
    expect(hits.some(h => h.rule.includes('Google'))).toBe(true);
  });

  // 假样本按 GitHub push protection 拆成字符串拼接：运行时检测器仍命中完整串，静态扫描不误拦
  it('Slack xox 命中', () => {
    const hits = scanForSecrets('xoxb-' + '123456789012-123456789012-abcdefghijklmn', 'd.ts');
    expect(hits.some(h => h.rule.includes('Slack'))).toBe(true);
  });

  it('Authorization Bearer 命中', () => {
    const hits = scanForSecrets('fetch(url, { headers: { Authorization: "Bearer sk-' + 'abcdefghijklmnopqrstuvwxyz123456" } })', 'e.ts');
    expect(hits.some(h => h.rule.includes('Bearer'))).toBe(true);
  });

  it('通用赋值（api_key= / password:）命中且保留键名', () => {
    const hits = scanForSecrets('api_key = "supersecretvalue123456"\npassword: mylongpassword123456', 'f.ts');
    expect(hits.some(h => h.matched.startsWith('api_key='))).toBe(true);
    expect(hits.some(h => h.matched.startsWith('password='))).toBe(true);
  });

  it('行号定位：第二行命中', () => {
    const hits = scanForSecrets('const a = 1;\nconst b = "sk-' + 'abcdefghijklmnopqrstuvwxyz123456";', 'g.ts');
    expect(hits[0]?.line).toBe(2);
  });

  it('正常代码不误报（短 token、非密钥语义）', () => {
    const hits = scanForSecrets(
      'const x = "token=abc";\nconst y = 42;\nfunction foo() { return "short"; }',
      'ok.ts',
    );
    expect(hits).toHaveLength(0);
  });
});

describe('scanForSecrets — 硬禁止路径', () => {
  it('.shenlan/config.json 直接拦截，不扫描内容', () => {
    const hits = scanForSecrets('{"providerKeys":{"deepseek":"sk-' + 'abcdefghijklmnopqrstuvwxyz123456"}}', '.shenlan/config.json');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rule).toBe('blocked-path');
    expect(hits[0]!.line).toBe(0);
    expect(hits[0]!.matched).not.toContain('sk-');
  });

  it('.env 与 .env.local 拦截', () => {
    expect(scanForSecrets('SECRET=x', '.env')[0]!.rule).toBe('blocked-path');
    expect(scanForSecrets('SECRET=x', '.env.production')[0]!.rule).toBe('blocked-path');
  });

  it('isBlockedPath 判定', () => {
    expect(isBlockedPath('.shenlan/config.json')).toBe(true);
    expect(isBlockedPath('a/b/.shenlan/config.json')).toBe(true);
    expect(isBlockedPath('.env')).toBe(true);
    expect(isBlockedPath('.env.test')).toBe(true);
    expect(isBlockedPath('src/config.json')).toBe(false);
    expect(isBlockedPath('.env.example')).toBe(true);
  });
});

describe('maskSecret', () => {
  it('保留首 4 + **** + 尾 4', () => {
    expect(maskSecret('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('sk-a****3456');
  });

  it('短串退化为 ****', () => {
    expect(maskSecret('abcd')).toBe('****');
  });
});
