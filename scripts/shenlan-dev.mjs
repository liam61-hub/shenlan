import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['packages/core/src', 'packages/cli/src'];
const buildInputs = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/cli/package.json',
  'packages/cli/tsconfig.json',
  'node_modules/typescript/package.json',
];

function collectFiles(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(path, output);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) output.push(path);
  }
  return output;
}

function buildSignature() {
  const files = [
    ...buildInputs.map(path => join(repoDir, path)).filter(existsSync),
    ...sourceRoots.flatMap(root => collectFiles(join(repoDir, root))),
  ].sort();
  return files.map(path => {
    const stat = statSync(path);
    return `${relative(repoDir, path)}:${stat.size}:${stat.mtimeMs}`;
  }).join('\n');
}

function outputsExist() {
  return sourceRoots.every(root => {
    const sourceDir = join(repoDir, root);
    const distDir = join(repoDir, root.replace(/src$/, 'dist'));
    return collectFiles(sourceDir).every(source => {
      const output = join(distDir, relative(sourceDir, source).replace(/\.tsx?$/, '.js'));
      return existsSync(output);
    });
  });
}

const cacheFile = join(repoDir, 'node_modules', '.cache', 'shenlan-dev-build-signature');
const signature = buildSignature();
let previousSignature = '';
try {
  previousSignature = readFileSync(cacheFile, 'utf8');
} catch {
  // A missing cache means the development build must be checked once.
}

if (previousSignature !== signature || !outputsExist()) {
  const tsc = join(repoDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const build = spawnSync(process.execPath, [tsc, '-b', 'packages/core', 'packages/cli'], {
    cwd: repoDir,
    stdio: 'inherit',
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, signature, 'utf8');
}

const cli = join(repoDir, 'packages', 'cli', 'dist', 'index.js');
process.argv = [process.execPath, cli, ...process.argv.slice(2)];
await import(pathToFileURL(cli).href);
