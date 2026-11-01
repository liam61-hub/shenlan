import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
let previousDebug: string | undefined;
let previousLogDir: string | undefined;
let previousArgv: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'shenlan-debug-'));
  previousDebug = process.env.SHENLAN_DEBUG;
  previousLogDir = process.env.SHENLAN_DEBUG_LOG_DIR;
  previousArgv = process.argv;
  process.env.SHENLAN_DEBUG_LOG_DIR = tempDir;
  process.argv = [...process.argv, 'private-argv-marker'];
  vi.resetModules();
});

afterEach(() => {
  if (previousDebug === undefined) delete process.env.SHENLAN_DEBUG;
  else process.env.SHENLAN_DEBUG = previousDebug;
  if (previousLogDir === undefined) delete process.env.SHENLAN_DEBUG_LOG_DIR;
  else process.env.SHENLAN_DEBUG_LOG_DIR = previousLogDir;
  process.argv = previousArgv;
  vi.resetModules();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('debug logger opt-in', () => {
  it('does not create a log by default', async () => {
    delete process.env.SHENLAN_DEBUG;
    const { debugLog } = await import('../debug-logger.js');
    debugLog('test event', { status: 'ok' });

    expect(existsSync(join(tempDir, '.shenlan'))).toBe(false);
  });

  it('writes explicit diagnostics without startup cwd or argv values', async () => {
    process.env.SHENLAN_DEBUG = '1';
    const { debugLog } = await import('../debug-logger.js');
    debugLog('test event', { status: 'ok', round: 2 });

    const file = join(tempDir, '.shenlan', `debug-${new Date().toISOString().slice(0, 10)}.log`);
    const log = readFileSync(file, 'utf-8');
    expect(log).toContain('=== shenlan started');
    expect(log).toContain('=== test event');
    expect(log).toContain('status: [string length=2]');
    expect(log).toContain('round: 2');
    expect(log).not.toContain('private-argv-marker');
    expect(log).not.toContain(`cwd: ${process.cwd()}`);
  });

  it('stores metadata only and redacts credentials and message bodies', async () => {
    process.env.SHENLAN_DEBUG = '1';
    const { debugLog } = await import('../debug-logger.js');
    debugLog('request', {
      prompt: 'private prompt marker',
      authorization: 'Bearer secret-token-marker',
      message: { content: 'private nested marker' },
      responseLen: 42,
      model: 'private model marker',
    });

    const file = join(tempDir, '.shenlan', `debug-${new Date().toISOString().slice(0, 10)}.log`);
    const log = readFileSync(file, 'utf-8');
    expect(log).toContain('prompt: [REDACTED]');
    expect(log).toContain('authorization: [REDACTED]');
    expect(log).toContain('message: [REDACTED]');
    expect(log).toContain('responseLen: 42');
    expect(log).toContain('model: [string length=20]');
    expect(log).not.toContain('private prompt marker');
    expect(log).not.toContain('secret-token-marker');
    expect(log).not.toContain('private nested marker');
    expect(log).not.toContain('private model marker');
  });

  it('removes debug logs older than seven days at startup', async () => {
    process.env.SHENLAN_DEBUG = '1';
    const logDir = join(tempDir, '.shenlan');
    const oldLog = join(logDir, 'debug-2020-01-01.log');
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(logDir);
    writeFileSync(oldLog, 'old diagnostic');
    utimesSync(oldLog, oldTime, oldTime);

    await import('../debug-logger.js');

    expect(existsSync(oldLog)).toBe(false);
  });

  it('keeps the daily log within its 256 KiB capacity', async () => {
    process.env.SHENLAN_DEBUG = '1';
    const { debugLog } = await import('../debug-logger.js');
    const fields = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field-${i}-${'x'.repeat(90)}`, i]));
    for (let i = 0; i < 100; i++) debugLog('capacity check', fields);

    const file = join(tempDir, '.shenlan', `debug-${new Date().toISOString().slice(0, 10)}.log`);
    expect(statSync(file).size).toBeLessThanOrEqual(256 * 1024);
  });

  it('restricts the log directory and file to the owner on POSIX', async () => {
    if (process.platform === 'win32') return;
    process.env.SHENLAN_DEBUG = '1';
    const { debugLog } = await import('../debug-logger.js');
    debugLog('permissions', {});

    const logDir = join(tempDir, '.shenlan');
    const file = join(logDir, `debug-${new Date().toISOString().slice(0, 10)}.log`);
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
