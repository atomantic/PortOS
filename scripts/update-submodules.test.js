// test-memo: git-fixture
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { installUpdateContract, readUpdateLog, recordedSteps } from './lib/updateContractHarness.js';
import { SKIP_HEAVY_INTEGRATION } from '../server/lib/gitTestRepo.js';

const roots = [];
const windows = process.platform === 'win32';
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function git(cwd, env, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'portos-updater-submodules-'));
  roots.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [command, status] of [['npm', 0], ['pm2', 4], ['npx', 5]]) {
    const shim = join(bin, windows ? `${command}.cmd` : command);
    writeFileSync(shim, windows ? `@exit /b ${status}\r\n` : `#!/bin/sh\nexit ${status}\n`);
    chmodSync(shim, 0o755);
  }
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'empty-git-config') };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = [bin, env[pathKey]].filter(Boolean).join(delimiter);
  return { dir, env };
}

function commit({ env }, repo, message, modulePin) {
  git(repo, env, 'add', '-A');
  if (modulePin) git(repo, env, 'update-index', '--add', '--cacheinfo', `160000,${modulePin},module`);
  git(repo, env, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message);
  return git(repo, env, 'rev-parse', 'HEAD');
}

function init({ dir, env }, name) {
  const repo = join(dir, name);
  git(dir, env, 'init', '-b', 'main', repo);
  return repo;
}

