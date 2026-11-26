/** Own pregate stage processes, including signal forwarding and verified process-group teardown. */
import { spawn, spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareWindowsSafeSpawn, resolveWindowsExecutable } from '../../server/lib/aiToolkit/internal/windowsSafeSpawn.js';
import { cosWorkerBudget, readMaxConcurrentAgents } from './cosWorkerBudget.js';

const IS_WIN32 = process.platform === 'win32';

/**
 * Env for a stage child: one worker budget, from the CoS max-concurrent-agents
 * setting (scripts/lib/cosWorkerBudget.js), shared by every Vitest workspace.
 */
let derivedWorkerBudget;
export function pregateWorkerEnv(env, primaryCheckout) {
  derivedWorkerBudget ??= String(cosWorkerBudget({ agents: readMaxConcurrentAgents(primaryCheckout) }));
  return { ...env, PORTOS_PREGATE_MAX_WORKERS: env.PORTOS_PREGATE_MAX_WORKERS || derivedWorkerBudget };
}

/**
 * The child environment for one stage. A stage value of `undefined` REMOVES
 * the variable (the DB stages drop `TEST_DB_OK` this way), which is the only
 * way an inherited escape hatch can be kept away from a runner.
 *
 * `ownsGroup` (POSIX, where each stage gets its own process group) tells
 * run-ci-tests.js to keep npm and Vitest in that group instead of detaching
 * them, so cancelling the stage group reaches every test process (#12641).
 */
