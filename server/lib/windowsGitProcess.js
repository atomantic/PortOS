import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from './childProcess.js';

const compilerKey = Symbol.for('portos.windowsGitSupervisor');
const startupPhases = new Set(['startup', 'compiler-setup', 'compiler-spawn', 'compiler-exit', 'compiler-timeout',
  'git-lookup', 'broker-spawn', 'broker-readiness', 'broker-exit', 'broker-transport', 'broker-protocol', 'native-launch']);
const spawnErrorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN']);

/** Only fixed categories and bounded numeric results may leave the startup boundary. */
export function windowsGitFailureMetadata(error) {
  if (!startupPhases.has(error?.startupPhase)) return {};
  const result = { startupPhase: error.startupPhase };
  if (error.startupPhase === 'compiler-exit' && Number.isInteger(error.compilerExitCode)
    && error.compilerExitCode >= -0x80000000 && error.compilerExitCode <= 0xffffffff) {
    result.compilerExitCode = error.compilerExitCode;
  }
  if (['compiler-spawn', 'broker-spawn'].includes(error.startupPhase) && spawnErrorCodes.has(error.spawnErrorCode)) {
    result.spawnErrorCode = error.spawnErrorCode;
  }
  return result;
}

// One private compiler result per Node process, including module reloads. Never
// execute a pre-existing cache binary, or compile into a checkout being mutated.
function supervisor() {
  let state = process[compilerKey];
  if (!state) {
    state = { active: new Set(), operations: new Set(), held: false, holdReasons: new Set(), closing: false };
    process[compilerKey] = state;
    state.ready = (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'portos-git-supervisor-'));
      state.directory = directory;
      const executable = join(directory, 'supervisor.exe');
      const source = join(directory, 'supervisor.cs');
      // Snapshot compiler input before asynchronous launch. The explicit read
      // also keeps native source bytes in the test memo's dependency keys.
      await writeFile(source, await readFile(new URL('./windowsGitSupervisor.cs', import.meta.url)));
      const { windowsPowerShell51Path, findCommandOnPath } = await import('./processEnv.js');
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const script = `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(source)} -ReferencedAssemblies System.Web.Extensions -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`;
      await new Promise((resolve, reject) => {
        let compiler;
        try {
          compiler = spawn(windowsPowerShell51Path(),
            ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: directory, stdio: 'ignore' });
        } catch (error) { reject(unavailable('compiler-spawn', { spawnErrorCode: error.code })); return; }
        const timer = setTimeout(() => {
          // Killing PowerShell is not proof its compiler descendants released
          // the private inputs. Keep that resource obligation through teardown.
          state.held = true;
          state.holdReasons.add('compiler-unconfirmed');
          try { compiler.kill(); } catch { /* report unavailable without launching Git */ }
          reject(unavailable('compiler-timeout'));
        }, 15000);
        compiler.once('error', error => { clearTimeout(timer); reject(unavailable('compiler-spawn', { spawnErrorCode: error.code })); });
        compiler.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(unavailable('compiler-exit', { compilerExitCode: code })); });
      });
      return { directory, executable, state, findCommandOnPath };
    })().catch(error => { throw unavailable(error?.startupPhase ?? 'compiler-setup', error); });
  }
  const exitKey = Symbol.for('portos.windowsGitSupervisorExit');
  if (!process[exitKey]) {
    process[exitKey] = true;
    process.once('exit', () => {
      const current = process[compilerKey];
      if (current?.directory && !current.broker && !current.active.size && !current.operations.size && !current.held) {
        try { rmSync(current.directory, { recursive: true, force: true }); } catch { /* preserve a locked resource */ }
      }
    });
  }
  // Vitest workers do not necessarily exit after a suite. Their existing
  // resource teardown invokes this without importing the Git dependency graph.
  globalThis.__portosGitSupervisorCleanup = () => {
    if (state.cleanup) return state.cleanup;
    state.cleanup = cleanupSupervisor(state).finally(() => { state.cleanup = null; });
    return state.cleanup;
  };
  return state.ready;
}

