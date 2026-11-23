import { installUpdateTestSupervisor } from './lib/updateTestSupervisor.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../server/lib/gitTestRepo.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';
const SHIM = WINDOWS ? 'update.ps1' : 'update.sh';
const windowsSpawnHelpers = 'server/lib/aiToolkit/internal/windowsSafeSpawn.js';
const ecosystem = JSON.parse(execFileSync(process.execPath, ['-p', "JSON.stringify(require('./ecosystem.config.cjs').apps.map(x => x.name))"], { cwd: REPO_ROOT, encoding: 'utf8' }));
const productionApps = ecosystem.filter(name => name !== 'portos-ui').join(',');

// Everything update.sh shells out to between the pm2 delete and the pm2 start.
// Stubbing them lets the success path run end to end offline, which is the only
// way to prove the exit trap does NOT start the apps a second time.
const STUB_SCRIPTS = [
  'setup-data.js', 'setup-db.js', 'setup-browser.js', 'setup-ghostty.js',
  'setup-cert.js', 'setup-guide.js', 'run-migrations.js',
  'verify-server-health.js', 'print-access-url.js', 'open-ui-in-browser.js',
  'ensure-ffmpeg.js', 'install-slashdo.js'
];

/**
 * A throwaway checkout of update.sh with `npm`, `npx` and `pm2` shimmed, so the
 * assertions below are what the script actually does to PM2 rather than a grep
 * for the guard's source text. The rationale for the guard itself lives with it
 * in update.sh.
 *
 * @param {{origin?: boolean, failAfterDelete?: boolean, npmShim?: string,
 *   forceClean?: boolean, pm2OnPath?: boolean, healthy?: boolean}} options
 *   origin:false leaves the checkout with no upstream, so the git-pull step
 *   fails before anything is deleted. failAfterDelete fails the first step AFTER
 *   the pm2 delete that does not also wipe node_modules. npmShim picks whether
 *   `npm`/`npx` succeed ('ok'), fail ('fail' — which makes safe_install wipe
 *   node_modules first) or stall ('slow', so a signal can arrive mid-window).
 *   forceClean makes safe_install wipe root node_modules regardless of the diff,
 *   pm2OnPath supplies a fallback pm2 for when that wipe removes the local one,
 *   and healthy:false makes the health probe report the server never came back.
 */