export function stageSpawnEnv(baseEnv, stageEnv, { ownsGroup = !IS_WIN32 } = {}) {
  const env = { ...pregateWorkerEnv(baseEnv), ...(ownsGroup ? { PORTOS_CI_TEST_SUPERVISED_GROUP: '1' } : {}) };
  for (const [name, value] of Object.entries(stageEnv)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** Spawn target for a stage: a repo script under node, or npm itself. */
function stageSpawn(stage, env, repoRoot) {
  if (!stage.npm) return { command: process.execPath, args: [join(repoRoot, 'scripts', stage.script), ...stage.args] };
  // A bare `npm` is a `.cmd` shim on Windows; resolve and wrap it the way every
  // other npm spawn in this tree does (server/lib/bufferedSpawn.js).
  return prepareWindowsSafeSpawn(resolveWindowsExecutable('npm', IS_WIN32, env) || 'npm', stage.npm, IS_WIN32);
}

/** How long a cancelled stage may wind down before its whole group is killed. Exceeds run-ci-tests.js's own 2s npm escalation. */
const STAGE_CANCEL_GRACE_MS = 5000;
/** Bound on proving a killed stage group empty; past it the cancellation is reported unverified. */
const STAGE_SETTLE_MS = 5000;

/**
 * Owner signal handling for the whole stage loop. A Ctrl-C reaches pregate
 * twice — from the terminal's process group and again forwarded by `npm run`.
 * A handler that removed itself on the first restored the default action, so
 * the duplicate killed pregate before it signalled the stage group and the
 * detached runner kept testing (#12641). These handlers stay installed,
 * absorb duplicates, and are released only after every owned group settled.
 */
export function installOwnerCancellation() {
  const owner = { signal: null, onSignal: null };
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => {
      if (owner.signal) return;
      owner.signal = signal;
      owner.onSignal?.(signal);
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  owner.release = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  return owner;
}

function signalStage(child, signal) {
  try {
    if (IS_WIN32) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') writeSync(2, `❌ Stage cancellation failed: ${error.code ?? 'unknown'}.\n`);
  }
}

const within = (promise, ms) => {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Stop a stage and everything in its process group before pregate finishes:
 * forward the owner's signal, give the stage its grace to report, kill the
 * group if it is still running, then kill any member that outlived the
 * leader until the group no longer exists. Resolves `{ settled, reason? }`.
 */
async function cancelStage(stage, child, closed, signal) {
  writeSync(2, `❌ Pregate incomplete: stage="${stage.name}" owner_pid=${process.pid} child_pid=${child.pid ?? 'unavailable'} received_signal=${signal}.\n`);
  if (!child.pid) return { settled: true };
  signalStage(child, signal);
  if (!await within(closed, STAGE_CANCEL_GRACE_MS)) {
    writeSync(2, `⚠️ Stage "${stage.name}" outlived its ${STAGE_CANCEL_GRACE_MS / 1000}s cancellation grace; killing its process group.\n`);
    signalStage(child, 'SIGKILL');
    if (!await within(closed, STAGE_SETTLE_MS)) return { settled: false, reason: 'stage process did not exit after SIGKILL' };
  }
  return IS_WIN32 ? { settled: true } : sweepStageGroup(child.pid);
}

/** Bounded diagnostic only: ps is never evidence that an owned group is absent. */
function describeStageGroup(pgid, timeoutMs) {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: Math.min(1000, timeoutMs), maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return `unavailable (${result.error?.code ?? result.status ?? result.signal ?? 'unknown'})`;
  const members = result.stdout.split('\n').map(line => line.trim().split(/\s+/))
    .filter(([, group]) => Number(group) === pgid);
  // No command lines, arguments, identities, or unrelated processes in evidence.
  return members.slice(0, 16).map(([pid, , state]) => `${pid}:${state}`).join(',')
    + (members.length > 16 ? ',…' : '') || 'none observed';
}

/**
 * Kill whatever outlived a stage leader. Only ESRCH for the exact owned group
 * proves settlement. Darwin can return EPERM for an existing zombie-only
 * group (XNU killpg1 filters SZOMB); wait for reaping with read-only probes,
 * within the original deadline, rather than mistaking refusal for permission
 * trouble or treating zombies/ps output as proof of absence.
 */
export async function sweepStageGroup(pgid, {
  kill = process.kill, now = Date.now, wait = delay, inspect = describeStageGroup,
} = {}) {
  const deadline = now() + STAGE_SETTLE_MS;
  const membership = () => inspect(pgid, Math.max(1, deadline - now()));
  for (let attempt = 0; ; attempt += 1) {
    try {
      kill(-pgid, 'SIGKILL');
    } catch (error) {
      if (error.code === 'ESRCH') return { settled: true, lingered: attempt > 0 };
      const refusal = `group kill failed (${error.code ?? 'unknown'})`;
      if (error.code !== 'EPERM') return { settled: false, reason: `${refusal}; pgid=${pgid}; members=${membership()}` };
      let members;
      let lingered = attempt > 0;
      for (;;) {
        let probe = 'present';
        try {
          kill(-pgid, 0);
        } catch (probeError) {
          if (probeError.code === 'ESRCH') return { settled: true, lingered };
          probe = probeError.code ?? 'unknown';
        }
        lingered = true;
        members ??= membership();
        if (!['present', 'EPERM'].includes(probe) || now() >= deadline) {
          return { settled: false, reason: `${refusal}; pgid=${pgid}; probe=${probe}; members=${members}` };
        }
        await wait(Math.min(25, Math.max(0, deadline - now())));
      }
    }
    if (now() >= deadline) return { settled: false, reason: 'group members remained after SIGKILL' };
    await wait(25);
  }
}

/** Run one stage; an owner signal during it resolves only after the stage group settled. */
export async function runStage(stage, owner, repoRoot) {
  const env = stageSpawnEnv(process.env, stage.env);
  const { command, args } = stageSpawn(stage, env, repoRoot);
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
    // A separate group lets cancellation reach only this stage's descendants.
    detached: !IS_WIN32,
  });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  let cancellation = null;
  let interrupted = null;
  owner.onSignal = (signal) => {
    interrupted = signal;
    cancellation = cancelStage(stage, child, closed, signal);
  };
  const outcome = await closed;
  owner.onSignal = null;
  if (cancellation) return { ...outcome, pid: child.pid, interrupted, ...await cancellation };
  if (IS_WIN32 || !child.pid) return { ...outcome, pid: child.pid };
  const sweep = await sweepStageGroup(child.pid);
  if (sweep.lingered) writeSync(2, `⚠️ Stage "${stage.name}" exited before its process group settled; verified group exit.\n`);
  return { ...outcome, pid: child.pid, ...(sweep.settled ? {} : { unsettled: sweep.reason }) };
}
