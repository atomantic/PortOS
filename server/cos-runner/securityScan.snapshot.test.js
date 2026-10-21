import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, lstat, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawn } from '../lib/childProcess.js';
import { createSecurityScanManager } from './securityScan.js';
import { cleanupSecurityScanGroup } from './securityScanRecovery.js';

let root, source;
const managers = [];
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const commit = () => { git('add', '.'); return git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic baseline'); };
// A killed worker reparented to a PID 1 that does not reap stays a zombie, and kill(pid, 0) succeeds on it.
function isRunning(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s*[ZX]/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
}

const grant = { model: 'example-model', effort: 'medium', auth: 'chatgpt', maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' };

// The deadline only bounds a hung supervisor. It was 1s (the former vi.waitFor
// default), which a loaded machine exceeds just spawning the Git supervisor
// (#12791), so it is generous; the deadline contract test drives it by fake time.
// A missing marker must distinguish
// pending preparation from an already-settled request or an exited supervisor.
// No paths, PIDs, child output, exception messages or environment enter errors.
// #11528's historical timing cause is still unknown. Set
// PORTOS_PROFILE_SCANNER_PREPARATION=1 on the capped broader plan to retain the
// same fixed state/phase timings on success as well as failure; a quiet pass is
// not evidence that the missing-marker failure is resolved.
const MARKER_DEADLINE_MS = 30_000;
function observeGitPreparation(markerName = 'git-worker') {
  const started = performance.now();
  const state = { settlement: 'pending', status: null, spawned: false, pidAssigned: false,
    prepareSent: false, reply: null, exited: false, exitCode: null, signal: null, errorCode: null };
  const phases = [];
  const mark = phase => { if (phases.length < 16) phases.push({ phase, elapsedMs: Math.round(performance.now() - started) }); };
  let child;
  let originalSend;
  let timer;
  let pollTimer;
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Own rejection immediately, even when asynchronous fixture setup precedes wait.
  ready.catch(() => {});
  const dispose = () => {
    settled = true;
    clearTimeout(timer);
    clearTimeout(pollTimer);
    child?.removeListener('spawn', onSpawn);
    child?.removeListener('error', onError);
    child?.removeListener('exit', onExit);
    child?.removeListener('message', onMessage);
    if (child && originalSend) child.send = originalSend;
  };
  const finish = (reason, pid) => {
    if (settled) return;
    settled = true;
    const diagnostics = { ...state, elapsedMs: Math.round(performance.now() - started), phases: [...phases] };
    if (process.env.PORTOS_PROFILE_SCANNER_PREPARATION === '1') {
      process.stdout.write(JSON.stringify({ kind: 'synthetic-git-preparation', outcome: reason || 'ready', ...diagnostics }) + '\n');
    }
    dispose();
    if (reason) rejectReady(Object.assign(new Error('Synthetic Git preparation: ' + reason + ' ' + JSON.stringify(diagnostics)), { reason, diagnostics }));
    else resolveReady(pid);
  };
  const onSpawn = () => { state.spawned = true; mark('supervisor-spawn'); };
  const onError = error => {
    state.errorCode = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'other';
    finish('supervisor-error-before-marker');
  };
  const onExit = (code, signal) => {
    state.exited = true;
    state.exitCode = Number.isInteger(code) ? code : null;
    state.signal = ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(signal) ? signal : signal ? 'other' : null;
    finish('supervisor-exit-before-marker');
  };
  const onMessage = message => {
    state.reply = message?.snapshotError ? 'snapshot-error' : message?.snapshot ? 'snapshot' : 'other';
    mark('preparation-reply');
  };
  // Reuse the former waitFor polling cadence without a new filesystem-watcher
  // dependency. Atomic publication makes a visible marker a complete PID.
  const poll = () => {
    if (settled) return;
    readFile(join(root, markerName), 'utf8').then(text => {
      if (settled) return;
      const pid = Number(text);
      if (!Number.isInteger(pid) || pid <= 1) return finish('invalid-marker');
      mark('git-marker');
      finish(null, pid);
    }, error => {
      if (settled) return;
      if (error.code !== 'ENOENT') return finish('marker-read-failed');
      pollTimer = setTimeout(poll, 50);
    });
  };
  return {
    spawnProcess(command, args, options) {
      child = spawn(command, args, options);
      state.pidAssigned = Number.isInteger(child.pid) && child.pid > 1;
      mark('supervisor-created');
      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
      originalSend = child.send;
      child.send = function (message, ...rest) {
        if (message?.prepare) { state.prepareSent = true; mark('preparation-sent'); }
        return originalSend.call(this, message, ...rest);
      };
      return child;
    },
    wait(run) {
      if (!settled) {
        timer = setTimeout(() => finish('marker-deadline'), MARKER_DEADLINE_MS);
        poll();
      }
      run.then(result => {
        state.settlement = 'fulfilled';
        const status = result?.evidence?.status;
        state.status = ['invalid-input', 'unavailable', 'interrupted', 'completed', 'failed'].includes(status) ? status : 'other';
        finish('request-settled-before-marker');
      }, () => {
        state.settlement = 'rejected';
        finish('request-rejected-before-marker');
      });
      return ready;
    },
    dispose,
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scanner-snapshot-test-')));
  source = join(root, 'source');
  await mkdir(source);
  git('init', '--template=');
  await writeFile(join(source, 'boundary.js'), 'committed boundary');
  await writeFile(join(source, 'context.md'), 'committed knowledge');
  commit();
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop('agent-fixture').catch(() => {});
  // Always remove the temp root, even when owner cleanup throws, so a failing
  // test cannot leak scanner-snapshot-test-* directories (#12791).
  try {
    const owner = await readFile(join(root, 'agents/agent-fixture/security-scan-process.json'), 'utf8').then(JSON.parse).catch(() => null);
    await cleanupSecurityScanGroup(owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup(options = {}) {
  const fixture = join(root, 'scanner.cjs');
  // A synthetic process only: captures the received scope, without any network
  // or provider code. The real runner/supervisor/Git ownership path is exercised.
  await writeFile(fixture, `const fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(join(root, 'launched.json'))},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
    console.log(JSON.stringify({cost:{estimatedUsd:0}}));`);
  const manager = createSecurityScanManager({ agentsDir: join(root, 'agents'), tempRoot: root,
    getAgent: () => ({ workspacePath: source }),
    resolveCli: async () => ({ command: process.execPath, args: [fixture] }), ...options });
  managers.push(manager);
  await manager.register('agent-fixture', grant);
  return manager;
}

describe.skipIf(process.platform === 'win32')('scanner committed snapshot boundary', () => {
  it('pins all inputs to independent objects and preserves the baseline through live edits and commits', async () => {
    const initialCommit = git('rev-parse', 'HEAD');
    const initialTree = git('rev-parse', 'HEAD^{tree}');
    await writeFile(join(source, 'boundary.js'), 'dirty content excluded');
    await writeFile(join(source, 'untracked.txt'), 'untracked content excluded');
    const manager = await setup({ emitEvidence: async (_id, evidence) => {
      if (evidence.status === 'running' && evidence.baseline) {
        await writeFile(join(source, 'boundary.js'), 'later repair');
        commit();
      }
    } });
    const result = await manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['boundary.js'], knowledgeBase: ['context.md'] });
    expect(result.evidence).toMatchObject({ status: 'completed', exitCode: 0, cleanup: 'confirmed', baseline: {
      commit: initialCommit, tree: initialTree, kind: 'git-commit', uncommitted: 'excluded', submodules: 'excluded', symlinks: 'link-text',
    } });
    const launch = JSON.parse(await readFile(join(root, 'launched.json'), 'utf8'));
    expect(launch.cwd).not.toBe(source);
    expect(launch.args[1]).toBe(launch.cwd);
    expect(launch.args[launch.args.indexOf('--path') + 1]).toBe(join(launch.cwd, 'boundary.js'));
    expect(launch.args[launch.args.indexOf('--knowledge-base') + 1]).toBe(join(launch.cwd, 'context.md'));
    expect(await readFile(join(launch.cwd, 'boundary.js'), 'utf8')).toBe('committed boundary');
    expect(await lstat(join(launch.cwd, 'untracked.txt')).catch(() => null)).toBeNull();
    expect(git('rev-parse', 'HEAD')).not.toBe(initialCommit);
    expect(await readFile(join(launch.cwd, '.git/objects/info/alternates')).catch(() => null)).toBeNull();
    expect(await readFile(join(launch.cwd, '.git/config'), 'utf8')).not.toContain('[remote');
    expect(await manager.start('agent-fixture', { prompt: 'Again', paths: ['.'] })).toEqual(result);
  });

  it('does not execute source filters/hooks or follow symlinks and reports submodule exclusions', async () => {
    await symlink(join(root, 'outside'), join(source, 'link'));
    await writeFile(join(source, '.gitattributes'), 'boundary.js filter=fixture\n');
    commit();
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},vendor`);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic gitlink');
    await mkdir(join(source, 'vendor'));
    const marker = join(root, 'hook-ran');
    git('config', 'filter.fixture.smudge', `touch ${marker}`);
    git('config', 'uploadpack.packObjectsHook', `touch ${marker}`);
    const hooks = join(root, 'hooks'); await mkdir(hooks);
    await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`); await chmod(join(hooks, 'post-checkout'), 0o700);
    git('config', 'core.hooksPath', hooks);
    const manager = await setup();
    const result = await manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'] });
    expect(result.evidence.status).toBe('completed');
    const launch = JSON.parse(await readFile(join(root, 'launched.json'), 'utf8'));
    expect((await lstat(join(launch.cwd, 'link'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(launch.cwd, 'link'), 'utf8')).toBe(join(root, 'outside'));
    expect(await readFile(join(launch.cwd, 'boundary.js'), 'utf8')).toBe('committed boundary');
    expect(await lstat(marker).catch(() => null)).toBeNull();
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: launch.cwd, encoding: 'utf8' }).trim()).toBe('');
  });

  it.each(['uncommitted', 'submodule', 'git-metadata'])('rejects %s selected context before provider launch and permits an explicit correction after cleanup', async kind => {
    const path = kind === 'uncommitted' ? 'draft.md' : kind === 'submodule' ? 'vendor' : '.git/config';
    if (kind === 'uncommitted') await writeFile(join(source, path), 'not in commit');
    else if (kind === 'submodule') {
      git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},vendor`);
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic gitlink');
      await mkdir(join(source, path));
    }
    const manager = await setup();
    const result = await manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'], knowledgeBase: [path] });
    expect(result.evidence).toMatchObject({ status: 'invalid-input', cleanup: 'confirmed', preflight: { lastError: {
      field: 'knowledgeBase', code: kind === 'submodule' ? 'submodule-excluded' : 'not-in-commit',
    } } });
    expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
    const corrected = await manager.start('agent-fixture', { prompt: 'Corrected input', paths: ['.'] });
    expect(corrected.evidence).toMatchObject({ status: 'completed', preflight: result.evidence.preflight });
    expect(await manager.start('agent-fixture', { prompt: 'Again', paths: ['.'] })).toEqual(corrected);
  });

  it('stops owned Git preparation and never launches the scanner after Stop', async () => {
    const bin = join(root, 'bin'); await mkdir(bin);
    const marker = join(root, 'git-worker');
    await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$$" > '${marker}.pending'\nmv '${marker}.pending' '${marker}'\nexec sleep 300\n`);
    await chmod(join(bin, 'git'), 0o700);
    const preparation = observeGitPreparation();
    const manager = await setup({ spawnProcess: preparation.spawnProcess,
      environment: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, graceMs: 100 });
    const run = manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'] });
    try {
      const pid = await preparation.wait(run);
      expect(pid).toBeGreaterThan(1);
      expect((await manager.stop('agent-fixture')).status).toBe('interrupted');
      expect((await run).evidence.cleanup).toBe('confirmed');
      expect(isRunning(pid)).toBe(false);
      expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
    } finally {
      preparation.dispose();
      await manager.stop('agent-fixture');
      await run;
    }
  });

  it('reports settlement before Git readiness rather than waiting for a marker that cannot arrive', async () => {
    const preparation = observeGitPreparation();
    const manager = await setup({ spawnProcess: preparation.spawnProcess });
    try {
      const run = manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['missing.js'] });
      await expect(preparation.wait(run)).rejects.toMatchObject({ reason: 'request-settled-before-marker', diagnostics: {
        settlement: 'fulfilled', status: 'invalid-input', spawned: false, prepareSent: false,
      } });
      expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
    } finally { preparation.dispose(); }
  });

  it('reports a supervisor that exits before Git readiness and still confirms owned cleanup', async () => {
    const preparation = observeGitPreparation();
    const manager = await setup({ spawnProcess: (_command, _args, options) =>
      preparation.spawnProcess(process.execPath, ['-e', 'process.exit(17)'], options) });
    const run = manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'] });
    try {
      await expect(preparation.wait(run)).rejects.toMatchObject({ reason: 'supervisor-exit-before-marker', diagnostics: {
        spawned: true, exited: true, exitCode: 17,
      } });
      expect((await run).evidence).toMatchObject({ status: 'unavailable', cleanup: 'confirmed' });
      expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
    } finally { preparation.dispose(); await manager.stop('agent-fixture'); await run; }
  });

  it('retains bounded pending-state diagnostics when preparation does not advance before the existing deadline', async () => {
    vi.useFakeTimers();
    const preparation = observeGitPreparation();
    try {
      const ready = preparation.wait(new Promise(() => {}));
      const failed = expect(ready).rejects.toMatchObject({ reason: 'marker-deadline', diagnostics: {
        settlement: 'pending', spawned: false, pidAssigned: false, prepareSent: false, reply: null,
      } });
      await vi.advanceTimersByTimeAsync(MARKER_DEADLINE_MS);
      await failed;
      expect(vi.getTimerCount()).toBe(0);
    } finally { preparation.dispose(); vi.useRealTimers(); }
  });

  it('fails closed if committed baseline evidence cannot be persisted before launch', async () => {
    const manager = await setup({ emitEvidence: async (_id, evidence) => {
      if (evidence.baseline) throw new Error('Synthetic persistence failure');
    } });
    const run = manager.start('agent-fixture', { prompt: 'Synthetic audit', paths: ['.'] });
    await expect(run).rejects.toThrow('Synthetic persistence failure');
    expect(manager.start('agent-fixture', { prompt: 'Again', paths: ['.'] })).toBe(run);
    expect(await lstat(join(root, 'launched.json')).catch(() => null)).toBeNull();
  });
});