function run({ env }, repo, { timeout = 30_000, automatic = true } = {}) {
  const childEnv = { ...env, PORTOS_DATA_ROOT: repo };
  delete childEnv.VITEST; // isolate the standalone install from Vitest's fixture write guard
  const args = automatic ? ['--automatic'] : [];
  const result = spawnSync(windows ? 'powershell' : 'bash', windows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'update.ps1'), ...args]
    : [join(repo, 'update.sh'), ...args],
  { cwd: repo, encoding: 'utf8', timeout, env: childEnv });
  if (result.error) {
    throw new Error(`${result.error.message}\n${result.stdout}${result.stderr}${readUpdateLog(repo)}`, { cause: result.error });
  }
  return result;
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('updater submodule and dirty-checkout behavior', () => {
  it('repairs a stale gitlink and lock before checking a clean tree, then syncs the new URL and pins the reviewed commit', () => {
    const fixture = sandbox();
    const { dir, env } = fixture;
    const module = init(fixture, 'module');
    const advanceModule = (repo, contents) => {
      writeFileSync(join(repo, 'module.txt'), contents);
      return commit(fixture, repo, contents);
    };
    const stale = advanceModule(module, 'stale');
    const originalPin = advanceModule(module, 'old parent pin');

    const parent = init(fixture, 'parent');
    installUpdateContract(parent);
    const gitmodules = join(parent, '.gitmodules');
    writeFileSync(gitmodules, '[submodule "module"]\n\tpath = module\n\turl = ../module\n');
    commit(fixture, parent, 'Initial parent', originalPin);
    const checkout = join(dir, 'checkout');
    git(dir, env, 'clone', parent, checkout);
    const localModule = join(checkout, 'module');
    // Set up the initialized gitlink directly so Windows only runs Git's
    // recursive submodule shell scripts during the updater under test.
    const moduleGitDir = join(checkout, '.git', 'modules', 'module');
    mkdirSync(join(checkout, '.git', 'modules'));
    git(checkout, env, 'clone', '--separate-git-dir', moduleGitDir, module, localModule);
    git(checkout, env, 'config', 'submodule.module.url', module);
    expect(git(localModule, env, 'rev-parse', 'HEAD')).toBe(originalPin);
    git(localModule, env, 'checkout', '--detach', stale);
    expect(git(checkout, env, 'status', '--porcelain')).not.toBe('');
    const staleLock = join(checkout, '.git', 'index.lock');
    writeFileSync(staleLock, '');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(staleLock, old, old);

    const replacement = join(dir, 'replacement');
    git(dir, env, 'clone', module, replacement);
    const newPin = advanceModule(replacement, 'new parent pin');
    const unreviewed = advanceModule(replacement, 'remote tip not pinned');
    writeFileSync(gitmodules, '[submodule "module"]\n\tpath = module\n\turl = ../replacement\n');
    const target = commit(fixture, parent, 'Switch module URL and pin', newPin);

    // Git for Windows fans out into several processes per submodule operation.
    const result = run(fixture, checkout, { timeout: windows ? 60_000 : 30_000 });
    expect(result.status, result.stdout + result.stderr + readUpdateLog(checkout)).toBe(19);
    expect(recordedSteps(result).filter(step => step !== 'waiting:running')).toEqual([
      'waiting:done', 'git-pull:running', 'git-pull:done',
      'submodules:running', 'submodules:done', 'runtime-preflight:running', 'runtime-preflight:done',
      'pm2-stop:running', 'pm2-stop:done', 'npm-install:running', 'restart:running', 'restart:error',
    ]);
    expect(existsSync(staleLock)).toBe(false);
    expect(git(checkout, env, 'rev-parse', 'HEAD')).toBe(target);
    expect(git(localModule, env, 'rev-parse', 'HEAD')).toBe(newPin);
    expect(git(localModule, env, 'rev-parse', 'HEAD')).not.toBe(unreviewed);
    expect(normalize(git(localModule, env, 'remote', 'get-url', 'origin'))).toBe(normalize(replacement));
  }, windows ? 90_000 : 45_000);

  it('restores the local commit before restarting after a pull conflict', () => {
    const fixture = sandbox();
    const { dir, env } = fixture;
    const parent = init(fixture, 'parent');
    installUpdateContract(parent);
    writeFileSync(join(parent, 'tracked'), 'base');
    writeFileSync(join(parent, 'scripts', 'verify-server-health.js'), 'process.exit(0);\n');
    commit(fixture, parent, 'Initial parent');

    const checkout = join(dir, 'checkout');
    git(dir, env, 'clone', parent, checkout);
    writeFileSync(join(checkout, 'tracked'), 'local edit');
    const local = commit(fixture, checkout, 'Local update');
    writeFileSync(join(parent, 'tracked'), 'remote edit');
    commit(fixture, parent, 'Upstream update');
    git(checkout, env, 'config', 'user.name', 'Fixture');
    git(checkout, env, 'config', 'user.email', 'fixture@example.invalid');

    const pm2 = join(checkout, 'server', 'node_modules', 'pm2', 'bin', 'pm2');
    mkdirSync(join(pm2, '..'), { recursive: true });
    writeFileSync(pm2, `
      const { execFileSync } = require('node:child_process');
      if (process.argv[2] === 'start') {
        const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
        if (git('rev-parse', 'HEAD') !== ${JSON.stringify(local)} || git('status', '--porcelain')) process.exit(6);
      }
    `);

    const result = run(fixture, checkout, { automatic: false });
    expect(result.status, result.stdout + result.stderr + readUpdateLog(checkout)).not.toBe(0);
    expect(result.stdout).toContain('STEP:git-pull:failed:Pull conflicted; rebase aborted and checkout restored');
    expect(recordedSteps(result)).toContain('restart:warning');
    expect(git(checkout, env, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(checkout, env, 'rev-parse', 'HEAD')).toBe(local);
    expect(git(checkout, env, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(checkout, '.git', 'REBASE_HEAD'))).toBe(false);
  }, 45_000);

  it('refuses a dirty working tree without stashing or advancing it', () => {
    const fixture = sandbox();
    const { dir, env } = fixture;
    const parent = init(fixture, 'parent');
    installUpdateContract(parent);
    writeFileSync(join(parent, 'tracked'), 'base');
    const initial = commit(fixture, parent, 'Initial parent');
    const checkout = join(dir, 'checkout');
    git(dir, env, 'clone', parent, checkout);
    writeFileSync(join(checkout, 'tracked'), 'local edit');
    writeFileSync(join(parent, 'tracked'), 'remote edit');
    commit(fixture, parent, 'Upstream update');
    const result = run(fixture, checkout);
    expect(result.status, result.stdout + result.stderr + readUpdateLog(checkout)).toBe(1);
    expect(result.stdout, readUpdateLog(checkout)).toContain('Checkout is dirty; no stash was created');
    expect(git(checkout, env, 'rev-parse', 'HEAD')).toBe(initial);
    expect(git(checkout, env, 'diff', '--name-only')).toBe('tracked');
    expect(git(checkout, env, 'stash', 'list')).toBe('');
  }, 45_000);
});
