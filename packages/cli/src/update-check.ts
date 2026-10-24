/**
 * CLI 更新检查：直接读取 npm registry packument，不启动 npm 子进程。
 *
 * 自动检查由调用方保证只在交互模式触发；网络/认证/缓存错误通过结构化结果
 * 返回，启动路径可静默忽略，`/update` 则向用户显示。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const UPDATE_PACKAGE = '@shenlan/cli';
export const UPDATE_COMMAND = 'npm install -g @shenlan/cli@latest';
export const UNCONFIGURED_UPDATE_MESSAGE = 'No npm registry is configured for @shenlan/cli. Use the GitHub source checkout for updates until public npm release.';
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 3_000;

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
  registry: string;
}

export type UpdateCheckResult =
  | {
      status: 'update' | 'current';
      currentVersion: string;
      latestVersion: string;
      command: string;
      fromCache: boolean;
    }
  | {
      status: 'error';
      currentVersion: string;
      error: string;
    }
  | {
      status: 'unavailable';
      currentVersion: string;
    };

export interface UpdateCheckOptions {
  force?: boolean;
  now?: number;
  registry?: string;
  cacheDir?: string;
  npmrcPaths?: string[];
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export interface AutomaticUpdateCheckOptions {
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

/** 自动检查开关：仅交互 TTY，CI 与两个常见关闭变量均跳过。 */
export function shouldRunAutomaticUpdateCheck(
  options: AutomaticUpdateCheckOptions = {},
): boolean {
  const env = options.env ?? process.env;
  if (options.enabled === false) return false;
  if (isTruthy(env.CI)) return false;
  if (isTruthy(env.SHENLAN_NO_UPDATE_CHECK)) return false;
  if (isTruthy(env.NO_UPDATE_NOTIFIER)) return false;
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  return stdinIsTTY && stdoutIsTTY;
}

/** 查询最新版；成功响应写入 24 小时缓存，失败不覆盖已有缓存。 */
export async function checkForUpdate(
  currentVersion: string,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const settings = readNpmSettings(options.npmrcPaths ?? defaultNpmrcPaths(env), env);
  const configuredRegistry = options.registry ?? settings['@shenlan:registry'];
  if (!configuredRegistry) return { status: 'unavailable', currentVersion };
  const registry = normalizeRegistry(configuredRegistry);
  const cacheFile = join(
    options.cacheDir ?? env.SHENLAN_CONFIG_DIR ?? join(homedir(), '.shenlan'),
    'update-check.json',
  );

  if (!parseSemver(currentVersion)) {
    return { status: 'error', currentVersion, error: `invalid current version: ${currentVersion}` };
  }

  if (!options.force) {
    const cached = readCache(cacheFile);
    if (
      cached
      && cached.registry === registry
      && now - cached.checkedAt >= 0
      && now - cached.checkedAt < UPDATE_CACHE_TTL_MS
      && parseSemver(cached.latestVersion)
    ) {
      return successfulResult(currentVersion, cached.latestVersion, true);
    }
  }

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.npm.install-v1+json, application/json',
      'User-Agent': `shenlan/${currentVersion}`,
    };
    const authCredential = resolveAuthToken(registry, settings, env);
    if (authCredential) headers.Authorization = `Bearer ${authCredential}`;

    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(
      `${registry}${UPDATE_PACKAGE.replace('/', '%2F')}`,
      { headers, signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
    const body = await response.json() as { 'dist-tags'?: { latest?: unknown } };
    const latest = body['dist-tags']?.latest;
    if (typeof latest !== 'string' || !parseSemver(latest)) {
      throw new Error('registry response has no valid dist-tags.latest');
    }
    writeCache(cacheFile, { checkedAt: now, latestVersion: latest, registry });
    return successfulResult(currentVersion, latest, false);
  } catch (error) {
    return {
      status: 'error',
      currentVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 启动提示与 `/update` 共用，不执行自更新。 */
export function formatUpdateResult(result: UpdateCheckResult): string {
  if (result.status === 'unavailable') return UNCONFIGURED_UPDATE_MESSAGE;
  if (result.status === 'error') {
    return `Update check failed: ${result.error}`;
  }
  if (result.status === 'update') {
    return `✨ Update available: ${result.currentVersion} → ${result.latestVersion}\nRun: ${result.command}`;
  }
  return `shenlan v${result.currentVersion} is up to date.`;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** SemVer 比较（含 prerelease，build metadata 不参与优先级）。 */
export function compareSemver(a: string, b: string): number {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) throw new Error(`invalid semver comparison: ${a} / ${b}`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (av[key] !== bv[key]) return av[key] > bv[key] ? 1 : -1;
  }
  if (av.prerelease.length === 0 && bv.prerelease.length === 0) return 0;
  if (av.prerelease.length === 0) return 1;
  if (bv.prerelease.length === 0) return -1;
  const count = Math.max(av.prerelease.length, bv.prerelease.length);
  for (let i = 0; i < count; i++) {
    const ai = av.prerelease[i];
    const bi = bv.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(ai) > Number(bi) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ai > bi ? 1 : -1;
  }
  return 0;
}

function parseSemver(version: string): Semver | null {
  const match = version.trim().match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function successfulResult(
  currentVersion: string,
  latestVersion: string,
  fromCache: boolean,
): UpdateCheckResult {
  return {
    status: compareSemver(latestVersion, currentVersion) > 0 ? 'update' : 'current',
    currentVersion,
    latestVersion,
    command: UPDATE_COMMAND,
    fromCache,
  };
}

function normalizeRegistry(registry: string): string {
  return `${registry.trim().replace(/\/+$/, '')}/`;
}

function defaultNpmrcPaths(env: NodeJS.ProcessEnv): string[] {
  const userConfig = env.npm_config_userconfig || join(homedir(), '.npmrc');
  return [userConfig, join(process.cwd(), '.npmrc')];
}

function readNpmSettings(paths: string[], env: NodeJS.ProcessEnv): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const equals = line.indexOf('=');
        if (equals <= 0) continue;
        const key = line.slice(0, equals).trim();
        const rawValue = line.slice(equals + 1).trim();
        const value = (
          (rawValue.startsWith('"') && rawValue.endsWith('"'))
          || (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ) ? rawValue.slice(1, -1) : rawValue;
        settings[key] = expandEnv(value, env);
      }
    } catch { /* unreadable npmrc: continue without auth */ }
  }
  return settings;
}

function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? '');
}

function resolveAuthToken(
  registry: string,
  settings: Record<string, string>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (env.NODE_AUTH_TOKEN) return env.NODE_AUTH_TOKEN;
  const registryUrl = new URL(registry);
  const registryKey = `//${registryUrl.host}${registryUrl.pathname}`;
  let best: { prefixLength: number; token: string } | undefined;
  for (const [key, token] of Object.entries(settings)) {
    if (!key.endsWith(':_authToken') || !token) continue;
    const prefix = key.slice(0, -':_authToken'.length);
    if (registryKey.startsWith(prefix) && (!best || prefix.length > best.prefixLength)) {
      best = { prefixLength: prefix.length, token };
    }
  }
  return best?.token ?? settings._authToken;
}

function readCache(file: string): UpdateCache | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateCache>;
    if (
      typeof value.checkedAt !== 'number'
      || typeof value.latestVersion !== 'string'
      || typeof value.registry !== 'string'
    ) return null;
    return value as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(file: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
  } catch { /* cache failure must not affect update checking */ }
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes)$/i.test(value.trim());
}
