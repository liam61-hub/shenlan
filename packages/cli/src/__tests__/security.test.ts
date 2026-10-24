import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  runSecurityCommand,
  installPreCommitHook,
  hookStatus,
  uninstallPreCommitHook,
  scanStaged,
  trackedSensitiveFiles,
  PRE_COMMIT_MARKER,
} from '../security.js';

function initRepo(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
}

describe('pre-commit 钩子安装/卸载', () => {
  let repo: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'shenlan-sec-'));
    initRepo(repo);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('install 写入带标记的钩子并授权执行', () => {
    const r = installPreCommitHook(repo);
    expect(r.installed).toBe(true);
    const content = readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(content).toContain(PRE_COMMIT_MARKER);
    expect(content).toContain('security scan --staged');
  });

  it('install 幂等：再次安装为重装（不报错），钩子仍为本产品', () => {
    installPreCommitHook(repo);
    const second = installPreCommitHook(repo);
    expect(second.installed).toBe(true);
    expect(second.overwritten).toBe(true);
    expect(hookStatus(repo).ours).toBe(true);
  });

  it('已有非本产品钩子不覆盖', () => {
    const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "my custom hook"\n', { encoding: 'utf-8' });
    const r = installPreCommitHook(repo);
    expect(r.installed).toBe(false);
    expect(r.reason).toBe('existing-hook');
    expect(readFileSync(hookPath, 'utf-8')).toContain('my custom hook');
  });

  it('uninstall 只删除本产品钩子，他人钩子不动', () => {
    installPreCommitHook(repo);
    const r = uninstallPreCommitHook(repo, { silent: true });
    expect(r.removed).toBe(true);
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);

    const foreign = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(foreign, '#!/bin/sh\necho foreign\n');
    const r2 = uninstallPreCommitHook(repo, { silent: true });
    expect(r2.removed).toBe(false);
    expect(r2.reason).toBe('not-ours');
    expect(readFileSync(foreign, 'utf-8')).toContain('foreign');
  });

  it('trackedSensitiveFiles 报告已跟踪的 .env', () => {
    writeFileSync(join(repo, '.env'), 'SECRET=x\n');
    execSync('git add .env', { cwd: repo });
    expect(trackedSensitiveFiles(repo)).toEqual(['.env']);
  });
});

describe('runSecurityCommand — scan --staged', () => {
  let repo: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'shenlan-scan-'));
    initRepo(repo);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('暂存含疑似 key 的文件 → 输出命中并 exit 1', async () => {
    writeFileSync(join(repo, 'app.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\n');
    execSync('git add app.ts', { cwd: repo });
    const code = await runSecurityCommand(['scan', '--staged']);
    expect(code).toBe(1);
  });

  it('暂存无密钥 → exit 0', async () => {
    writeFileSync(join(repo, 'ok.ts'), 'const x = 1;\n');
    execSync('git add ok.ts', { cwd: repo });
    const code = await runSecurityCommand(['scan', '--staged']);
    expect(code).toBe(0);
  });

  it('scan --path 命中 → exit 1，未命中 → exit 0', async () => {
    writeFileSync(join(repo, 'bad.env.ts'), 'api_key = "supersecretvalue123456"\n');
    expect(await runSecurityCommand(['scan', '--path', 'bad.env.ts'])).toBe(1);
    writeFileSync(join(repo, 'good.ts'), 'const y = 2;\n');
    expect(await runSecurityCommand(['scan', '--path', 'good.ts'])).toBe(0);
  });

  it('暂存删除的文件跳过扫描，exit 0', async () => {
    writeFileSync(join(repo, 'gone.ts'), 'sk-abcdefghijklmnopqrstuvwxyz123456\n');
    execSync('git add gone.ts', { cwd: repo });
    // 删除后仍暂存（staged deletion）
    execSync('git rm -q --cached gone.ts', { cwd: repo });
    const code = await runSecurityCommand(['scan', '--staged']);
    expect(code).toBe(0);
  });

  it('scanStaged 跳过二进制（含 NUL）', () => {
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    execSync('git add blob.bin', { cwd: repo });
    const r = scanStaged(repo);
    expect(r.hits).toEqual([]);
  });
});

// 提交时检查只该拦「这次带进来的行」：整文件扫描会让历史夹具永久卡住提交
describe('scanStaged — 只扫本次新增行', () => {
  // 夹具拼接构造：写字面量会让本文件自己的新增行触发扫描器
  const SECRET = `sk-${'a'.repeat(28)}`;
  const FIXTURE = `const key = "${SECRET}";`;
  let repo: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  const commit = (msg: string) => execSync(`git commit -q -m "${msg}"`, { cwd: repo });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'shenlan-addlines-'));
    initRepo(repo);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('历史内容里的疑似密钥不再拦截', () => {
    writeFileSync(join(repo, 'legacy.ts'), `${FIXTURE}\n`);
    execSync('git add legacy.ts', { cwd: repo });
    commit('legacy');
    // 本次只追加一行普通代码，夹具那行属于历史
    writeFileSync(join(repo, 'legacy.ts'), `${FIXTURE}\nconst x = 1;\n`);
    execSync('git add legacy.ts', { cwd: repo });
    expect(scanStaged(repo).hits).toEqual([]);
  });

  it('本次追加行含疑似密钥 → 命中且行号正确', () => {
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\n');
    execSync('git add app.ts', { cwd: repo });
    commit('app');
    writeFileSync(join(repo, 'app.ts'), `const a = 1;\nconst b = 2;\n${FIXTURE}\n`);
    execSync('git add app.ts', { cwd: repo });
    const hits = scanStaged(repo).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });

  it('改写已有行引入密钥 → 命中该新行', () => {
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\nconst b = 2;\n');
    execSync('git add app.ts', { cwd: repo });
    commit('app');
    writeFileSync(join(repo, 'app.ts'), `const a = 1;\nconst b = "${SECRET}";\n`);
    execSync('git add app.ts', { cwd: repo });
    const hits = scanStaged(repo).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  it('新增文件（无历史）→ 全量新增仍然拦截', () => {
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\n');
    execSync('git add app.ts', { cwd: repo });
    commit('app');
    writeFileSync(join(repo, 'fresh.ts'), `${FIXTURE}\n`);
    execSync('git add fresh.ts', { cwd: repo });
    const hits = scanStaged(repo).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('fresh.ts');
  });

  it('硬禁止路径不因行过滤被放过（内容无命中仍拦）', () => {
    writeFileSync(join(repo, 'app.ts'), 'const a = 1;\n');
    execSync('git add app.ts', { cwd: repo });
    commit('app');
    writeFileSync(join(repo, '.env'), 'DEEPSEEK_API_KEY=placeholder\n');
    execSync('git add .env', { cwd: repo });
    const hits = scanStaged(repo).hits;
    expect(hits.map((h) => h.rule)).toEqual(['blocked-path']);
  });
});
