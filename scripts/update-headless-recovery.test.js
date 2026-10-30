import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../server/lib/gitTestRepo.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_SH = join(REPO_ROOT, 'update.sh');

// Everything update.sh shells out to between the pm2 delete and the pm2 start.
// Stubbing them lets the success path run end to end offline, which is the only
// way to prove the exit trap does NOT start the apps a second time.
const STUB_SCRIPTS = [
  'setup-data.js', 'setup-db.js', 'setup-browser.js', 'setup-ghostty.js',
  'setup-cert.js', 'setup-guide.js', 'run-migrations.js',
  'verify-server-health.js', 'print-access-url.js', 'open-ui-in-browser.js'
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
  forceClean = false, pm2OnPath = false, healthy = true, stallDelete = false, nodeVersion = null, originAhead = false, peerTarget = false, aheadRefusesInCheckout = false
} = {}) {
  const { scratch, repo } = await makeGitSandbox({ origin, prefix: 'portos-update-guard-' });
  const bin = join(scratch, 'bin');
  const calls = join(scratch, 'pm2-calls.log');
  const releaseFile = join(scratch, 'pm2-delete-stalled');

  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'pm2', 'bin'), { recursive: true });

  copyFileSync(UPDATE_SH, join(repo, 'update.sh'));
  chmodSync(join(repo, 'update.sh'), 0o755);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'sandbox', version: '0.0.0' }));
  writeFileSync(join(repo, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');
  // Mirror the production ignore rule so update.sh's own runtime log does not
  // turn an otherwise clean synthetic checkout into a dirty one.
  writeFileSync(join(repo, '.gitignore'), 'data/*\n');

  // Records every pm2 invocation the script makes, in order. When stallDelete is
  // set the `delete` call logs and then BLOCKS until the test deletes the release
  // file, so a signal can be delivered while the delete is still running — the
  // window a latch armed after the delete would miss.
  writeFileSync(join(repo, 'node_modules', 'pm2', 'package.json'), JSON.stringify({ name: 'pm2', version: '0.0.0' }));
  writeFileSync(
    join(repo, 'node_modules', 'pm2', 'bin', 'pm2'),
    `const fs = require('fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(calls)}, args + '\\n');
if (${stallDelete} && args.startsWith('delete')) {
  const release = ${JSON.stringify(releaseFile)};
  fs.writeFileSync(release, 'stalled');
  while (fs.existsSync(release)) { try { require('child_process').execFileSync('sleep', ['0.05']); } catch { break; } }
}
`
  );

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
    nodeOptions = `--import=${preload}`;
  }

  writeFileSync(join(repo, 'scripts', 'SLASHDO_VERSION'), '0.0.0\n');
  writeFileSync(join(repo, 'scripts', 'trusted-rebuilds.js'), `process.exit(${failAfterDelete ? 1 : 0});\n`);
  for (const stub of STUB_SCRIPTS) {
    writeFileSync(join(repo, 'scripts', stub), 'process.exit(0);\n');
  }
  writeFileSync(join(repo, 'scripts', 'verify-server-health.js'), `process.exit(${healthy ? 0 : 1});\n`);
  // Non-zero means "the daemon is already ours", which skips the co-located
  // `pm2 update` restart — the branch a healthy install takes.
  writeFileSync(join(repo, 'scripts', 'pm2-daemon-refresh.js'), 'process.exit(1);\n');

  // The workspaces safe_install cd's into, and the dependency it sanity-checks.
  for (const ws of ['client', 'server', 'autofixer']) {
    mkdirSync(join(repo, ws), { recursive: true });
    writeFileSync(join(repo, ws, 'package.json'), JSON.stringify({ name: ws, version: '0.0.0' }));
  }
  mkdirSync(join(repo, 'client', 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(join(repo, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '');

  // update.sh only ever calls these as bare commands, so a PATH shim covers
  // every install and the slash-do refresh without touching the network.
  const npmBody = { ok: 'exit 0', fail: 'exit 1', slow: 'sleep 2\nexit 0' }[npmShim];
  for (const shim of ['npm', 'npx']) {
    writeFileSync(join(bin, shim), `#!/bin/sh\n${npmBody}\n`);
    chmodSync(join(bin, shim), 0o755);
  }
  // The success case is the only one that runs past trusted-rebuilds, so it
  // reaches update.sh's ffmpeg step — which on a machine without ffmpeg would
  // run a real `brew install`, or on Linux CI a passwordless `sudo apt-get
  // install` that mutates the runner. update.sh only probes `command -v`.
  writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'ffmpeg'), 0o755);
  // A pm2 the recovery can still reach after safe_install wipes the local one.
  if (pm2OnPath) {
    writeFileSync(join(bin, 'pm2'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`);
    chmodSync(join(bin, 'pm2'), 0o755);
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
    writeFileSync(join(repo, 'ahead.txt'), 'ahead\n');
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

  return { scratch, repo, bin, calls, forceClean, releaseFile, nodeOptions, headSha, aheadSha, peerTarget };
}

// The three runs share no state, so they go out concurrently rather than
// serializing three full update scripts.
function runUpdate(sandbox, { onStart } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: `${sandbox.bin}:${process.env.PATH}` };
    if (sandbox.forceClean) env.PORTOS_FORCE_CLEAN_WORKSPACES = '.';
    if (sandbox.nodeOptions) env.NODE_OPTIONS = sandbox.nodeOptions;
    if (sandbox.peerTarget) {
      env.PORTOS_PEER_UPDATE_TARGET_SHA = sandbox.aheadSha;
      env.PORTOS_PEER_UPDATE_EXPECTED_SHA = sandbox.headSha;
    }
    const child = spawn('bash', [join(sandbox.repo, 'update.sh')], { cwd: sandbox.repo, env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', () => {});
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
  (existsSync(sandbox.calls) ? readFileSync(sandbox.calls, 'utf8') : '').split('\n').filter(Boolean);

describe.skipIf(process.platform === 'win32' || SKIP_HEAVY_INTEGRATION)('update.sh headless-install guard', () => {
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
      // Same, with a pull pending: the refusal must come before HEAD moves, on
      // both the upstream and the peer-target (ff-only merge) paths.
      oldNodeAhead: { nodeVersion: '22.12.0', origin: true, originAhead: true },
      oldNodePeer: { nodeVersion: '22.12.0', origin: true, originAhead: true, peerTarget: true },
      // The pre-pull archive gate passes, the pull lands, and only the post-pull
      // gate refuses: the checkout must be rolled back with apps untouched.
      postPullRefusal: { origin: true, originAhead: true, aheadRefusesInCheckout: true },
      cleanAhead: { nodeVersion: null, failAfterDelete: false, origin: true, originAhead: true },
      // The failure the guard's own comment names: both npm installs fail, and
      // safe_install wiped root node_modules — pm2 included — on the way.
      pm2Wiped: { npmShim: 'fail', forceClean: true, pm2OnPath: true }
    };
    await Promise.all(Object.entries(cases).map(async ([name, options]) => {
      sandboxes[name] = await makeSandbox(options);
    }));
    await Promise.all(Object.keys(cases).map(async (name) => {
      results[name] = await runUpdate(sandboxes[name]);
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

  it('restarts the apps when the update is killed during the delete itself', async () => {
    // Two guards at once: without the TERM/INT/HUP traps bash runs NO exit trap
    // for a fatal signal, and with the latch armed AFTER the delete the trap
    // would see it unset — bash only runs a pending trap between statements, so
    // a signal delivered while `pm2 delete` is still running lands here.
    const box = await makeSandbox({ stallDelete: true });
    try {
      const result = await runUpdate(box, {
        onStart: (child) => {
          waitForFile(box.releaseFile)
            .then(() => {
              child.kill('SIGTERM');
              rmSync(box.releaseFile, { force: true });
            })
            .catch(() => child.kill('SIGKILL'));
        }
      });
      const calls = pm2Calls(box);
      const deleteAt = calls.findIndex(c => c.startsWith('delete ecosystem.config.cjs'));
      const startAt = calls.findIndex(c => c.startsWith('start ecosystem.config.cjs'));
      expect(startAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(deleteAt);
      expect(result.status).toBe(143);
    } finally {
      await destroyGitSandbox(box.scratch);
    }
  }, 120000);

  it('refuses an unsupported Node runtime before stopping apps or installing', () => {
    const { status, stdout } = results.oldNode;
    expect(status).toBe(1);
    expect(stdout).toContain('STEP:runtime-preflight:failed:');
    expect(stdout).toContain('Node.js ^22.22.2');
    expect(stdout).not.toContain('STEP:pm2-stop:');
    expect(stdout).not.toContain('STEP:npm-install:');
    expect(pm2Calls(sandboxes.oldNode)).toEqual([]);
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

  it('never resets to an unknown pre-pull commit on the post-pull refusal path', () => {
    const sh = readFileSync(UPDATE_SH, 'utf8');
    const gate = sh.indexOf('node_gate_output=$(node scripts/checkNodeVersion.js');
    const exitAt = sh.indexOf('exit 1', gate);
    const refusal = sh.slice(gate, exitAt);
    expect(gate).toBeGreaterThan(-1);
    const guardAt = refusal.indexOf('[ -n "$pre_pull_sha" ]');
    expect(guardAt).toBeGreaterThan(-1);
    expect(refusal.indexOf('git reset --hard "$pre_pull_sha"')).toBeGreaterThan(guardAt);
    // Only the guarded branch may reset; the empty-sha branch must not.
    const emptyBranch = refusal.slice(refusal.lastIndexOf('else\n'));
    expect(emptyBranch).not.toContain('git reset');
    expect(refusal).not.toContain('git clean');
    expect(refusal).not.toMatch(/pm2/i);
  });

  it('still pulls and updates when the target supports the runtime', () => {
    const { repo, aheadSha } = sandboxes.cleanAhead;
    expect(results.cleanAhead.status, results.cleanAhead.stdout).toBe(0);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(aheadSha);
  });

  it('passes the runtime preflight on a supported runtime without changing the flow', () => {
    expect(results.clean.stdout).toContain('STEP:runtime-preflight:done:');
    expect(results.clean.stdout.indexOf('STEP:runtime-preflight:done:'))
      .toBeLessThan(results.clean.stdout.indexOf('STEP:pm2-stop:running:'));
  });

  it('does not touch PM2 when the update aborts before the delete', () => {
    expect(results.preDelete.status).not.toBe(0);
    expect(pm2Calls(sandboxes.preDelete)).toEqual([]);
  });
});

/**
 * update.ps1 is the Windows half of the same bracket and cannot be executed
 * here, so guard the invariant that makes its recovery reachable: PowerShell's
 * `exit` inside a function terminates the whole script WITHOUT raising a
 * terminating error, bypassing both Stop-UpdateScript and the script-scope trap.
 * So every fatal exit in the file must route through Stop-UpdateScript. Scanning
 * the whole file rather than the delete→start line window is the point: the
 * exit that actually caused this bug lives in Safe-Install, which is DEFINED
 * above the delete and CALLED below it.
 */
describe('update.ps1 headless-install guard', () => {
  const ps1 = readFileSync(join(REPO_ROOT, 'update.ps1'), 'utf8').split('\n');
  const lineOf = (needle) => ps1.findIndex(line => line.includes(needle));

  // The only two script-terminating exits that may bypass the recovery: the one
  // Stop-UpdateScript itself performs (after running it), and the final status.
  const SANCTIONED_EXITS = ['exit $Code', 'exit $verifyFailed'];

  it('routes every fatal exit through the recovery', () => {
    const exits = ps1
      .map((line, i) => ({ line: line.trim(), number: i + 1 }))
      .filter(({ line }) => /(^|[{;]\s*)exit\b/i.test(line) || /\[Environment\]::Exit\(/i.test(line));

    const offenders = exits.filter(({ line }) => !SANCTIONED_EXITS.includes(line));
    expect(offenders, `exit(s) bypassing Restore-Pm2Apps: ${JSON.stringify(offenders)}`).toEqual([]);
    // ...and both sanctioned exits must still be there, so the guard can't be
    // "satisfied" by deleting the exit inside Stop-UpdateScript.
    expect([...new Set(exits.map(e => e.line))].sort()).toEqual([...SANCTIONED_EXITS].sort());
  });

  it('keeps every Resolve-Pm2Command branch a plain array collected by @()', () => {
    // `return` ENUMERATES an array into the output stream, so a single-element
    // branch arrives as a bare string and `$pm2 + @('start', …)` concatenates
    // into one garbage token — the PATH fallback would never start pm2. The
    // call-site @() fixes that, but only if every branch returns a PLAIN array:
    // a `,@(…)` wrapper emits the array as ONE stream item and @() nests rather
    // than flattens it, so $CmdArgs[0] is an object[] instead of the executable.
    expect(ps1.some(line => line.includes('$pm2 = @(Resolve-Pm2Command)'))).toBe(true);

    const body = ps1.slice(lineOf('function Resolve-Pm2Command'), lineOf('function Restore-Pm2Apps'));
    const returns = body.map(line => line.trim()).filter(line => line.startsWith('return'));
    expect(returns.length).toBeGreaterThan(2);
    expect(returns.filter(line => /return\s*,/.test(line)), 'a ,@() return nests instead of flattening').toEqual([]);
    expect(returns.every(line => /^return\s+@\(/.test(line))).toBe(true);
  });

  it('runs the target Node gate before the PM2 delete and any install', () => {
    const gate = lineOf('if (Test-Path "scripts/checkNodeVersion.js")');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(lineOf('pm2 delete ecosystem.config.cjs --silent'));
    expect(gate).toBeLessThan(lineOf('Safe-Install -Dir "."'));
    expect(ps1.slice(gate, gate + 40).join('\n')).toContain('Stop-UpdateScript 1');
  });

  it('rolls the checkout back to $prePullSha before Stop-UpdateScript when the post-pull gate refuses', () => {
    const gate = lineOf('if (Test-Path "scripts/checkNodeVersion.js")');
    const stop = ps1.findIndex((line, i) => i > gate && line.includes('Stop-UpdateScript 1'));
    const block = ps1.slice(gate, stop + 1).join('\n');
    const guardAt = block.indexOf('if ($prePullSha) {');
    expect(guardAt).toBeGreaterThan(-1);
    const resetAt = block.indexOf('Invoke-Logged git reset --hard $prePullSha');
    expect(resetAt).toBeGreaterThan(guardAt);
    expect(resetAt).toBeLessThan(block.indexOf('Stop-UpdateScript 1'));
    expect(block).toContain('Invoke-Logged git submodule update --init --recursive');
    expect(block).not.toContain('git clean');
    // The reset sits inside the $prePullSha guard: nothing resets after it closes.
    expect(block.slice(block.indexOf('if ($rolledBack)'))).not.toContain('git reset');
  });

  it('evaluates the target Node gate from git archive before HEAD moves', () => {
    const archive = lineOf('git archive --output=$gateArchive $preflightTarget');
    expect(archive).toBeGreaterThan(-1);
    expect(archive).toBeLessThan(lineOf('Invoke-Logged git merge --ff-only'));
    expect(archive).toBeLessThan(lineOf('Invoke-Logged git pull --rebase'));
    expect(archive).toBeLessThan(lineOf('Step "submodules" "running"'));
    expect(ps1.slice(archive, archive + 25).join('\n')).toContain('Stop-UpdateScript 1');
  });

    it('arms the latch before the delete, not after', () => {
    const armed = lineOf('$script:Pm2AppsDown = $true');
    const deleted = lineOf('pm2 delete ecosystem.config.cjs --silent');
    expect(armed).toBeGreaterThan(-1);
    expect(armed).toBeLessThan(deleted);
  });

  it('defines the recovery before every call site that depends on it', () => {
    const definedAt = lineOf('function Stop-UpdateScript');
    expect(definedAt).toBeGreaterThan(-1);
    const firstCall = ps1.findIndex(line => line.includes('Stop-UpdateScript ') && !line.includes('function '));
    expect(firstCall).toBeGreaterThan(definedAt);
    expect(lineOf('function Restore-Pm2Apps')).toBeLessThan(lineOf('$script:Pm2AppsDown = $true'));
    expect(lineOf('trap {')).toBeLessThan(lineOf('$script:Pm2AppsDown = $true'));
  });
});
