// Lifecycle-specific suite; durable admission has its own subprocess contract.
vi.mock('./databaseWriterRegistry.js', () => ({ reserveDatabaseWriter: () => ({
  assertLaunchAllowed() {}, launched() {}, completed() {},
}) }));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';
import { spawnDetached } from './detachedSpawn.js';

const moduleUrl = new URL('./databaseMaintenanceJournal.js', import.meta.url).href;
const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
// Each launch pays a cold PowerShell supervisor start on Windows; on a loaded
// CI worker that alone can outlast the 10s production PID deadline (#8994,
// same budget as the detachedSpawn.test.js real-process fixtures, #8612).
// Test-only: production keeps its default, and a PID timeout still errors.
const COLD_START_PID_TIMEOUT_MS = 30_000;
// PID budget + the worker's ready wait + the rest of the scenario.
const WORKER_TEST_TIMEOUT_MS = 70_000;
let root;
let data;
let journal;
let children;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'portos-coordinator-'));
  data = join(root, 'data');
  writeFileSync(join(root, '.portos-disposable-root'), '');
  journal = createDatabaseMaintenanceJournal(data);
  children = [];
});
afterEach(async () => {
  for (const child of children) {
    if (!child.finished) child.handle.kill('SIGKILL');
    await child.done;
  }
  rmSync(root, { recursive: true, force: true });
});

async function launchWorker(operation, token, stage = 'importing') {
  const controlDir = journal.reserveCoordinatorWorker(operation.id, token);
  const script = join(root, `worker-${token}.mjs`);
  writeFileSync(script, `import {writeFileSync, existsSync} from 'node:fs';
    import {setTimeout} from 'node:timers/promises';
    import {createDatabaseMaintenanceJournal} from ${JSON.stringify(moduleUrl)};
    const journal=createDatabaseMaintenanceJournal(${JSON.stringify(data)});
    const stages=['accepted','quiescing','exporting','importing'];
    while(journal.read().stage!==${JSON.stringify(stage)}) {
      const current=journal.read().stage;
      journal.transition(${JSON.stringify(operation.id)},${JSON.stringify(token)},current,stages[stages.indexOf(current)+1]);
    }
    writeFileSync(${JSON.stringify(join(controlDir, 'ready'))},'ready');
    while(!existsSync(${JSON.stringify(join(controlDir, 'finish'))})) await setTimeout(20);
    process.exitCode=17;
  `);
  const env = { ...process.env, PORTOS_DATA_ROOT: root, NODE_ENV: 'test' };
  delete env.VITEST;
  const handle = await spawnDetached(process.execPath, [script], {
    env, controlDir, cleanup: false, pollMs: 25, pidTimeoutMs: COLD_START_PID_TIMEOUT_MS,
  });
  const child = { handle, finished: false };
  child.done = new Promise((resolve, reject) => {
    handle.once('close', (code, signal) => { child.finished = true; resolve({ code, signal }); });
    handle.once('error', err => { child.finished = true; reject(err); });
  });
  // Attach a rejection observer immediately; teardown still awaits the result.
  child.done.catch(() => {});
  children.push(child);
  // A failed launch rejects with the supervisor diagnostic; surface that rather
  // than a missing-ready-file timeout.
  if (handle.pid === null) await child.done;
  await vi.waitFor(() => expect(readFileSync(join(controlDir, 'ready'), 'utf8')).toBe('ready'), { timeout: 20_000 });
  return { ...child, controlDir };
}

