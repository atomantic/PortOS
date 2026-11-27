#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyHash, npmConfigHash, readDependencyHashes, writeDependencyHashes } from './lib/dependencyReceipts.js';
import { dependencyWorkspaces, hasLinkedDependencies, inspectWorkspaceDependencies } from './lib/workspaceDependencies.js';
import { clearDependencyReconcilePending, pendingReconcilePath } from './lib/dependencyReconcile.js';
import { prepareWindowsSafeSpawn, resolveWindowsExecutable } from '../server/lib/aiToolkit/internal/windowsSafeSpawn.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
const updateId = process.env.PORTOS_DEFERRED_UPDATE_ID;
const peerId = process.env.PORTOS_PEER_UPDATE_OPERATION_ID;
const peerTarget = process.env.PORTOS_PEER_UPDATE_TARGET_SHA;
const peerExpected = process.env.PORTOS_PEER_UPDATE_EXPECTED_SHA;
const workspaces = dependencyWorkspaces(root);
const productionApps = 'portos-server,portos-cos,portos-autofixer,portos-browser';
const dataDir = join(root, 'data');
const updateLog = join(dataDir, 'update.log');
const marker = join(dataDir, 'update-complete.json');
const pendingReconcile = pendingReconcilePath(dataDir);
const pm2Local = [process.execPath, join(root, 'node_modules', 'pm2', 'bin', 'pm2')];
const pm2Start = ['start', 'ecosystem.config.cjs', '--only', productionApps];
const signals = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
let stopped = false;
let signalCode = 0;
let recovering = false;
let restartBlockedByRebase = false;
let logFd;
let entered = false;

process.stdout.on('error', error => { if (error.code !== 'EPIPE') process.exitCode = 1; });
function log(message = '') { if (!process.stdout.destroyed) process.stdout.write(message + '\n'); }
function step(name, status, message) { log(`STEP:${name}:${status}:${message}`); }
function fail(code = 1) { throw Object.assign(new Error('Update command failed'), { updateExitCode: code }); }
function checkSignal() { if (signalCode && !recovering) fail(signalCode); }

