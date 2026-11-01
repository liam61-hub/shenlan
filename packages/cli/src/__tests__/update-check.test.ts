import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UPDATE_CACHE_TTL_MS,
  checkForUpdate,
  compareSemver,
  formatUpdateResult,
  shouldRunAutomaticUpdateCheck,
} from '../update-check.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shenlan-update-check-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('compareSemver', () => {
  it('比较 major/minor/patch、prerelease 与 build metadata', () => {
    expect(compareSemver('0.4.88', '0.4.87')).toBe(1);
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('v1.2.3+build.9', '1.2.3+build.1')).toBe(0);
  });
});

describe('shouldRunAutomaticUpdateCheck', () => {
  it('只允许未关闭的交互 TTY，CI 和标准关闭变量跳过', () => {
    expect(shouldRunAutomaticUpdateCheck({ env: {}, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(shouldRunAutomaticUpdateCheck({ enabled: false, env: {}, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(shouldRunAutomaticUpdateCheck({ env: { CI: 'true' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(shouldRunAutomaticUpdateCheck({ env: { SHENLAN_NO_UPDATE_CHECK: '1' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(shouldRunAutomaticUpdateCheck({ env: { NO_UPDATE_NOTIFIER: 'true' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(shouldRunAutomaticUpdateCheck({ env: {}, stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('读取私有 registry 最新版本与 npmrc token，但结果/缓存不泄露 token', async () => {
    const dir = makeTempDir();
    const npmrc = join(dir, '.npmrc');
    writeFileSync(npmrc, [
      '@shenlan:registry=https://registry.example/private/',
      '//registry.example/private/:_authToken=${TEST_NPM_TOKEN}',
    ].join('\n'));
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://registry.example/private/@shenlan%2Fcli');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-for-test');
      return new Response(JSON.stringify({ 'dist-tags': { latest: '0.4.88' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await checkForUpdate('0.4.87', {
      cacheDir: dir,
      npmrcPaths: [npmrc],
      env: { TEST_NPM_TOKEN: 'token-for-test' },
      fetchFn,
      now: 1_000,
    });

    expect(result).toMatchObject({
      status: 'update', currentVersion: '0.4.87', latestVersion: '0.4.88', fromCache: false,
    });
    expect(formatUpdateResult(result)).toContain('npm install -g @shenlan/cli@latest');
    expect(JSON.stringify(result)).not.toContain('token-for-test');
    expect(readFileSync(join(dir, 'update-check.json'), 'utf8')).not.toContain('token-for-test');
  });

  it('24 小时内命中缓存且不联网，过期后重新请求', async () => {
    const dir = makeTempDir();
    const fetchFn = vi.fn(async () => (
      new Response(JSON.stringify({ 'dist-tags': { latest: '0.4.88' } }), { status: 200 })
    )) as unknown as typeof fetch;
    const options = {
      cacheDir: dir,
      npmrcPaths: [] as string[],
      env: {},
      registry: 'https://registry.example/',
      fetchFn,
    };

    await checkForUpdate('0.4.87', { ...options, now: 10_000 });
    const cached = await checkForUpdate('0.4.87', { ...options, now: 10_000 + UPDATE_CACHE_TTL_MS - 1 });
    const refreshed = await checkForUpdate('0.4.87', { ...options, now: 10_000 + UPDATE_CACHE_TTL_MS });

    expect(cached).toMatchObject({ status: 'update', fromCache: true });
    expect(refreshed).toMatchObject({ status: 'update', fromCache: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('最新版不高于当前版本时不提示降级', async () => {
    const dir = makeTempDir();
    const fetchFn = vi.fn(async () => (
      new Response(JSON.stringify({ 'dist-tags': { latest: '0.4.87' } }), { status: 200 })
    )) as unknown as typeof fetch;
    const result = await checkForUpdate('0.4.88', {
      cacheDir: dir,
      npmrcPaths: [],
      env: {},
      registry: 'https://registry.example/',
      fetchFn,
    });

    expect(result.status).toBe('current');
    expect(formatUpdateResult(result)).toContain('up to date');
  });

  it('registry 失败返回可展示错误且不抛异常', async () => {
    const dir = makeTempDir();
    const result = await checkForUpdate('0.4.87', {
      cacheDir: dir,
      npmrcPaths: [],
      env: {},
      registry: 'https://registry.example/',
      fetchFn: vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: 'error', currentVersion: '0.4.87', error: 'registry HTTP 401' });
  });
});