function recoveryProcess(operation, token, recoveryToken = randomUUID(), crashAfterPublication = false) {
  const code = `import {createDatabaseMaintenanceJournal} from ${JSON.stringify(moduleUrl)};
    try {const token = createDatabaseMaintenanceJournal(${JSON.stringify(data)}).recoverCoordinator(${JSON.stringify(operation.id)},${JSON.stringify(token)},${JSON.stringify(recoveryToken)});
      if (${crashAfterPublication}) process.exit(7); console.log(token);}
    catch {process.exitCode=1;}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, token: stdout.trim() }));
  });
}

describe('same-operation coordinator recovery', () => {
  it.each([[source, target], [target, source]])('recovers an exited detached worker without changing direction, stage, or admission', async (from, to) => {
    const operation = journal.begin({ source: from, target: to });
    const token = journal.acquireCoordinator(operation.id);
    const worker = await launchWorker(operation, token);
    // A paused import is not a recoverable dead owner, however old its PID or
    // timestamps appear. Only the supervisor's completed exit receipt counts.
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'awaiting-exit' });
    expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
    expect(() => journal.reserveCoordinatorWorker(operation.id, token)).toThrow();
    expect(() => journal.assertAdmission()).toThrow();
    writeFileSync(join(worker.controlDir, 'finish'), '');
    expect(await worker.done).toEqual({ code: 17, signal: null });
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'exited', exitCode: 17 });

    const outcomes = await Promise.all([recoveryProcess(operation, token), recoveryProcess(operation, token)]);
    expect(outcomes.map(item => item.status).sort()).toEqual([0, 1]);
    const successor = outcomes.find(item => item.status === 0).token;
    expect(successor).not.toBe(token);
    expect(journal.read()).toEqual({ ...operation, stage: 'importing' });
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'unregistered' });
    expect(() => journal.transition(operation.id, token, 'importing', 'committing')).toThrow();
    expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
    expect(() => journal.begin({ source: to, target: from })).toThrow();
    expect(() => journal.cancel(operation.id, from)).toThrow();
    expect(() => journal.assertAdmission()).toThrow();
    // Original supervisor evidence is retained, never truncated for a retry.
    expect(readFileSync(join(worker.controlDir, 'exit'), 'utf8').trim()).toBe('17');
    const nextDirectory = journal.reserveCoordinatorWorker(operation.id, successor);
    expect(nextDirectory).not.toBe(worker.controlDir);
    // No worker was launched into the new reservation; recovery cannot invent
    // success from a missing/dead PID, even on repeated attempts.
    writeFileSync(join(nextDirectory, 'pid'), '2147483647');
    expect(() => journal.recoverCoordinator(operation.id, successor, randomUUID())).toThrow();
  }, WORKER_TEST_TIMEOUT_MS);

  it('recovers a killed worker only after its supervisor acknowledges exit', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const worker = await launchWorker(operation, token, 'exporting');
    worker.handle.kill('SIGKILL');
    await worker.done;
    const next = journal.recoverCoordinator(operation.id, token, randomUUID());
    expect(next).not.toBe(token);
    expect(journal.read()).toEqual({ ...operation, stage: 'exporting' });
    expect(() => journal.assertAdmission()).toThrow();
  }, WORKER_TEST_TIMEOUT_MS);

  it('recovers a published ownership handoff after its caller crashes before receiving the result', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const worker = await launchWorker(operation, token, 'exporting');
    writeFileSync(join(worker.controlDir, 'finish'), '');
    await worker.done;
    // This request identity is recorded BEFORE launching the recovery process.
    const recoveryToken = randomUUID();
    writeFileSync(join(root, 'recovery-request.json'), JSON.stringify({ id: operation.id, previousToken: token, recoveryToken }));
    expect(await recoveryProcess(operation, token, recoveryToken, true)).toEqual({ status: 7, token: '' });
    const request = JSON.parse(readFileSync(join(root, 'recovery-request.json'), 'utf8'));
    const retry = await recoveryProcess(operation, request.previousToken, request.recoveryToken);
    expect(retry).toEqual({ status: 0, token: recoveryToken });
    expect((await recoveryProcess(operation, token)).status).toBe(1);
    expect(journal.read()).toEqual({ ...operation, stage: 'exporting' });
    journal.reserveCoordinatorWorker(operation.id, retry.token);
    expect(() => journal.reserveCoordinatorWorker(operation.id, retry.token)).toThrow();
    expect(() => journal.assertAdmission()).toThrow();
  }, WORKER_TEST_TIMEOUT_MS);

  it('refuses absent, partial, foreign, or damaged completion evidence and preserves the fence', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
    const controlDir = journal.reserveCoordinatorWorker(operation.id, token);
    for (const value of ['', 'success', '0 trailing', '99999999999', '1\n0']) {
      writeFileSync(join(controlDir, 'exit'), value);
      expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
    }
    writeFileSync(join(controlDir, 'exit'), '0\n');
    writeFileSync(join(controlDir, 'owner.json'), JSON.stringify({ id: operation.id, token: '00000000-0000-4000-8000-000000000000' }));
    expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
    expect(journal.read()).toEqual(operation);
    expect(() => journal.assertAdmission()).toThrow();
  });

  it.each(['before-decision', 'before-stage-publication'])('serializes recovery against a paused predecessor (%s)', async barrier => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const directory = journal.reserveCoordinatorWorker(operation.id, token);
    writeFileSync(join(directory, 'exit'), '0');
    const ready = join(root, 'transition-ready');
    const release = join(root, 'transition-release');
    const method = barrier === 'before-decision' ? 'openSync' : 'linkSync';
    const pathIndex = barrier === 'before-decision' ? 0 : 1;
    const match = barrier === 'before-decision' ? "path.includes('decision-') && path.endsWith('.pending')" : "path.endsWith('published-quiescing.json')";
    const code = `import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original=fs[${JSON.stringify(method)}];
      let paused=false;
      fs[${JSON.stringify(method)}]=(...args)=>{
        const path=String(args[${pathIndex}]);
        if(!paused && (${match})) {
          paused=true; fs.writeFileSync(${JSON.stringify(ready)},'ready');
          while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
        }
        return original(...args);
      };
      syncBuiltinESMExports();
      const {createDatabaseMaintenanceJournal}=await import(${JSON.stringify(moduleUrl)});
      try {createDatabaseMaintenanceJournal(${JSON.stringify(data)}).transition(${JSON.stringify(operation.id)},${JSON.stringify(token)},'accepted','quiescing');}
      catch {process.exitCode=1;}`;
    const handle = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    const child = { handle, finished: false };
    child.done = new Promise(resolve => handle.once('close', status => { child.finished = true; resolve(status); }));
    children.push(child);
    await vi.waitFor(() => expect(readFileSync(ready, 'utf8')).toBe('ready'), { timeout: 20_000 });
    const next = journal.recoverCoordinator(operation.id, token, randomUUID());
    writeFileSync(release, '');
    expect(await child.done).toBe(barrier === 'before-decision' ? 1 : 0);
    expect(journal.read()).toEqual({ ...operation, stage: barrier === 'before-decision' ? 'accepted' : 'quiescing' });
    expect(() => journal.transition(operation.id, token, 'quiescing', 'exporting')).toThrow();
    expect(journal.reserveCoordinatorWorker(operation.id, next)).not.toBe(directory);
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('keeps a crashed unpublished worker reservation retryable by the same owner', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const code = `import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original=fs.renameSync;
      fs.renameSync=(from,to)=>{if(String(to).endsWith(${JSON.stringify('worker-' + token)})) process.exit(7); return original(from,to);};
      syncBuiltinESMExports();
      const {createDatabaseMaintenanceJournal}=await import(${JSON.stringify(moduleUrl)});
      createDatabaseMaintenanceJournal(${JSON.stringify(data)}).reserveCoordinatorWorker(${JSON.stringify(operation.id)},${JSON.stringify(token)});`;
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000 }).status).toBe(7);
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'unregistered' });
    journal.reserveCoordinatorWorker(operation.id, token);
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'awaiting-exit' });
    expect(() => journal.reserveCoordinatorWorker(operation.id, token)).toThrow();
    expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
  });

  it('rejects a reused ancestor token without publishing an ownership cycle', () => {
    const operation = journal.begin({ source, target });
    const initial = journal.acquireCoordinator(operation.id);
    const firstDirectory = journal.reserveCoordinatorWorker(operation.id, initial);
    writeFileSync(join(firstDirectory, 'exit'), '0');
    const next = journal.recoverCoordinator(operation.id, initial, randomUUID());
    const secondDirectory = journal.reserveCoordinatorWorker(operation.id, next);
    writeFileSync(join(secondDirectory, 'exit'), '0');
    expect(() => journal.recoverCoordinator(operation.id, next, initial)).toThrow();
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'exited', exitCode: 0 });
    const final = journal.recoverCoordinator(operation.id, next, randomUUID());
    expect(final).not.toBe(initial);
    expect(journal.read()).toEqual(operation);
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('does not let a stale predecessor advance, or recovery reopen, an operation', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const directory = journal.reserveCoordinatorWorker(operation.id, token);
    writeFileSync(join(directory, 'exit'), '0');
    let current = 'accepted';
    for (const next of ['quiescing', 'exporting', 'importing']) {
      journal.transition(operation.id, token, current, next);
      current = next;
    }
    const successor = journal.recoverCoordinator(operation.id, token, randomUUID());
    // Ownership moved; the stage and the fence did not.
    expect(() => journal.transition(operation.id, token, 'importing', 'committing')).toThrow();
    expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'unregistered' });
    expect(successor).not.toBe(token);
    expect(journal.read().stage).toBe('importing');
    expect(() => journal.assertAdmission()).toThrow();
  });
});