async function cleanupSupervisor(state) {
  state.closing = true;
  clearTimeout(state.idle);
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); });
  try {
    while (state.operations.size || state.active.size) {
      const pending = [...state.operations, ...[...state.active].map(child => child.gitSettlement)];
      const drained = await Promise.race([Promise.allSettled(pending).then(() => true), deadline]);
      if (!drained) throw held(new Set(['work-unconfirmed']));
    }
    await stopBroker(state);
    if (state.held) throw held(state.holdReasons);
    if (state.directory) await rm(state.directory, { recursive: true, force: true });
    if (process[compilerKey] === state) delete process[compilerKey];
    delete globalThis.__portosGitSupervisorCleanup;
  } finally { clearTimeout(timer); }
}

const unavailable = (startupPhase = 'startup', details = {}) => Object.assign(new Error('Windows Git containment unavailable'), {
  code: 'GIT_CONTAINMENT_UNAVAILABLE', ...windowsGitFailureMetadata({ ...details,
    startupPhase: startupPhases.has(startupPhase) ? startupPhase : 'startup' }),
});
const held = reasons => Object.assign(new Error('Git work settlement is held'), {
  code: 'GIT_SETTLEMENT_HELD', settlement: 'held', settlementReasons: [...reasons].sort(),
});

async function stopBroker(state) {
  if (state.stopping) return state.stopping;
  if (!state.broker) return;
  const broker = state.broker;
  state.stopping = (async () => {
    let timer;
    try {
      try { broker.process.stdin.end(); }
      catch {
        state.held = true;
        state.holdReasons.add('supervisor-unconfirmed');
        try { broker.process.kill(); } catch { /* retain the resource obligation */ }
        throw held(state.holdReasons);
      }
      const closed = await Promise.race([broker.closed.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
      if (!closed) {
        state.held = true;
        state.holdReasons.add('supervisor-unconfirmed');
        try { broker.process.kill(); } catch { /* retain the resource obligation */ }
        throw held(state.holdReasons);
      }
    } finally { clearTimeout(timer); state.stopping = null; }
  })();
  return state.stopping;
}

function idleBroker(state) {
  clearTimeout(state.idle);
  if (state.closing || state.operations.size || state.active.size) return;
  state.idle = setTimeout(() => { void stopBroker(state).catch(() => {}); }, 1000);
}

async function ensureBroker(state, executable, directory) {
  if (state.stopping) await state.stopping;
  if (state.broker) {
    if (state.broker.failed) throw state.broker.failure;
    return state.broker.ready;
  }
  let child;
  try { child = spawn(executable, [], { cwd: directory, stdio: ['pipe', 'pipe', 'ignore'], shell: false }); }
  catch (error) { throw unavailable('broker-spawn', { spawnErrorCode: error.code }); }
  const broker = { process: child, jobs: new Map() };
  state.broker = broker;
  let ready, rejectReady, closed;
  broker.ready = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
  broker.closed = new Promise(resolve => { closed = resolve; });
  const lost = failure => {
    broker.failed = true;
    broker.failure ||= failure;
    rejectReady(broker.failure);
    for (const finish of [...broker.jobs.values()]) finish({ settled: false, launched: true, exitCode: 1,
      reason: 'supervisor-unconfirmed', ...windowsGitFailureMetadata(broker.failure) });
  };
  const timer = setTimeout(() => {
    lost(unavailable('broker-readiness'));
    try { child.kill(); } catch { /* no Git request precedes readiness */ }
  }, 15000);
  child.once('error', error => lost(unavailable('broker-spawn', { spawnErrorCode: error.code })));
  child.once('close', () => {
    clearTimeout(timer);
    lost(unavailable('broker-exit'));
    if (state.broker === broker) state.broker = null;
    closed();
  });
  child.stdin.on('error', () => lost(unavailable('broker-transport')));
  let buffered = '';
  child.stdout.on('data', data => {
    try {
      buffered += data.toString('utf8');
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 24000) throw unavailable();
        const frame = JSON.parse(line);
        if (frame.kind === 'ready') { clearTimeout(timer); ready(broker); continue; }
        const finish = broker.jobs.get(frame.id);
        if (!finish) continue;
        if (frame.kind === 'data') {
          if (!['stdout', 'stderr'].includes(frame.channel) || typeof frame.data !== 'string'
            || frame.data.length > 21848 || frame.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw unavailable();
          finish.child[frame.channel].write(Buffer.from(frame.data, 'base64'));
        } else if (frame.kind === 'done') {
          if (typeof frame.settled !== 'boolean' || typeof frame.launched !== 'boolean'
            || !Number.isInteger(frame.exitCode) || frame.exitCode < 0 || frame.exitCode > 0xffffffff
            || !['settled', 'launch-failed', 'inspection-failed', 'termination-unconfirmed', 'pipes-unconfirmed'].includes(frame.reason)) throw unavailable();
          if (frame.settled ? frame.reason !== (frame.launched ? 'settled' : 'launch-failed')
            : !frame.launched || ['settled', 'launch-failed'].includes(frame.reason)) throw unavailable();
          finish(frame);
        } else throw unavailable();
      }
      if (buffered.length > 24000) throw unavailable();
    } catch {
      lost(unavailable('broker-protocol'));
      try { child.kill(); } catch { /* retain every affected job */ }
    }
  });
  return broker.ready;
}

/** Wire terminal listeners in the spawn tick, before sending the launch request. */
export function startGit(args, options, wire) {
  if (process.platform !== 'win32') { wire(spawn('git', args, options)); return; }
  const commandArgs = [...args];
  const childOptions = { ...options, cwd: resolvePath(options.cwd), env: { ...(options.env ?? process.env) } };
  const selectedEnv = {};
  const seen = new Set();
  for (const key of Object.keys(childOptions.env).sort()) {
    if (seen.has(key.toUpperCase())) continue;
    seen.add(key.toUpperCase());
    if (childOptions.env[key] === undefined) continue;
    const value = String(childOptions.env[key]);
    if (key.includes('\0') || value.includes('\0')) throw new TypeError('Git environment contains NUL bytes');
    selectedEnv[key] = value;
  }
  const inheritedPath = process.env.PATH || '';
  const ready = supervisor();
  const owner = process[compilerKey];
  clearTimeout(owner.idle);
  if (owner.closing) return Promise.reject(unavailable());
  const operation = ready.then(async ({ directory, executable, state, findCommandOnPath }) => {
    const env = selectedEnv;
    const pathKey = Object.keys(env).sort().find(key => key.toUpperCase() === 'PATH');
    // Match Node's Windows lookup fallback without adding ambient credentials
    // or PATH to the environment the caller explicitly selected for Git.
    const searchPath = pathKey === undefined || env[pathKey] === undefined
      ? inheritedPath : String(env[pathKey]);
    let gitExecutable;
    try { gitExecutable = findCommandOnPath('git.exe', { env: { PATH: `${childOptions.cwd};${searchPath}` }, cwd: childOptions.cwd }); }
    catch { throw unavailable('git-lookup'); }
    if (!gitExecutable) throw unavailable('git-lookup');
    const broker = await ensureBroker(state, executable, directory);
    const id = randomUUID();
    const child = new EventEmitter();
    child.gitSupervisor = true;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    state.active.add(child);
    child.cancelOwnedGit = child.kill = () => {
      broker.process.stdin.write(`${JSON.stringify({ action: 'cancel', id })}\n`);
      return true;
    };
    let resolveSettlement;
    child.gitSettlement = new Promise(resolve => { resolveSettlement = resolve; });
    const finish = Object.assign(result => {
      if (!broker.jobs.delete(id)) return;
      state.active.delete(child);
      state.held ||= !result.settled;
      if (!result.settled) state.holdReasons.add(result.reason);
      child.exitCode = result.exitCode;
      child.stdout.end(); child.stderr.end();
      resolveSettlement(result);
      child.emit('close', result.exitCode);
    }, { child });
    broker.jobs.set(id, finish);
    try { wire(child); }
    catch (error) { finish({ settled: true, launched: false, exitCode: 1, reason: 'launch-failed' }); throw error; }
    try {
      broker.process.stdin.write(`${JSON.stringify({ action: 'start', id, executable: gitExecutable,
        args: commandArgs, cwd: childOptions.cwd, env: selectedEnv })}\n`);
    } catch {
      finish({ settled: false, launched: true, exitCode: 1, reason: 'supervisor-unconfirmed', startupPhase: 'broker-transport' });
    }
    await child.gitSettlement;
  }).catch(error => { throw unavailable(error?.startupPhase, error); });
  owner.operations.add(operation);
  const finished = () => { owner.operations.delete(operation); idleBroker(owner); };
  void operation.then(finished, finished);
  return operation;
}
