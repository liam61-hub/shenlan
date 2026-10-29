#!/usr/bin/env node
/**
 * 公开发布前的只读打包审计。
 *
 * 当前仍使用私有 registry，许可策略也尚未拍板：运行完整性与敏感文件命名
 * 属于硬门禁；源码、测试、source map、许可和 registry 只报告为公开发布阻断项。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { maskSecret, scanForSecrets } from '../packages/core/dist/security-scan.js';

const packages = [
  {
    workspace: '@shenlan/core',
    dir: 'packages/core',
    required: ['dist/index.js', 'dist/index.d.ts', 'package.json'],
  },
  {
    workspace: '@shenlan/cli',
    dir: 'packages/cli',
    required: [
      'bin/shenlan.js',
      'dist/index.js',
      'package.json',
      'builtin-skills/create-skill/SKILL.md',
    ],
  },
];

const forbiddenPathPatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)config\.json$/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /\.log$/i,
  /(^|\/)\.npmrc$/i,
];

function packDryRun(workspace, cacheDir) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is missing; run this audit through "npm run release:audit"');
  }
  const npmArgs = ['pack', '--dry-run', '--json', '--ignore-scripts', '--workspace', workspace];
  const result = spawnSync(
    process.execPath,
    [npmCli, ...npmArgs],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: { ...process.env, npm_config_cache: cacheDir },
    },
  );
  if (result.status !== 0) {
    const detail = result.error?.stack || result.stderr || result.stdout || `exit status ${String(result.status)}`;
    throw new Error(`${workspace} npm pack dry-run failed:\n${detail}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
    throw new Error(`${workspace} returned an unexpected npm pack JSON shape`);
  }
  return parsed[0];
}

function packWorkspace(workspace, outputDir, cacheDir) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is missing; run this audit through "npm run release:audit"');
  }
  const result = spawnSync(
    process.execPath,
    [npmCli, 'pack', '--json', '--ignore-scripts', '--workspace', workspace, '--pack-destination', outputDir],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: { ...process.env, npm_config_cache: cacheDir },
    },
  );
  if (result.status !== 0) {
    const detail = result.error?.stack || result.stderr || result.stdout || `exit status ${String(result.status)}`;
    throw new Error(`${workspace} npm pack failed:\n${detail}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0].filename !== 'string') {
    throw new Error(`${workspace} returned an unexpected npm pack JSON shape`);
  }
  return join(outputDir, parsed[0].filename);
}

function verifyIsolatedInstall(tarballs, installDir, cacheDir) {
  const npmCli = process.env.npm_execpath;
  const install = spawnSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--prefix', installDir,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
      ...tarballs,
    ],
    {
      cwd: installDir,
      encoding: 'utf-8',
      env: { ...process.env, npm_config_cache: cacheDir },
    },
  );
  if (install.status !== 0) {
    const detail = install.error?.stack || install.stderr || install.stdout || `exit status ${String(install.status)}`;
    throw new Error(`isolated tarball installation failed:\n${detail}`);
  }

  const consumerCli = join(installDir, 'node_modules', '@shenlan', 'cli', 'bin', 'shenlan.js');
  for (const args of [[consumerCli, '--version'], [consumerCli, '--help']]) {
    const result = spawnSync(process.execPath, args, { cwd: installDir, encoding: 'utf-8' });
    if (result.status !== 0 || !result.stdout.trim()) {
      const detail = result.error?.stack || result.stderr || `exit status ${String(result.status)}`;
      throw new Error(`isolated CLI ${args[1]} check failed:\n${detail}`);
    }
  }

  const coreImport = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('@shenlan/core')"],
    { cwd: installDir, encoding: 'utf-8' },
  );
  if (coreImport.status !== 0) {
    const detail = coreImport.error?.stack || coreImport.stderr || `exit status ${String(coreImport.status)}`;
    throw new Error(`isolated @shenlan/core import failed:\n${detail}`);
  }
}

function verifyVersionConsistency() {
  const rootManifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
  const coreManifest = JSON.parse(readFileSync(join(process.cwd(), 'packages/core/package.json'), 'utf-8'));
  const cliManifest = JSON.parse(readFileSync(join(process.cwd(), 'packages/cli/package.json'), 'utf-8'));
  const versionSource = readFileSync(join(process.cwd(), 'packages/cli/src/version.ts'), 'utf-8');
  const runtimeVersion = versionSource.match(/export const VERSION = ['"]([^'"]+)['"]/)?.[1];
  const versions = [rootManifest.version, coreManifest.version, cliManifest.version, runtimeVersion];
  if (versions.some((version) => typeof version !== 'string') || new Set(versions).size !== 1) {
    throw new Error(`Version mismatch across root/core/cli/runtime: ${versions.join(', ')}`);
  }
  if (cliManifest.dependencies?.['@shenlan/core'] !== coreManifest.version) {
    throw new Error(`@shenlan/cli core dependency does not match @shenlan/core ${coreManifest.version}`);
  }
  console.log(`PASS root/core/cli/runtime version is ${rootManifest.version}`);
}

function count(paths, predicate) {
  return paths.filter(predicate).length;
}

function isTestPath(path) {
  return path.includes('/__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(path);
}

function scanPackedRuntimeFiles(packageDir, paths) {
  const hits = [];
  const textExtensions = /\.(?:[cm]?[jt]sx?|json|md)$/i;
  for (const path of paths) {
    // 测试与 source map 已作为公开发布阻断项；其中含密钥检测的刻意假样本，
    // 此处只对真正会运行或面向用户的文本做硬扫描，避免测试夹具误报。
    if (isTestPath(path) || path.endsWith('.map') || !textExtensions.test(path)) continue;
    const content = readFileSync(join(process.cwd(), packageDir, path), 'utf-8');
    if (content.includes('\0')) continue;
    // 通用赋值规则会把 apiKey=process.env... 等代码表达式误判为密钥；这里保留
    // sk-/AWS/GitHub/Bearer 等高置信规则，并另行只扫描引号内的长字面量。
    hits.push(...scanForSecrets(content, path).filter((hit) => !hit.rule.startsWith('疑似密钥赋值')));
    for (const [index, line] of content.split('\n').entries()) {
      const literal = line.match(/\b(api[_-]?key|secret|token|password)\s*[:=]\s*(['"])([^'"\r\n]{16,})\2/i);
      if (!literal) continue;
      const value = literal[3].trim();
      if (/^(?:your[-_ ]|example|placeholder|在这里|请填写|sk-x+$)/i.test(value)) continue;
      hits.push({
        file: path,
        line: index + 1,
        rule: '硬编码的长密钥字面量',
        matched: `${literal[1]}=${maskSecret(value)}`,
      });
    }
  }
  return hits;
}

const cacheDir = mkdtempSync(join(tmpdir(), 'shenlan-release-audit-'));
const tarballDir = join(cacheDir, 'tarballs');
const installDir = join(cacheDir, 'consumer');
let hardFailures = 0;
let blockers = 0;

try {
  verifyVersionConsistency();
  mkdirSync(tarballDir);
  mkdirSync(installDir);
  const tarballs = packages.map((pkg) => packWorkspace(pkg.workspace, tarballDir, cacheDir));
  verifyIsolatedInstall(tarballs, installDir, cacheDir);
  console.log('\nPASS packed workspaces install without workspace links; CLI and core entry points load');

  for (const pkg of packages) {
    const packed = packDryRun(pkg.workspace, cacheDir);
    const paths = packed.files.map((file) => file.path.replaceAll('\\', '/'));
    const missing = pkg.required.filter((path) => !paths.includes(path));
    const forbidden = paths.filter((path) => forbiddenPathPatterns.some((pattern) => pattern.test(path)));
    const secretHits = scanPackedRuntimeFiles(pkg.dir, paths);
    const sourceCount = count(paths, (path) => path.startsWith('src/'));
    const testCount = count(paths, isTestPath);
    const sourceMapCount = count(paths, (path) => path.endsWith('.map'));
    const hasLicense = paths.some((path) => /(^|\/)licen[cs]e(?:\.|$)/i.test(path));
    const manifest = JSON.parse(readFileSync(join(process.cwd(), pkg.dir, 'package.json'), 'utf-8'));
    const usesPrivateRegistry = String(manifest.publishConfig?.registry ?? '').includes('packages.aliyun.com');

    console.log(`\n${packed.id}`);
    console.log(`  tarball: ${packed.entryCount} files, ${packed.size} packed bytes, ${packed.unpackedSize} unpacked bytes`);

    if (missing.length > 0) {
      hardFailures += 1;
      console.error(`  FAIL missing runtime files: ${missing.join(', ')}`);
    } else {
      console.log('  PASS required runtime files are present');
    }
    if (forbidden.length > 0) {
      hardFailures += 1;
      console.error(`  FAIL sensitive file names: ${forbidden.join(', ')}`);
    } else {
      console.log('  PASS no sensitive file names detected');
    }
    if (secretHits.length > 0) {
      hardFailures += 1;
      console.error('  FAIL potential secrets in packed runtime files:');
      for (const hit of secretHits.slice(0, 10)) {
        console.error(`    ${hit.file}:${hit.line} ${hit.rule} (${hit.matched})`);
      }
      if (secretHits.length > 10) console.error(`    ... and ${secretHits.length - 10} more`);
    } else {
      console.log('  PASS no potential secrets detected in packed runtime files');
    }

    const publicBlockers = [
      sourceCount > 0 && `${sourceCount} source files`,
      testCount > 0 && `${testCount} test files`,
      sourceMapCount > 0 && `${sourceMapCount} source maps`,
      !hasLicense && 'no LICENSE file in tarball',
      !manifest.license && 'package.json has no license metadata',
      !manifest.description && 'package.json has no description',
      !manifest.homepage && 'package.json has no homepage',
      !Array.isArray(manifest.keywords) || manifest.keywords.length === 0 ? 'package.json has no keywords' : false,
      usesPrivateRegistry && 'publishConfig still targets the private registry',
    ].filter(Boolean);
    blockers += publicBlockers.length;
    for (const blocker of publicBlockers) console.warn(`  BLOCKED(public): ${blocker}`);
  }
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

if (hardFailures > 0) {
  console.error(`\nRelease audit failed with ${hardFailures} hard failure(s).`);
  process.exit(1);
}

console.log(`\nRelease audit passed safety/runtime checks; ${blockers} public-release blocker(s) remain.`);
