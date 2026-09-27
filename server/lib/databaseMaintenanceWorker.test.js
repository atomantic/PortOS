import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';
import { createDatabaseWriterRegistry } from './databaseWriterRegistry.js';

const detachedUrl = new URL('./detachedSpawn.js', import.meta.url).href;
const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
let root;
let journal;
let env;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maintenance-worker-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
  journal = createDatabaseMaintenanceJournal(join(root, 'data'));
  env = { ...process.env, NODE_ENV: 'test', PORTOS_DATA_ROOT: root };
  delete env.VITEST;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}
function launch(id, token) {
  return run(`import {spawnDatabaseMaintenanceWorker} from ${JSON.stringify(detachedUrl)};
    try {
      const child=await spawnDatabaseMaintenanceWorker(${JSON.stringify(id)},${JSON.stringify(token)});
      child.stdout.on('data',chunk=>process.stdout.write(chunk));
      child.stderr.on('data',chunk=>process.stderr.write(chunk));
      child.on('error',()=>{process.exitCode=1;});
      child.on('close',code=>{process.exitCode=code;});
    } catch { process.exitCode=1; }`);
}

describe('owned maintenance worker launch', () => {
  it.each([[source, target], [target, source]])('runs one fixed inspection while ordinary launches remain fenced', async (from, to) => {
    const operation = journal.begin({ source: from, target: to });
    const token = journal.acquireCoordinator(operation.id);
    const outcomes = await Promise.all([launch(operation.id, token), launch(operation.id, token)]);
    expect(outcomes.map(value => value.status).sort((a, b) => a - b)).toEqual([1, 78]);
    const inspection = JSON.parse(outcomes.find(value => value.status === 78).stdout);
    expect(inspection).toEqual({ id: operation.id, stage: 'accepted', source: from.mode, target: to.mode,
      writers: { unresolved: 0, launched: 0, exited: 0 }, quiescenceVerified: false, transferReady: false });
    expect(journal.read()).toEqual(operation);
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'exited', exitCode: 78 });
    expect(createDatabaseWriterRegistry(join(root, 'data')).read()).toEqual([]);
    expect(() => journal.assertAdmission()).toThrow();
    const controlDir = join(root, 'data', 'database-maintenance', 'worker-' + token);
    const before = readdirSync(controlDir).sort();
    expect(before).toEqual(expect.arrayContaining(['owner.json', 'started.json', 'stdout.log', 'stderr.log', 'pid', 'exit']));
    expect((await launch(operation.id, token)).status).toBe(1);
    expect(readdirSync(controlDir).sort()).toEqual(before);
    expect(readFileSync(join(controlDir, 'exit'), 'utf8').trim()).toBe('78');

    // Neither knowing the token nor passing extra spawn options authorizes a
    // different executable, arguments, control directory, or ordinary child.
    const ran = join(root, 'ordinary-ran');
    const ordinary = await run(`import {spawnDetached} from ${JSON.stringify(detachedUrl)};
      const child=await spawnDetached(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(ran)},'bad')`)}],{
        controlDir:${JSON.stringify(join(root, 'ordinary'))}, maintenanceCoordinator:{id:${JSON.stringify(operation.id)},token:${JSON.stringify(token)}}});
      child.on('error',()=>{process.exitCode=1;}); child.on('close',()=>{process.exitCode=2;});`);
    expect(ordinary.status).toBe(1);
    expect(existsSync(ran)).toBe(false);
    const successor = journal.recoverCoordinator(operation.id, token, randomUUID());
    expect((await launch(operation.id, token)).status).toBe(1);
    expect((await launch(operation.id, successor)).status).toBe(78);
    expect(readFileSync(join(controlDir, 'exit'), 'utf8').trim()).toBe('78');
    expect(journal.read()).toEqual(operation);
  }, 60_000);

  it('rejects a foreign owner and cannot relaunch an interrupted reservation', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    expect((await launch(operation.id, randomUUID())).status).toBe(1);
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'unregistered' });
    const controlDir = journal.reserveCoordinatorWorker(operation.id, token);
    writeFileSync(join(controlDir, 'stdout.log'), 'retained evidence');
    expect((await launch(operation.id, token)).status).toBe(1);
    expect(readFileSync(join(controlDir, 'stdout.log'), 'utf8')).toBe('retained evidence');
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'awaiting-exit' });
    expect(() => journal.recoverCoordinator(operation.id, token, randomUUID())).toThrow();
  }, 40_000);

  it('retains unresolved inventory and refuses transfer after inspecting it', async () => {
    createDatabaseWriterRegistry(join(root, 'data')).reserve(join(root, 'pending-writer'));
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const outcome = await launch(operation.id, token);
    expect(outcome.status).toBe(78);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ writers: { unresolved: 1 }, transferReady: false });
    expect(createDatabaseWriterRegistry(join(root, 'data')).read()).toHaveLength(1);
    expect(journal.read()).toEqual(operation);
  }, 40_000);

  it('refuses damaged inventory without printing local evidence', async () => {
    const registry = createDatabaseWriterRegistry(join(root, 'data'));
    registry.reserve(join(root, 'pending-writer'));
    const [writer] = registry.read();
    writeFileSync(join(root, 'data', 'database-writers', writer.id, 'reservation.json'), 'private-example-marker');
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const outcome = await launch(operation.id, token);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toContain('ownership or inventory evidence is incomplete');
    expect(outcome.stderr).not.toContain('private-example-marker');
    expect(outcome.stderr).not.toContain(root);
    expect(outcome.stderr).not.toContain(token);
    expect(journal.read()).toEqual(operation);
    expect(() => journal.assertAdmission()).toThrow();
  }, 40_000);

  it('rejects repeated direct worker entry', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const controlDir = journal.reserveCoordinatorWorker(operation.id, token);
    journal.enterCoordinatorWorker(operation.id, token);
    expect(() => journal.enterCoordinatorWorker(operation.id, token)).toThrow();
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'awaiting-exit' });
    // The stopped reservation is never repaired or reused automatically.
    expect(readFileSync(join(controlDir, 'started.json'), 'utf8')).toContain(token);
  });
});