function run(command, args, { cwd = root, output = 'log', checkSignalAfter = true } = {}) {
  if (checkSignalAfter) checkSignal();
  const resolved = resolveWindowsExecutable(command, windows) || command;
  const launch = prepareWindowsSafeSpawn(resolved, args, windows);
  const stdio = output === 'inherit' ? 'inherit'
    : output === 'capture' ? ['ignore', 'pipe', 'pipe']
      : ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'];
  return new Promise(resolve => {
    const child = spawn(launch.command, launch.args, { cwd, stdio, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout?.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr?.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', failure => { error = failure; });
    child.on('close', (code, signal) => {
      if (error && logFd !== undefined) {
        try { appendFileSync(logFd, `${command}: ${error.message}\n`); } catch { /* preserve the spawn error */ }
      }
      resolve({ code: code ?? signals[signal] ?? 1, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
    });
  }).then(result => {
    if (checkSignalAfter) checkSignal();
    return result;
  });
}
const node = (file, ...args) => run(process.execPath, [file, ...args]);
const git = (...args) => run('git', args);
const capture = (command, args, options) => run(command, args, { ...options, output: 'capture' });
const required = async command => { const { code } = await command; if (code) fail(code); };

function executable(command) {
  if (windows) return Boolean(resolveWindowsExecutable(command, true));
  return (process.env.PATH || '').split(delimiter).some(dir => {
    try { accessSync(join(dir || '.', command), constants.X_OK); return true; } catch { return false; }
  });
}

function pm2RecoveryCommand() {
  if (existsSync(pm2Local[1])) return pm2Local;
  if (executable('pm2')) return ['pm2'];
  let pin;
  try { pin = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies?.pm2; } catch { /* default pinless fallback */ }
  return ['npx', '--yes', typeof pin === 'string' && pin ? `pm2@${pin}` : 'pm2'];
}
const pm2 = (...args) => run(pm2Local[0], [...pm2Local.slice(1), ...args]);

async function recover(code) {
  if (!stopped) return;
  stopped = false;
  if (restartBlockedByRebase) {
    step('restart', 'error', 'Restore the checkout before restarting PortOS');
    return;
  }
  const [command, ...prefix] = pm2RecoveryCommand();
  log(`⚠️  Update is exiting (status ${code}) with PortOS's apps deleted — restarting them so the install isn't left headless.`);
  step('restart', 'running', "Update failed — restarting PortOS so it isn't left down...");
  if (!(await run(command, [...prefix, ...pm2Start])).code && !(await node('scripts/verify-server-health.js')).code) {
    await run(command, [...prefix, 'save']);
    step('restart', 'warning', 'Update failed, but PortOS was restarted');
    log('✅ PortOS is answering /api/system/health again after the failed update.');
  } else {
    step('restart', 'error', 'Update failed and PortOS is DOWN');
    log('❌ PortOS is not answering /api/system/health.');
    log(`    Recover with: ${[command, ...prefix, ...pm2Start].join(' ')}`);
  }
}

async function stopApps() {
  if (stopped) return;
  step('pm2-stop', 'running', 'Stopping PortOS apps...');
  // Arm before the first delete. Await its settlement before restarting so a
  // late delete cannot remove a process that the recovery just brought back.
  stopped = true;
  await pm2('delete', 'ecosystem.config.cjs', '--silent');
  await pm2('delete', 'portos-ui', '--silent');
  await pm2('delete', 'portos-autofixer-ui', '--silent');
  step('pm2-stop', 'done', 'Apps stopped');
  log();
}

async function syncSubmodules() {
  return (await git('submodule', 'sync', '--recursive')).code
    || (await git('submodule', 'update', '--init', '--recursive')).code;
}

async function repairStaleSubmodules() {
  const { stdout } = await capture('git', ['submodule', 'status', '--recursive']);
  if (!/^[+U-]/m.test(stdout)) return;
  log("🔧 Repairing submodules that are not at the parent checkout's pinned commits...");
  if (await syncSubmodules()) {
    step('git-pull', 'failed', 'Pinned submodule checkout could not be synchronized');
    fail();
  }
}

async function preflight(target) {
  const has = async path => !(await capture('git', ['cat-file', '-e', `${target}:${path}`])).code;
  if (!target || !await has('scripts/checkNodeVersion.js')) return;
  const paths = ['scripts/checkNodeVersion.js'];
  for (const optional of ['package.json', 'scripts/lib']) if (await has(optional)) paths.push(optional);
  const scratch = mkdtempSync(join(tmpdir(), 'portos-node-gate-'));
  const archive = join(scratch, 'gate.tar');
  try {
    if ((await git('archive', `--output=${archive}`, target, ...paths)).code
      || (await run(windows ? 'tar.exe' : 'tar', ['-xf', archive, '-C', scratch])).code) return;
    const out = await capture(process.execPath, ['scripts/checkNodeVersion.js'], { cwd: scratch });
    if (!out.code) return;
    log([out.stdout, out.stderr].filter(Boolean).join('\n'));
    log('❌ Update stopped: upgrade Node.js, then re-run the update. The checkout was left unchanged.');
    step('runtime-preflight', 'failed', 'Unsupported Node.js runtime for the target revision; checkout unchanged');
    fail();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function pullRebasePaths() {
  const { code, stdout } = await capture('git', ['rev-parse', '--path-format=absolute',
    '--git-path', 'REBASE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply']);
  if (code) {
    step('git-pull', 'failed', 'Unable to locate Git rebase state');
    fail(code);
  }
  const paths = stdout.split(/\r?\n/);
  if (paths.some(path => existsSync(path))) {
    restartBlockedByRebase = true;
    step('git-pull', 'failed', 'An existing rebase or patch application must be resolved before updating');
    fail();
  }
  return paths;
}

async function pull() {
  step('git-pull', 'running', 'Pulling latest changes...');
  const rebasePaths = peerTarget ? [] : await pullRebasePaths();
  const origin = (await capture('git', ['remote', 'get-url', 'origin'])).stdout;
  if (origin) {
    const safe = `🌐 Pulling from origin: ${origin.replace(/:\/\/[^@/]+@/, '://***@')}`;
    log(safe);
    appendFileSync(logFd, safe + '\n');
  }
  // Best effort, before git takes the next index/submodule lock.
  await node('-e', "import('./server/lib/gitStaleLock.js').then(m => m.clearStaleGitLocksIn('.git')).catch(() => {})");
  const branch = (await capture('git', ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout;
  await repairStaleSubmodules();
  if ((await git('diff', '--quiet')).code || (await git('diff', '--cached', '--quiet')).code
    || (await capture('git', ['ls-files', '--others', '--exclude-standard'])).stdout) {
    log('❌ Refusing update: checkout has uncommitted changes; commit or restore them first');
    step('git-pull', 'failed', 'Checkout is dirty; no stash was created');
    fail();
  }
  const head = async () => (await capture('git', ['rev-parse', 'HEAD'])).stdout;
  if (peerTarget && (!/^[a-f0-9]{40}$/.test(peerTarget) || !/^[a-f0-9]{40}$/.test(peerExpected || '')
    || branch !== 'main' || await head() !== peerExpected)) {
    step('git-pull', 'failed', 'Peer update evidence changed');
    fail();
  }
  if (branch !== 'main') {
    log(`⚠️  On branch '${branch || 'detached HEAD'}' — switching to main for update`);
    await required(git('checkout', 'main'));
  }
  await repairStaleSubmodules();
  if (!peerTarget) await git('fetch');
  await preflight(peerTarget || (await capture('git', ['rev-parse', '-q', '--verify', '@{upstream}^{commit}'])).stdout);
  const previous = await head();
  if (peerTarget) await required(git('merge', '--ff-only', peerTarget));
  else {
    // Inspect Git's result and finish any rollback before handling a signal.
    const { code } = await run('git', ['pull', '--rebase'], { checkSignalAfter: false });
    if (code) {
      let message = 'Pull failed; see the update log';
      if (rebasePaths.some(path => existsSync(path))) {
        restartBlockedByRebase = true;
        const abort = await run('git', ['rebase', '--abort'], { checkSignalAfter: false });
        if (abort.code) {
          log(`❌ git rebase --abort failed (status ${abort.code}); see the update log`);
          message = 'Pull conflicted; rebase abort failed';
        } else {
          restartBlockedByRebase = false;
          message = 'Pull conflicted; rebase aborted and checkout restored';
        }
      }
      step('git-pull', 'failed', message);
      fail(code);
    }
    checkSignal();
  }
  step('git-pull', 'done', 'Latest changes pulled');
  return previous;
}

async function checkPulledNode(previous) {
  step('runtime-preflight', 'running', 'Checking Node.js against the updated requirements...');
  if (existsSync(join(root, 'scripts', 'checkNodeVersion.js'))) {
    const out = await capture(process.execPath, ['scripts/checkNodeVersion.js']);
    if (out.code) {
      log([out.stdout, out.stderr].filter(Boolean).join('\n'));
      if (previous && !(await git('cat-file', '-e', `${previous}^{commit}`)).code) {
        if (!(await git('reset', '--hard', previous)).code && !await syncSubmodules()) {
          log('❌ Update stopped: upgrade Node.js, then re-run the update. The checkout was rolled back to the pre-pull revision.');
          step('runtime-preflight', 'failed', 'Unsupported Node.js runtime; checkout rolled back');
        } else {
          log(`❌ Could not roll back to ${previous}. Restore it and its pinned submodules before restarting PortOS.`);
          step('runtime-preflight', 'failed', 'Unsupported Node.js runtime; checkout rollback failed');
        }
      } else {
        log('❌ Update stopped: no pre-pull commit was recorded to roll back to.');
        step('runtime-preflight', 'failed', 'Unsupported Node.js runtime; update stopped');
      }
      fail();
    }
  }
  step('runtime-preflight', 'done', 'Node.js runtime supported');
}

// Lockfiles recorded by ensureLatest() when a fast-forward moved locks but
// left previous === HEAD, so `git diff` cannot see them (#17511, #17606).
function pendingReconcileLockfiles() {
  try {
    const { lockfiles } = JSON.parse(readFileSync(pendingReconcile, 'utf8'));
    if (Array.isArray(lockfiles) && lockfiles.every(path => typeof path === 'string' && path.length)) return lockfiles;
    return null;
  } catch (error) {
    return error.code === 'ENOENT' ? [] : null;
  }
}

async function install(previous) {
  step('npm-install', 'running', 'Checking workspace dependencies...');
  const diff = previous && await capture('git', ['diff', '--name-only', '--no-renames', '-z', previous, 'HEAD']);
  const pending = pendingReconcileLockfiles();
  const known = diff?.code === 0 && pending !== null;
  const changed = new Set(known ? diff.stdout.split('\0').filter(Boolean) : []);
  // A fast-forward reconcile can leave an empty diff (previous === HEAD).
  for (const lockfile of pending ?? []) changed.add(lockfile.replaceAll('\\', '/'));
  const forced = new Set((process.env.PORTOS_FORCE_CLEAN_WORKSPACES || '').split(',').filter(Boolean));
  const hashes = readDependencyHashes(root);
  const vite = join(root, 'client/node_modules/vite/bin/vite.js');
  let installed = 0;
  for (const workspace of workspaces) {
    const { dir: cwd, label } = workspace;
    const key = label === 'root' ? '.' : label;
    const inputs = ['package.json', 'package-lock.json', '.npmrc']
      .filter(file => changed.has(label === 'root' ? file : `${label}/${file}`));
    const hash = dependencyHash(cwd);
    const config = npmConfigHash(cwd);
    const recordedConfig = hashes.npmrc[label];
    const configChanged = recordedConfig !== undefined && recordedConfig !== config;
    const receiptMatches = hash !== null && hashes[label] === hash && (recordedConfig ?? null) === config;
    const clean = () => rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
    let reason;
    if (!known) reason = 'dependency baseline unknown';
    else if (inputs.length) reason = `${inputs.join(' and ')} changed`;
    else if (forced.has(key)) reason = 'clean reinstall forced';
    else if (configChanged || (hashes[label] != null && hashes[label] !== hash)) reason = 'dependency receipt changed';
    else if (receiptMatches) {
      const { issues } = inspectWorkspaceDependencies(workspace);
      if (!issues.length && (label !== 'client' || existsSync(vite))) {
        log(`✅ Reusing verified deps (${label})`);
        continue;
      }
      reason = 'installed dependency tree could not be verified';
    }
    if (reason) {
      log(`🧹 ${label} ${reason} in this update — clean reinstall (wiping node_modules)`);
      clean();
    }
    installed++;
    log(`📦 Installing deps (${label})...`);
    const npmInstall = () => run('npm', ['install', '--no-save'], { cwd });
    if ((await npmInstall()).code) {
      log(`⚠️  npm install failed for ${label} — cleaning node_modules and retrying...`);
      clean();
      if ((await npmInstall()).code) {
        log(`❌ npm install failed for ${label} after retry`);
        fail();
      }
    }
  }
  log('🔧 Rebuilding trusted native dependencies...');
  await required(node('scripts/trusted-rebuilds.js', 'server'));
  if (!existsSync(vite)) {
    log('❌ Critical dependency missing: client/node_modules/vite. Try npm run install:all.');
    fail();
  }
  // Preserve pending repair evidence until the install receipts are in place.
  writeDependencyHashes(root);
  clearDependencyReconcilePending(dataDir);
  step('npm-install', 'done', installed ? `Dependencies installed in ${installed} of ${workspaces.length} workspaces` : 'Verified existing workspace dependencies');
}

async function prepareData() {
  step('setup', 'running', 'Running setup...');
  for (const script of ['setup-data.js', 'setup-db.js', 'setup-browser.js']) await required(node(`scripts/${script}`));
  await node('scripts/setup-ghostty.js');
  step('setup', 'done', 'Setup complete');
  step('network-setup', 'running', 'Checking Tailscale, MagicDNS, and HTTPS...');
  await required(node('scripts/setup-cert.js'));
  const summary = await capture(process.execPath, ['scripts/setup-guide.js', '--summary']);
  if (summary.stderr) appendFileSync(logFd, summary.stderr + '\n');
  step('network-setup', 'done', summary.stdout.replace(/\r?\n/g, ' ') || 'Network setup checked');
  step('ffmpeg', 'running', 'Checking ffmpeg...');
  const ffmpegPresent = executable('ffmpeg');
  if (windows || !ffmpegPresent) await node('scripts/ensure-ffmpeg.js', '--non-interactive');
  step('ffmpeg', 'done', executable('ffmpeg') ? (!windows && !ffmpegPresent ? 'ffmpeg installed' : 'ffmpeg present')
    : 'ffmpeg unavailable (media/video features degraded)');
  const python = join(homedir(), '.portos', 'venv-muscriptor', 'bin', 'python3');
  let hasMuscriptor = false;
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    try { accessSync(python, constants.X_OK); hasMuscriptor = true; } catch { /* the runtime is opt-in */ }
  }
  if (hasMuscriptor && (await run(python, ['scripts/ml/transcribe_muscriptor.py', '--check-runtime'])).code) {
    step('muscriptor', 'running', 'Refreshing the MuScriptor MIDI runtime...');
    const pip = await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--require-hashes', '--no-deps',
      '-r', 'scripts/ml/requirements/requirements-muscriptor-mlx.lock.txt']);
    const refreshed = !pip.code && !(await run(python, ['scripts/ml/transcribe_muscriptor.py', '--check-runtime'])).code;
    step('muscriptor', 'done', refreshed ? 'MuScriptor MIDI runtime refreshed' : 'MuScriptor refresh failed (see update log for the repair command)');
  }
  step('migrations', 'running', 'Running data migrations...');
  if (existsSync(join(root, 'scripts/run-migrations.js'))) await required(node('scripts/run-migrations.js'));
  step('migrations', 'done', 'Migrations complete');
  step('slash-do', 'running', 'Installing/updating slash-do commands...');
  await node('scripts/install-slashdo.js');
  step('slash-do', 'done', 'slash-do commands installed/updated');
  step('build', 'running', 'Building client...');
  await required(run('npm', ['run', 'build']));
  step('build', 'done', 'Client built');
}

async function restart() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = typeof pkg.version === 'string' && pkg.version.trim();
  if (!version) { log('❌ Failed to determine package version from package.json'); fail(); }
  const temporary = marker + '.tmp';
  writeFileSync(temporary, JSON.stringify({ version, completedAt: new Date().toISOString() }));
  renameSync(temporary, marker);
  step('restart', 'running', 'Starting PortOS...');
  try {
    if (!(await node('scripts/pm2-daemon-refresh.js')).code) await pm2('update');
    await pm2('delete', 'ecosystem.config.cjs', '--silent');
    await pm2('delete', 'portos-ui', '--silent');
    await pm2('delete', 'portos-autofixer-ui', '--silent');
    const { code } = await pm2(...pm2Start);
    if (code) fail(windows ? code : 1);
  } catch (error) {
    rmSync(marker, { force: true });
    throw error;
  }
  stopped = false;
  await pm2('save');
  step('restart', 'done', 'PortOS started');

  step('verify', 'running', 'Verifying PortOS came back...');
  if (!(await node('scripts/verify-server-health.js')).code) {
    step('verify', 'done', 'PortOS is answering /api/system/health');
    return 0;
  }
  log('⚠️  PortOS did not answer /api/system/health after the restart — re-running pm2 start');
  await pm2(...pm2Start);
  if (!(await node('scripts/verify-server-health.js')).code) {
    step('verify', 'done', 'PortOS recovered after a second pm2 start');
    log('✅ PortOS recovered after a second pm2 start');
    return 0;
  }
  step('verify', 'warning', 'PortOS is not answering /api/system/health');
  log('❌ PortOS is STILL not answering /api/system/health.');
  log(`    Recover with: ${[...pm2Local, ...pm2Start].join(' ')}`);
  return 1;
}

const supervisor = (args, options) => run(process.execPath, ['scripts/deferred-update.mjs', ...args], { output: 'inherit', ...options });

async function main() {
  if (!peerId && !updateId) return (await supervisor(process.argv.slice(2))).code;
  if (peerId) await required(supervisor(['--peer-enter', peerId]));
  else {
    // If a signal arrives while admission is publishing our PID, first learn
    // whether it committed. A committed admission always needs a terminal row.
    checkSignal();
    await required(supervisor(['--enter', updateId, String(process.pid)], { checkSignalAfter: false }));
    entered = true;
    checkSignal();
  }
  mkdirSync(dataDir, { recursive: true });
  logFd = openSync(updateLog, 'w');
  log('===================================\n  PortOS Update\n===================================\n');
  // Do not let npm repair a CoS worktree whose dependencies are symlinked to a
  // live checkout, even when no manifest changed and no clean install is due.
  if (workspaces.some(({ dir }) => hasLinkedDependencies(dir))) {
    log('❌ Refusing update: node_modules is linked to another checkout.');
    fail();
  }
  if (process.env.PORTOS_UPDATE_STOP_FIRST === '1' || process.env.PORTOS_UPDATE_INTERRUPT === '1') {
    await stopApps();
    await required(supervisor(['--stopped', updateId || '']));
  }
  const previous = await pull();
  step('submodules', 'running', 'Synchronizing and updating submodules...');
  const submoduleStatus = await syncSubmodules();
  if (submoduleStatus) fail(submoduleStatus);
  step('submodules', 'done', 'Submodules updated');
  await checkPulledNode(previous);
  await stopApps();
  await install(previous);
  await prepareData();
  const outcome = await restart();
  await node('scripts/open-ui-in-browser.js');
  log(`===================================\n  ${outcome ? '⚠️  Update applied, but PortOS is DOWN' : '✅ Update Complete!'}\n===================================\n`);
  for (const args of [['scripts/print-access-url.js'], ['scripts/setup-guide.js', '--assume-active']]) {
    const { stdout } = await capture(process.execPath, args);
    if (stdout) log(stdout + '\n');
  }
  return outcome;
}

for (const [signal, code] of Object.entries(signals)) process.on(signal, () => { signalCode ||= code; });
let result = 1;
try {
  result = await main();
} catch (error) {
  result = error.updateExitCode || 1;
  if (!error.updateExitCode) log(`❌ Update stopped: ${error.message}`);
} finally {
  recovering = true;
  result = signalCode || result;
  try { if (stopped) await recover(result || 1); }
  catch (error) { log(`❌ PortOS restart attempt failed: ${error.message}`); }
  if (entered) {
    const terminal = await supervisor(['--terminal', updateId, String(process.pid), String(result)]).catch(() => ({ code: 1 }));
    if (terminal.code && !result) result = terminal.code;
  }
  if (logFd !== undefined) closeSync(logFd);
}
process.exitCode = result;
