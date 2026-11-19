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
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (repo, message) => {
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const init = name => { const repo = join(dir, name); git(dir, 'init', '-b', 'main', repo); return repo; };
  const run = repo => {
    const childEnv = { ...env, PORTOS_DATA_ROOT: repo };
    delete childEnv.VITEST; // isolate the standalone install from Vitest's fixture write guard
    const result = spawnSync(windows ? 'powershell' : 'bash', windows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'update.ps1'), '--automatic']
      : [join(repo, 'update.sh'), '--automatic'],
    { cwd: repo, encoding: 'utf8', timeout: 30_000, env: childEnv });
    if (result.error) throw result.error;
    return result;
  };
  return { dir, git, commit, init, run };
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('updater submodule and dirty-checkout behavior', () => {
  it('repairs a stale gitlink and lock before checking a clean tree, then syncs the new URL and pins the reviewed commit', () => {
    const { dir, git, commit, init, run } = sandbox();
    const module = init('module');
    const moduleFile = join(module, 'module.txt');
    const advanceModule = contents => { writeFileSync(moduleFile, contents); return commit(module, contents); };
    const stale = advanceModule('stale');
    const originalPin = advanceModule('old parent pin');

    const parent = init('parent');
    installUpdateContract(parent);
    git(parent, 'submodule', 'add', module, 'module');
    commit(parent, 'Initial parent');
    const checkout = join(dir, 'checkout');
    git(dir, 'clone', '--recurse-submodules', parent, checkout);
    const localModule = join(checkout, 'module');
    expect(git(localModule, 'rev-parse', 'HEAD')).toBe(originalPin);
    git(localModule, 'checkout', '--detach', stale);
    expect(git(checkout, 'status', '--porcelain')).not.toBe('');
    const staleLock = join(checkout, '.git', 'index.lock');
    writeFileSync(staleLock, '');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(staleLock, old, old);

    const newPin = advanceModule('new parent pin');
    const unreviewed = advanceModule('remote tip not pinned');
    const replacement = join(dir, 'replacement.git');
    git(dir, 'clone', '--bare', module, replacement);
    git(join(parent, 'module'), 'fetch');
    git(join(parent, 'module'), 'checkout', '--detach', newPin);
    git(parent, 'config', '-f', '.gitmodules', 'submodule.module.url', replacement);
    const target = commit(parent, 'Switch module URL and pin');

    const result = run(checkout);
    expect(result.status, result.stdout + result.stderr + readUpdateLog(checkout)).toBe(19);
    expect(recordedSteps(result).filter(step => step !== 'waiting:running')).toEqual([
      'waiting:done', 'git-pull:running', 'git-pull:done',
      'submodules:running', 'submodules:done', 'runtime-preflight:running', 'runtime-preflight:done',
      'pm2-stop:running', 'pm2-stop:done', 'npm-install:running', 'restart:running', 'restart:error',
    ]);
    expect(existsSync(staleLock)).toBe(false);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(target);
    expect(git(localModule, 'rev-parse', 'HEAD')).toBe(newPin);
    expect(git(localModule, 'rev-parse', 'HEAD')).not.toBe(unreviewed);
    expect(normalize(git(localModule, 'remote', 'get-url', 'origin'))).toBe(normalize(replacement));
  }, 45_000);

  it('refuses a dirty working tree without stashing or advancing it', () => {
    const { dir, git, commit, init, run } = sandbox();
    const parent = init('parent');
    installUpdateContract(parent);
    writeFileSync(join(parent, 'tracked'), 'base');
    const initial = commit(parent, 'Initial parent');
    const checkout = join(dir, 'checkout');
    git(dir, 'clone', parent, checkout);
    writeFileSync(join(checkout, 'tracked'), 'local edit');
    writeFileSync(join(parent, 'tracked'), 'remote edit');
    commit(parent, 'Upstream update');
    const result = run(checkout);
    expect(result.status, result.stdout + result.stderr + readUpdateLog(checkout)).toBe(1);
    expect(result.stdout, readUpdateLog(checkout)).toContain('Checkout is dirty; no stash was created');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(initial);
    expect(git(checkout, 'diff', '--name-only')).toBe('tracked');
    expect(git(checkout, 'stash', 'list')).toBe('');
  }, 45_000);
});