async function makeSandbox({
  origin = true, failAfterDelete = true, npmShim = 'ok',
  forceClean = false, pm2OnPath = false, healthy = true, stallDelete = false, nodeVersion = null, originAhead = false, peerTarget = false, aheadRefusesInCheckout = false, unknownPrevious = false, withoutDeps = false, pm2StartFailure = false,
  lockfileOnly = false, pendingLockfiles = null, restoreTrees = false
} = {}) {
  const { scratch, repo } = await makeGitSandbox({ origin, prefix: 'portos-update-guard-' });
  const bin = join(scratch, 'bin');
  const calls = join(scratch, 'pm2-calls.log');
  const releaseFile = join(scratch, 'pm2-delete-stalled');
  const optionalCalls = join(scratch, 'optional-calls.log');

  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  if (!withoutDeps) mkdirSync(join(repo, 'node_modules', 'pm2', 'bin'), { recursive: true });

  installUpdateTestSupervisor(repo);
  for (const file of [SHIM, 'scripts/update.mjs', windowsSpawnHelpers]) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), join(repo, file));
  }
  if (!WINDOWS) chmodSync(join(repo, SHIM), 0o755);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'sandbox', version: '0.0.0', type: 'module' }));
  writeFileSync(join(repo, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');
  // Mirror the production ignore rule so update.sh's own runtime log does not
  // turn an otherwise clean synthetic checkout into a dirty one.
  writeFileSync(join(repo, '.gitignore'), 'data/*\nnode_modules/\n');

  // Records every pm2 invocation the script makes, in order. When stallDelete is
  // set the `delete` call logs and then BLOCKS until the test deletes the release
  // file, so a signal can be delivered while the delete is still running — the
  // window a latch armed after the delete would miss.
  if (!withoutDeps) {
    writeFileSync(join(repo, 'node_modules', 'pm2', 'package.json'), JSON.stringify({ name: 'pm2', version: '0.0.0' }));
    writeFileSync(
      join(repo, 'node_modules', 'pm2', 'bin', 'pm2'),
      `const fs = require('fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(calls)}, args + '\\n');
if (${stallDelete} && args.startsWith('delete')) {
  const release = ${JSON.stringify(releaseFile)};
  fs.writeFileSync(release, 'stalled');
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  while (fs.existsSync(release)) Atomics.wait(sleep, 0, 0, 30);
}
if (${pm2StartFailure} && args.startsWith('start') && !fs.existsSync(${JSON.stringify(join(scratch, 'pm2-start-once'))})) {
  fs.writeFileSync(${JSON.stringify(join(scratch, 'pm2-start-once'))}, '');
  process.exitCode = 1;
}
`
    );
  }

  // The REAL runtime gate (the pulled target's own copy), so the preflight
  // exercises the shared requirement rather than a stub with a copied floor.
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'scripts', 'checkNodeVersion.js'), join(repo, 'scripts', 'checkNodeVersion.js'));
  copyFileSync(join(REPO_ROOT, 'scripts', 'lib', 'directInvocation.js'), join(repo, 'scripts', 'lib', 'directInvocation.js'));
  // Make the interpreter report an older runtime to that gate (and only to it).
  let nodeOptions = '';
  if (nodeVersion) {
    const preload = join(scratch, 'fake-node-version.mjs');
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });\n`);
    nodeOptions = `--import=${pathToFileURL(preload).href}`;
  }

  writeFileSync(join(repo, 'scripts', 'SLASHDO_VERSION'), '0.0.0\n');
  writeFileSync(join(repo, 'scripts', 'trusted-rebuilds.js'), `process.exit(${failAfterDelete ? 1 : 0});\n`);
  for (const stub of STUB_SCRIPTS) {
    const optional = ['ensure-ffmpeg.js', 'install-slashdo.js'].includes(stub);
    // Executed by the real Node process, not a simulated updater step.
    writeFileSync(join(repo, 'scripts', stub), optional ?
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(optionalCalls)}, ${JSON.stringify(stub + '\n')}); process.exit(1);\n`
      : 'process.exit(0);\n');
  }
  writeFileSync(join(repo, 'scripts', 'verify-server-health.js'), `process.exit(${healthy ? 0 : 1});\n`);
  // Non-zero means "the daemon is already ours", which skips the co-located
  // `pm2 update` restart — the branch a healthy install takes.
  writeFileSync(join(repo, 'scripts', 'pm2-daemon-refresh.js'), 'process.exit(1);\n');

  // The workspaces safe_install cd's into, and the dependency it sanity-checks.
  for (const ws of ['client', 'server']) {
    mkdirSync(join(repo, ws), { recursive: true });
    writeFileSync(join(repo, ws, 'package.json'), JSON.stringify({ name: ws, version: '0.0.0', type: 'module' }));
  }
  mkdirSync(join(repo, 'client', 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(join(repo, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '');

  // update.sh only ever calls these as bare commands, so a PATH shim covers
  // every install and the slash-do refresh without touching the network.
  const npmCode = npmShim === 'fail' ? 1 : 0;
  if (restoreTrees) {
    writeFileSync(join(scratch, 'restore-install.mjs'), `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { basename, join } from 'node:path';
      const dir = process.cwd();
      const touch = (rel) => {
        const path = join(dir, rel);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, '{}');
      };
      const name = basename(dir);
      if (name === 'client') touch('node_modules/vite/bin/vite.js');
      else if (name === 'server') {
        touch('node_modules/express/package.json');
        touch('node_modules/pg/package.json');
      } else touch('node_modules/pm2/package.json');
    `);
  }
  const restorePosix = restoreTrees
    ? `${JSON.stringify(process.execPath)} ${JSON.stringify(join(scratch, 'restore-install.mjs'))}\n`
    : '';
  const restoreWindows = restoreTrees
    ? `"${process.execPath}" "${join(scratch, 'restore-install.mjs')}"\r\n`
    : '';
  const shim = (name, posixBody, windowsBody) => {
    const path = join(bin, WINDOWS ? `${name}.cmd` : name);
    writeFileSync(path, WINDOWS ? `@echo off\r\n${windowsBody}\r\n` : `#!/bin/sh\n${posixBody}\n`);
    if (!WINDOWS) chmodSync(path, 0o755);
  };
  for (const name of ['npm', 'npx']) shim(name, `${restorePosix}exit ${npmCode}`, `${restoreWindows}exit /b ${npmCode}`);
  // The success case is the only one that runs past trusted-rebuilds, so it
  // reaches update.sh's ffmpeg step — which on a machine without ffmpeg would
  // run a real `brew install`, or on Linux CI a passwordless `sudo apt-get
  // install` that mutates the runner. update.sh only probes `command -v`.
  shim('ffmpeg', 'exit 0', 'exit /b 0');
  // A pm2 the recovery can still reach after safe_install wipes the local one.
  if (pm2OnPath) {
    shim('pm2', `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
      `echo %*>>"${calls}"\r\nexit /b 0`);
  }

  // The updater now refuses dirty checkouts instead of stashing them. Commit
  // the synthetic fixture so this test still exercises the headless recovery
  // window rather than the dirty-checkout guard.
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });

  // Leave the upstream one commit ahead of the checkout, so the update has a real
  // pull to perform and a refusal can be shown to have left HEAD where it was.
  let aheadSha = null;
  if (originAhead) {
    if (lockfileOnly) {
      writeFileSync(join(repo, 'client', 'package-lock.json'), '{"lockfileVersion":3,"name":"client-lock-only"}\n');
    } else {
      writeFileSync(join(repo, 'ahead.txt'), 'ahead\n');
    }
    if (aheadRefusesInCheckout) {
      // Passes when the pre-pull archive evaluates it (ahead.txt is not
      // archived) and refuses once the pull has put ahead.txt in the checkout —
      // the post-pull gate catching a revision the pre-check let through.
      writeFileSync(join(repo, 'scripts', 'checkNodeVersion.js'),
        "import { existsSync } from 'fs';\nif (existsSync('ahead.txt')) { console.error('Node.js ^99.0.0 required'); process.exit(1); }\n");
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'ahead'], { cwd: repo, stdio: 'ignore' });
    aheadSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: repo, stdio: 'ignore' });
  }
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const flags = [];
  if (!WINDOWS) {
    // A host may have ffmpeg under /usr/bin: avoid invoking the system
    // installer while still exercising the optional helper's real dispatch.
    const preload = join(scratch, 'ffmpeg-fixture.mjs');
    writeFileSync(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      if (process.argv[1]?.endsWith('update.mjs')) {
        const access = fs.accessSync;
        fs.accessSync = (path, ...args) => {
          if (String(path).endsWith('/ffmpeg')) throw Error('ffmpeg is absent in this fixture');
          return access(path, ...args);
        };
        syncBuiltinESMExports();
      }
    `);
    flags.push(`--import=${pathToFileURL(preload).href}`);
  }
  if (nodeOptions) flags.push(nodeOptions);
  if (unknownPrevious) {
    const preload = join(scratch, 'unknown-previous.mjs');
    writeFileSync(preload, `
      import imports from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { basename } from 'node:path';
      const spawn = imports.spawn;
      imports.spawn = (cmd, args, options) => /^git(?:[.]exe)?$/i.test(basename(cmd)) && args.join(' ') === 'rev-parse HEAD'
        ? spawn(process.execPath, ['-e', 'process.exitCode = 1'], options) : spawn(cmd, args, options);
      syncBuiltinESMExports();
    `);
    flags.push(`--import=${pathToFileURL(preload).href}`);
  }
  if (withoutDeps) rmSync(join(repo, 'client', 'node_modules'), { recursive: true, force: true });
  const place = (rel, content) => {
    const path = join(repo, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  if (lockfileOnly) {
    place('client/node_modules/stale-lockfile', 'stale');
    place('server/node_modules/keep-server', 'keep');
    place('node_modules/keep-root', 'keep');
  }
  if (pendingLockfiles) {
    place('server/node_modules/stale-pending', 'stale');
    place('client/node_modules/keep-client', 'keep');
    place('node_modules/keep-root', 'keep');
    place('data/dependency-reconcile-pending.json', JSON.stringify({
      lockfiles: pendingLockfiles,
      recordedAt: '2026-01-01T00:00:00.000Z'
    }));
  }


  return { scratch, repo, bin, calls, optionalCalls, forceClean, releaseFile, nodeOptions: flags.join(' '), headSha, aheadSha, peerTarget };
}

// The three runs share no state, so they go out concurrently rather than
// serializing three full update scripts.
function runUpdate(sandbox, { onStart, automatic = false, operationId } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORTOS_DATA_ROOT: sandbox.repo, HOME: sandbox.scratch,
      PATH: [sandbox.bin, process.env.PATH || process.env.Path].join(delimiter) };
    if (WINDOWS) delete env.Path;
    if (operationId) env.PORTOS_DEFERRED_UPDATE_ID = operationId;
    if (sandbox.forceClean) env.PORTOS_FORCE_CLEAN_WORKSPACES = '.';
    if (sandbox.nodeOptions) env.NODE_OPTIONS = sandbox.nodeOptions;
    if (sandbox.peerTarget) {
      env.PORTOS_PEER_UPDATE_TARGET_SHA = sandbox.aheadSha;
      env.PORTOS_PEER_UPDATE_EXPECTED_SHA = sandbox.headSha;
    }
    const prefix = WINDOWS ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : [];
    const child = spawn(WINDOWS ? 'powershell' : 'bash', [...prefix, join(sandbox.repo, SHIM), ...(automatic ? ['--automatic'] : [])],
      { cwd: sandbox.repo, env });
    child.on('error', reject);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stdout += d; });
    child.on('close', (status) => resolve({ status, stdout }));
    onStart?.(child);
  });
}

