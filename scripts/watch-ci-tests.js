#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { collectTestDiagnostics } from './ci-test-diagnostics.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { drainBrowserProcessGroup } from '../server/services/htmlComposition/browserProcessGroup.js';

// A separate event loop owns this deadline: a blocked launcher/test worker must
// not prevent evidence collection or termination. Whole-runner loss can still
// prevent both execution and delivery of these logs; that remains inconclusive.
export async function watchTests(scope, {
  env = process.env, deadlineMs = 12 * 60_000, progressMs = 60_000, graceMs = 5000, settleMs = 5000,
} = {}) {
  if (process.platform === 'win32') throw Error('Browser test supervision requires POSIX process groups.');
  if (!['server', 'client'].includes(scope)) throw Error('Expected a server or client test workspace.');
  const root = env.PORTOS_CI_DIAGNOSTICS_DIR;
  if (!root) throw Error('Browser test supervision requires durable diagnostics.');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./run-ci-tests.js', import.meta.url)), scope], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORTOS_CI_TEST_SUPERVISED_GROUP: '1' },
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const started = Date.now();
  let timedOut = false, interrupted = false, stopping, spawnError, closeResult, finish, leftovers = false;
  const completed = new Promise(resolve => { finish = resolve; });
  child.once('error', error => { spawnError = error; });
  child.once('close', (code, signal) => { closeResult = { code, signal }; finish({}); });
  let collecting;
  const collect = () => collecting ??= collectTestDiagnostics(root, {
    // Linux browser jobs have no Windows crash query. Keep periodic output
    // bounded and sanitized through the same durable collector as final failure.
    diagnose: async () => {}, writeSummary: () => {},
  }).finally(() => { collecting = undefined; });
  const stop = () => stopping ??= (async () => {
    console.error('CI test watchdog: collecting evidence before owned-runner shutdown.');
    await collect().catch(() => console.error('CI test watchdog: deadline evidence unavailable.'));
    // Let the launcher's existing interruption path settle first, then retire
    // its entire known-owned group even if that launcher's event loop is stuck.
    child.kill('SIGTERM');
    await delay(graceMs);
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    console.error('CI test watchdog: owned launcher group termination requested.');
    const until = Date.now() + settleMs;
    while (!closeResult) {
      if (Date.now() >= until) throw Error('Owned launcher close unverified after SIGKILL.');
      await delay(25);
    }
    await drainBrowserProcessGroup(child.pid, performance.now() + settleMs, Math.min(graceMs, settleMs / 2));
    console.error('CI test watchdog: owned launcher group stopped; independently detached browser groups remain unverified.');
    await collect();
  })();
  const requestStop = () => stop().catch(error => {
    // A refused signal or unresponsive OS cannot prove quiescence. Fail closed
    // with evidence; the workflow's outer deadline remains the final fallback.
    const code = ['EPERM', 'EACCES', 'EINVAL', 'ENOSYS'].includes(error.code) ? error.code : 'unavailable';
    console.error(`CI test watchdog: owned-runner settlement unverified; code=${code}; outer step cleanup still required.`);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    finish({ error });
  });
  const interrupt = () => { interrupted = true; requestStop(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const progress = setInterval(() => {
    console.log(`CI test watchdog: ${Math.floor((Date.now() - started) / 1000)}s elapsed; deadline=${deadlineMs / 1000}s.`);
    collect().catch(() => console.error('CI test watchdog: progress unavailable.'));
  }, progressMs);
  const deadline = setTimeout(() => {
    timedOut = true;
    console.error('CI test watchdog: subordinate deadline exceeded; this step will fail.');
    requestStop();
  }, deadlineMs);
  try {
    const { error } = await completed;
    if (error) throw error;
    if (!stopping && child.pid) {
      // Only a positively closed, retained group is eligible for this existing
      // numeric/state-only observer; it also detects stdio-detached leftovers.
      const state = { error: 'none' };
      await drainBrowserProcessGroup(child.pid, performance.now() + settleMs, Math.min(graceMs, settleMs / 2), state);
      if (state.term) {
        leftovers = true;
        console.error('CI test watchdog: launcher closed with inherited group members remaining; this step will fail.');
        console.error('CI test watchdog: owned launcher group stopped; independently detached browser groups remain unverified.');
      }
    }
    if (stopping) await stopping;
    if (spawnError) throw spawnError;
    return timedOut ? 124 : interrupted ? 143 : leftovers ? 1 : closeResult.code ?? 1;
  } finally {
    clearInterval(progress);
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await collecting?.catch(() => console.error('CI test watchdog: final progress unavailable.'));
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  try { process.exitCode = await watchTests(process.argv[2]); }
  catch { console.error('CI test watchdog failed; owned-runner settlement is unverified.'); process.exitCode = 1; }
}