// Resolves once a sentinel appears, so a test can act at a precise point in the
// window instead of guessing at a delay.
function waitForFile(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

const pm2Calls = (sandbox) =>
  (existsSync(sandbox.calls) ? readFileSync(sandbox.calls, 'utf8') : '').split(/\r?\n/).filter(Boolean);

describe.skipIf(SKIP_HEAVY_INTEGRATION)('shared updater headless-install guard', () => {
  const sandboxes = {};
  const results = {};

  beforeAll(async () => {
    const cases = {
      failed: {},
      clean: { failAfterDelete: false },
      preDelete: { origin: false },
      unhealthy: { healthy: false },
      // A target whose Node requirement the installed runtime no longer meets.
      oldNode: { nodeVersion: '22.12.0' },
      manualOldNode: { nodeVersion: '22.12.0' },
      // Same, with a pull pending: the refusal must come before HEAD moves, on
      // both the upstream and the peer-target (ff-only merge) paths.
      oldNodeAhead: { nodeVersion: '22.12.0', origin: true, originAhead: true },
      oldNodePeer: { nodeVersion: '22.12.0', origin: true, originAhead: true, peerTarget: true },
      // The pre-pull archive gate passes, the pull lands, and only the post-pull
      // gate refuses: the checkout must be rolled back with apps untouched.
      postPullRefusal: { origin: true, originAhead: true, aheadRefusesInCheckout: true },
      unknownPrevious: { originAhead: true, aheadRefusesInCheckout: true, unknownPrevious: true },
      startFails: { failAfterDelete: false, pm2StartFailure: true },
      cleanAhead: { nodeVersion: null, failAfterDelete: false, origin: true, originAhead: true },
      // The failure the guard's own comment names: both npm installs fail, and
      // safe_install wiped root node_modules — pm2 included — on the way.
      pm2Wiped: { npmShim: 'fail', forceClean: true, pm2OnPath: true }
    };
    await Promise.all(Object.entries(cases).map(async ([name, options]) => {
      sandboxes[name] = await makeSandbox(options);
    }));
    await Promise.all(Object.keys(cases).map(async (name) => {
      const automatic = ['preDelete', 'oldNode', 'oldNodeAhead', 'oldNodePeer', 'postPullRefusal', 'unknownPrevious'].includes(name);
      results[name] = await runUpdate(sandboxes[name], { automatic });
    }));
  }, 180000);

  afterAll(async () => {

    await Promise.all(Object.values(sandboxes).map(box => destroyGitSandbox(box.scratch)));
  });

  it('restarts the PM2 apps it deleted when a later step aborts the update', () => {
    const calls = pm2Calls(sandboxes.failed);
    const deleteAt = calls.findIndex(c => c.startsWith('delete ecosystem.config.cjs'));
    const startAt = calls.findIndex(c => c.startsWith('start ecosystem.config.cjs'));
    expect(deleteAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(-1);
    expect(startAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(deleteAt);
  });

  it('still reports the update as failed after recovering', () => {
    expect(results.failed.status).not.toBe(0);
    expect(results.failed.stdout).toContain('STEP:restart:warning:');
  });

  it('starts the apps exactly once on an update that succeeds', () => {
    expect(results.clean.status, results.clean.stdout).toBe(0);
    expect(pm2Calls(sandboxes.clean).filter(c => c.startsWith('start ecosystem.config.cjs'))).toHaveLength(1);
    expect(results.clean.stdout).toContain('STEP:restart:done:');
    expect(results.clean.stdout).not.toContain('STEP:restart:warning:');
  });

  it('does not claim a recovery the health probe never confirmed', () => {
    expect(results.unhealthy.status).not.toBe(0);
    expect(results.unhealthy.stdout).toContain('STEP:restart:error:');
    expect(results.unhealthy.stdout).not.toContain('STEP:restart:warning:');
  });

  it('restarts through a pm2 the failed install did not delete', () => {
    // safe_install wipes root node_modules (pm2 is a ROOT dependency) before it
    // retries, so a recovery hardcoded to ./node_modules/pm2/bin/pm2 would be a
    // no-op on the most likely failure of all.
    const calls = pm2Calls(sandboxes.pm2Wiped);
    const deleteAt = calls.findIndex(c => c.startsWith('delete ecosystem.config.cjs'));
    const startAt = calls.findIndex(c => c.startsWith('start ecosystem.config.cjs'));
    expect(deleteAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(-1);
    expect(startAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(deleteAt);
    expect(results.pm2Wiped.status).not.toBe(0);
  });

  const interruptCases = WINDOWS ? [['SIGINT', 130], ['SIGHUP', 129]] : [['SIGTERM', 143]];
  it.each(interruptCases)('restarts the apps when the updater receives %s during the delete itself', async (signal, status) => {
    const box = await makeSandbox({ stallDelete: true });
    if (WINDOWS) {
      // Win32 TerminateProcess cannot run signal handlers. Inject the console
      // signal event in the real Node updater, while its child is still busy.
      const preload = join(box.scratch, 'console-signal.mjs');
      writeFileSync(preload, `
        import { existsSync, rmSync } from 'node:fs';
        if (process.argv[1]?.endsWith('update.mjs') && process.env.PORTOS_DEFERRED_UPDATE_ID) {
          const path = ${JSON.stringify(box.releaseFile)};
          const timer = setInterval(() => {
            if (!existsSync(path)) return;
            process.emit(${JSON.stringify(signal)});
            rmSync(path, { force: true });
            clearInterval(timer);
          }, 20);
          timer.unref();
        }
      `);
      box.nodeOptions = [box.nodeOptions, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
    }
    try {
      const result = await runUpdate(box, {
        onStart: WINDOWS ? undefined : (child) => {
          waitForFile(box.releaseFile)
            .then(() => {
              child.kill(signal);
              rmSync(box.releaseFile, { force: true });
            })
            .catch(() => child.kill('SIGKILL'));
        }
      });
      const calls = pm2Calls(box);
      const deleteAt = calls.findIndex(c => c.startsWith('delete ecosystem.config.cjs'));
      const startAt = calls.findIndex(c => c.startsWith('start ecosystem.config.cjs'));
      expect(startAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(deleteAt);
      expect(result.status).toBe(status);
      expect(result.stdout).toContain('STEP:restart:warning:');
    } finally {
      await destroyGitSandbox(box.scratch);
    }
  }, 120000);

  it('refuses an unsupported Node runtime before stopping apps or installing on an automatic update', () => {
    const { status, stdout } = results.oldNode;
    expect(status).toBe(1);
    expect(stdout).toContain('STEP:runtime-preflight:failed:');
    expect(stdout).toContain('Node.js ^22.22.2');
    expect(stdout).not.toContain('STEP:pm2-stop:');
    expect(stdout).not.toContain('STEP:npm-install:');
    expect(pm2Calls(sandboxes.oldNode)).toEqual([]);
  });

  it('restarts the gracefully stopped services when a manual update refuses the target runtime', () => {
    const { status, stdout } = results.manualOldNode;
    const calls = pm2Calls(sandboxes.manualOldNode);
    expect(status).toBe(1);
    expect(stdout.indexOf('STEP:pm2-stop:running:')).toBeLessThan(stdout.indexOf('STEP:runtime-preflight:failed:'));
    expect(stdout).not.toContain('STEP:npm-install:');
    expect(stdout).toContain('STEP:restart:warning:');
    expect(calls.filter(c => c.startsWith('start ecosystem.config.cjs'))).toHaveLength(1);
  });

  it.each(['oldNodeAhead', 'oldNodePeer'])('refuses an unsupported runtime before the checkout moves (%s)', (name) => {
    const { status, stdout } = results[name];
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sandboxes[name].repo, encoding: 'utf8' }).trim();
    expect(status).toBe(1);
    expect(stdout).toContain('STEP:runtime-preflight:failed:');
    expect(stdout).toContain('Node.js ^22.22.2');
    expect(stdout).not.toContain('STEP:git-pull:done:');
    expect(stdout).not.toContain('STEP:submodules:');
    expect(head()).toBe(sandboxes[name].headSha);
    expect(existsSync(join(sandboxes[name].repo, 'ahead.txt'))).toBe(false);
    expect(pm2Calls(sandboxes[name])).toEqual([]);
  });

  it('rolls the checkout back to the pre-pull commit when only the post-pull Node gate refuses', () => {
    const { repo, headSha } = sandboxes.postPullRefusal;
    const { status, stdout } = results.postPullRefusal;
    expect(status).toBe(1);
    expect(stdout).toContain('STEP:git-pull:done:');
    expect(stdout).toContain('STEP:runtime-preflight:failed:');
    expect(stdout).toContain('checkout rolled back');
    expect(stdout).not.toContain('STEP:pm2-stop:');
    expect(stdout).not.toContain('STEP:restart:');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(headSha);
    expect(existsSync(join(repo, 'ahead.txt'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('');
    expect(pm2Calls(sandboxes.postPullRefusal)).toEqual([]);
  });

  it('never resets to an unknown pre-pull commit', () => {
    const { repo, aheadSha } = sandboxes.unknownPrevious;
    const { status, stdout } = results.unknownPrevious;
    expect(status).toBe(1);
    expect(stdout).toContain('STEP:runtime-preflight:failed:Unsupported Node.js runtime; update stopped');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(aheadSha);
    expect(existsSync(join(repo, 'ahead.txt'))).toBe(true);
    expect(pm2Calls(sandboxes.unknownPrevious)).toEqual([]);
  });

  it('preserves the manual update step protocol exactly', () => {
    const steps = results.clean.stdout.split(/\r?\n/).filter(line => /^STEP:/.test(line))
      .map(line => line.split(':').slice(1, 3).join(':')).filter(step => !step.startsWith('waiting:'));
    expect(steps).toEqual(['pm2-stop', 'git-pull', 'submodules', 'runtime-preflight', 'npm-install', 'setup',
      'network-setup', 'ffmpeg', 'migrations', 'slash-do', 'build', 'restart', 'verify']
      .flatMap(name => [`${name}:running`, `${name}:done`]));
  });

  it('dispatches ffmpeg and slash-do through their fail-soft shared helpers', () => {
    expect(readFileSync(sandboxes.clean.optionalCalls, 'utf8').trim().split(/\r?\n/))
      .toEqual(['ensure-ffmpeg.js', 'install-slashdo.js']);
    expect(results.clean.status).toBe(0);
  });

  it('deletes stale Vite and starts only production apps on success and recovery', () => {
    for (const box of [sandboxes.clean, sandboxes.failed, sandboxes.pm2Wiped]) {
      const calls = pm2Calls(box);
      const start = calls.findIndex(line => line.startsWith('start ecosystem.config.cjs'));
      expect(start).toBeGreaterThan(0);
      expect(calls.slice(0, start)).toContain('delete portos-ui --silent');
      expect(calls.filter(line => line.startsWith('start '))).toEqual([`start ecosystem.config.cjs --only ${productionApps}`]);
    }
  });

  it('removes the completion marker on startup failure before restoring apps', () => {
    expect(results.startFails.status).toBe(1);
    expect(results.startFails.stdout).toContain('STEP:restart:warning:');
    expect(existsSync(join(sandboxes.startFails.repo, 'data', 'update-complete.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(sandboxes.clean.repo, 'data', 'update-complete.json'), 'utf8')).version).toBe('0.0.0');
  });

  it('publishes failed terminal evidence after recovery without any application dependencies', async () => {
    const box = await makeSandbox({ withoutDeps: true, npmShim: 'fail', pm2OnPath: true });
    try {
      expect(existsSync(join(box.repo, 'node_modules'))).toBe(false);
      const admission = createMaintenanceAdmission(join(box.repo, 'data'));
      const operation = admission.deferredUpdate.request();
      admission.deferredUpdate.acquire(operation.id);
      const result = await runUpdate(box, { operationId: operation.id });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('STEP:restart:warning:');
      expect(admission.deferredUpdate.get().operation.terminal).toEqual({ success: false });
      admission.deferredUpdate.reconcile({ absent: () => true, platform: process.platform });
      expect(admission.held()).toBe(false);
      expect(admission.deferredUpdate.get().result.success).toBe(false);
    } finally { await destroyGitSandbox(box.scratch); }
  }, 30000);

  it('still pulls and updates when the target supports the runtime', () => {
    const { repo, aheadSha } = sandboxes.cleanAhead;
    expect(results.cleanAhead.status, results.cleanAhead.stdout).toBe(0);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(aheadSha);
  });

  it('checks the target runtime after gracefully stopping services for a manual update', () => {
    expect(results.clean.stdout).toContain('STEP:runtime-preflight:done:');
    expect(results.clean.stdout.indexOf('STEP:runtime-preflight:done:'))
      .toBeGreaterThan(results.clean.stdout.indexOf('STEP:pm2-stop:running:'));
  });

  it('does not touch PM2 when the update aborts before the delete', () => {
    expect(results.preDelete.status).not.toBe(0);
    expect(pm2Calls(sandboxes.preDelete)).toEqual([]);
  });

  function dependencyReceipt(dir) {
    const hash = createHash('sha256').update(readFileSync(join(dir, 'package.json'))).update('\0');
    const lockfile = join(dir, 'package-lock.json');
    hash.update(existsSync(lockfile) ? readFileSync(lockfile) : '<no-lockfile>');
    return `v2:${hash.digest('hex')}`;
  }

  // The sandbox's own ensure-deps, with npm replaced so a redundant install is visible.
  function attachEnsureDeps(repo) {
    mkdirSync(join(repo, 'server', 'lib'), { recursive: true });
    copyFileSync(join(REPO_ROOT, 'scripts', 'ensure-deps.js'), join(repo, 'scripts', 'ensure-deps.js'));
    copyFileSync(join(REPO_ROOT, 'scripts', 'lib', 'workspaceDependencies.js'), join(repo, 'scripts', 'lib', 'workspaceDependencies.js'));
    writeFileSync(join(repo, 'scripts', 'trusted-rebuilds.js'), 'export const rebuildTrusted = () => true;\n');
    writeFileSync(join(repo, 'server', 'lib', 'bufferedSpawn.js'), `
      import { fileURLToPath } from 'node:url';
      export const prepareCliSpawn = (command, args) => ({
        command: process.execPath,
        args: [fileURLToPath(new URL('../../fake-npm.js', import.meta.url)), ...args]
      });
    `);
    writeFileSync(join(repo, 'fake-npm.js'), `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const cwd = process.cwd();
      const marker = join(cwd, 'node_modules', 'npm-ran');
      mkdirSync(join(marker, '..'), { recursive: true });
      writeFileSync(marker, '1');
    `);
  }

  it('wipes node_modules for a lockfile-only update and leaves a receipt ensure-deps trusts', async () => {
    const box = await makeSandbox({
      failAfterDelete: false, origin: true, originAhead: true, lockfileOnly: true, restoreTrees: true
    });
    try {
      const result = await runUpdate(box);
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).toContain('🧹 client package-lock.json changed in this update — clean reinstall (wiping node_modules)');
      expect(result.stdout).not.toContain('🧹 server ');
      expect(result.stdout).not.toContain('🧹 root ');
      expect(existsSync(join(box.repo, 'client', 'node_modules', 'stale-lockfile'))).toBe(false);
      expect(existsSync(join(box.repo, 'server', 'node_modules', 'keep-server'))).toBe(true);
      expect(existsSync(join(box.repo, 'node_modules', 'keep-root'))).toBe(true);
      const hashes = JSON.parse(readFileSync(join(box.repo, 'data', 'deps-hashes.json'), 'utf8'));
      expect(hashes.client).toBe(dependencyReceipt(join(box.repo, 'client')));
      expect(hashes.root).toBe(dependencyReceipt(box.repo));
      expect(hashes.server).toBe(dependencyReceipt(join(box.repo, 'server')));
      attachEnsureDeps(box.repo);
      const output = execFileSync(process.execPath, ['scripts/ensure-deps.js'], { cwd: box.repo, encoding: 'utf8' });
      expect(output).not.toMatch(/reinstall|installing/i);
      for (const rel of ['node_modules/npm-ran', 'client/node_modules/npm-ran', 'server/node_modules/npm-ran']) {
        expect(existsSync(join(box.repo, rel))).toBe(false);
      }
    } finally {
      await destroyGitSandbox(box.scratch);
    }
  }, 120000);

  it('wipes the workspace named by a pending reconcile marker when the pull diff is empty', async () => {
    const box = await makeSandbox({
      failAfterDelete: false, restoreTrees: true, pendingLockfiles: ['server/package-lock.json']
    });
    try {
      const result = await runUpdate(box);
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).toContain('🧹 server package-lock.json changed in this update — clean reinstall (wiping node_modules)');
      expect(result.stdout).not.toContain('🧹 client ');
      expect(result.stdout).not.toContain('🧹 root ');
      expect(existsSync(join(box.repo, 'server', 'node_modules', 'stale-pending'))).toBe(false);
      expect(existsSync(join(box.repo, 'client', 'node_modules', 'keep-client'))).toBe(true);
      expect(existsSync(join(box.repo, 'node_modules', 'keep-root'))).toBe(true);
      expect(existsSync(join(box.repo, 'data', 'dependency-reconcile-pending.json'))).toBe(false);
      const hashes = JSON.parse(readFileSync(join(box.repo, 'data', 'deps-hashes.json'), 'utf8'));
      expect(hashes.server).toBe(dependencyReceipt(join(box.repo, 'server')));
      attachEnsureDeps(box.repo);
      const output = execFileSync(process.execPath, ['scripts/ensure-deps.js'], { cwd: box.repo, encoding: 'utf8' });
      expect(output).not.toMatch(/reinstall|installing/i);
      expect(existsSync(join(box.repo, 'server', 'node_modules', 'npm-ran'))).toBe(false);
    } finally {
      await destroyGitSandbox(box.scratch);
    }
  }, 120000);
});
