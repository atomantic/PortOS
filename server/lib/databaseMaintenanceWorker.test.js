// The real detached worker, end to end: supervisor launch, producer stop,
// writer reconciliation, db.sh dump/import. PM2 is replaced at its module
// boundary by a loader hook in the worker process only, and pg_dump/psql are
// disposable stubs; no live daemon, database or install data is touched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';
import { createDatabaseWriterRegistry } from './databaseWriterRegistry.js';
import { STUB_DUMP_COMPLETE, installDatabaseStubs } from '../test/fixtures/databaseTransferStubs.js';

const detachedUrl = new URL('./detachedSpawn.js', import.meta.url).href;
const source = { mode: 'native', host: 'native.example.invalid', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', host: 'docker.example.invalid', port: 5561 };
let root;
let journal;
let env;
let stubs;
let strays;

// Writes a PM2 module stand-in with file-backed state and a loader hook that
// substitutes it for server/services/pm2.js.
function installPm2Stub() {
  const state = join(stubs.dir, 'pm2.json');
  writeFileSync(state, JSON.stringify([
    { name: 'portos-cos', pmId: 12, pid: 1012, status: 'online', cwd: root, script: 'server/cos-runner/index.js' },
    { name: 'portos-server', pmId: 13, pid: 1013, status: 'online', cwd: root, script: 'server/start.js' },
  ]));
  const stubModule = join(stubs.dir, 'pm2.mjs');
  writeFileSync(stubModule, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const state = ${JSON.stringify(state)};
export async function listMaintenanceProcesses() { return JSON.parse(readFileSync(state, 'utf8')); }
export async function stopApp(id) {
  const rows = JSON.parse(readFileSync(state, 'utf8'));
  const row = rows.find(value => value.pmId === id);
  row.status = 'stopped'; row.pid = 0;
  writeFileSync(state, JSON.stringify(rows));
  appendFileSync(${JSON.stringify(join(stubs.dir, 'events.log'))}, 'stop ' + row.name + '\\n');
  return { success: true };
}\n`);
  const hooks = join(stubs.dir, 'hooks.mjs');
  writeFileSync(hooks, `export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  return result.url.endsWith('/server/services/pm2.js') ? { url: ${JSON.stringify(pathToFileURL(stubModule).href)}, format: 'module', shortCircuit: true } : result;
}\n`);
  const register = join(stubs.dir, 'register.mjs');
  writeFileSync(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  return pathToFileURL(register).href;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maintenance-worker-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
  mkdirSync(join(root, 'server', 'cos-runner'), { recursive: true });
  writeFileSync(join(root, 'server', 'start.js'), '');
  writeFileSync(join(root, 'server', 'cos-runner', 'index.js'), '');
  journal = createDatabaseMaintenanceJournal(join(root, 'data'));
  stubs = installDatabaseStubs(root);
  strays = [];
  env = { ...process.env, NODE_ENV: 'test', PORTOS_DATA_ROOT: root, PATH: `${stubs.bin}${delimiter}${process.env.PATH}`,
    PGPASSWORD: 'example-password', PGHOST: 'inherited.example.invalid', PGHOSTADDR: '192.0.2.10',
    NODE_OPTIONS: `--import=${installPm2Stub()}` };
  delete env.VITEST;
});
afterEach(() => {
  for (const group of strays) { try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(root, { recursive: true, force: true });
});

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

// Operator status: bounded stage evidence, never endpoints, paths or tokens.
const status = () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/database-maintenance.mjs', import.meta.url)), 'status'],
    { env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toMatch(/example\.invalid|example-password|maintenance-worker-/);
  return JSON.parse(result.stdout);
};
const controlDirFor = token => join(root, 'data', 'database-maintenance', 'worker-' + token);
const importsStarted = () => stubs.events().filter(line => line === 'import-start').length;

describe.skipIf(process.platform === 'win32')('owned maintenance worker', () => {
  it.each([[source, target], [target, source]])('transfers the recorded operation once while ordinary launches remain fenced (%#)', async (from, to) => {
    const operation = journal.begin({ source: from, target: to });
    const token = journal.acquireCoordinator(operation.id);
    const outcomes = await Promise.all([launch(operation.id, token), launch(operation.id, token)]);
    expect(outcomes.map(value => value.status).sort((a, b) => a - b)).toEqual([1, 78]);
    const transferred = JSON.parse(outcomes.find(value => value.status === 78).stdout);
    expect(transferred).toEqual({ id: operation.id, stage: 'importing', source: from.mode, target: to.mode,
      imported: true, importCommitted: true, sourceRetained: true, restartVerified: false });
    expect(stubs.events()).toEqual(['stop portos-cos', 'stop portos-server', 'dump writer=none', 'import-start', 'import-commit']);
    expect(stubs.invocations('pg_dump')).toEqual([`pg_dump -h ${from.host} -p ${from.port} -U ${from.user} -d ${from.database} --no-owner --no-privileges --if-exists --clean`]);
    expect(stubs.invocations('psql')).toEqual([`psql -h ${to.host} -p ${to.port} -U ${to.user} -d ${to.database} -v ON_ERROR_STOP=1 --single-transaction`]);
    expect(stubs.receivedVariables()).toEqual(['PGPASSWORD']);
    expect(stubs.imported()).toBe(STUB_DUMP_COMPLETE);
    expect(journal.read()).toEqual({ ...operation, stage: 'importing' });
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'exited', exitCode: 78 });
    expect(createDatabaseWriterRegistry(join(root, 'data')).read()).toEqual([]);
    expect(() => journal.assertAdmission()).toThrow();
    const controlDir = controlDirFor(token);
    const before = readdirSync(controlDir).sort();
    expect(before).toEqual(expect.arrayContaining(['owner.json', 'started.json', 'group.json', 'stdout.log', 'stderr.log', 'pid', 'exit']));
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
    // A recovered owner re-proves quiescence but never re-imports a committed transfer.
    const successor = journal.recoverCoordinator(operation.id, token, randomUUID());
    expect((await launch(operation.id, token)).status).toBe(1);
    const resumed = await launch(operation.id, successor);
    expect(resumed.status).toBe(78);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ imported: false, importCommitted: true });
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(importsStarted()).toBe(1);
    expect(readFileSync(join(controlDir, 'exit'), 'utf8').trim()).toBe('78');
    expect(journal.read()).toEqual({ ...operation, stage: 'importing' });
  }, 90_000);

  // Regression caught: a successor importing while an import started by a
  // killed predecessor (whose supervisor already published an exit) still runs.
  it('never lets a recovered coordinator import while a killed predecessor\'s import still runs', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    stubs.setMode('import', 'pause');
    const first = launch(operation.id, token);
    await vi.waitFor(() => expect(stubs.started('import')).toBe(true), { timeout: 30_000, interval: 50 });
    const { pgid } = JSON.parse(readFileSync(join(controlDirFor(token), 'group.json'), 'utf8'));
    strays.push(pgid);
    process.kill(Number(readFileSync(join(controlDirFor(token), 'pid'), 'utf8')), 'SIGKILL');
    expect((await first).status).not.toBe(78);
    await vi.waitFor(() => expect(journal.coordinatorStatus(operation.id).state).toBe('exited'), { timeout: 10_000, interval: 50 });

    const second = journal.recoverCoordinator(operation.id, token, randomUUID());
    const refused = await launch(operation.id, second);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/previous coordinator's dump or import process is still running/);
    expect(importsStarted()).toBe(1);
    expect(status()).toEqual({ id: operation.id, stage: 'importing', source: 'native', target: 'docker',
      coordinator: { state: 'exited', exitCode: 1 }, transfer: { dump: 'recorded', import: 'pending' } });

    process.kill(-pgid, 'SIGKILL');
    stubs.setMode('import', 'ok');
    const third = journal.recoverCoordinator(operation.id, second, randomUUID());
    const done = await launch(operation.id, third);
    expect(done.status).toBe(78);
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(importsStarted()).toBe(2);
    expect(status()).toMatchObject({ stage: 'importing', transfer: { dump: 'recorded', import: 'committed' } });
    expect(stubs.imported()).toBe(STUB_DUMP_COMPLETE);
    expect(journal.read()).toEqual({ ...operation, stage: 'importing' });
  }, 90_000);

  it('retains unresolved inventory and refuses to export', async () => {
    createDatabaseWriterRegistry(join(root, 'data')).reserve(join(root, 'pending-writer'));
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const outcome = await launch(operation.id, token);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toMatch(/1 admitted launch\(es\) have not recorded a process identity/);
    expect(createDatabaseWriterRegistry(join(root, 'data')).read()).toHaveLength(1);
    expect(journal.read()).toEqual({ ...operation, stage: 'quiescing' });
    expect(stubs.invocations('pg_dump')).toEqual([]);
  }, 40_000);

});

// Ownership and entry refusals happen before any platform-specific transfer step.
describe('owned maintenance worker entry', () => {
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
    expect(stubs.events()).toEqual([]);
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
    expect(outcome.stderr).toContain('ownership, writer, or transfer evidence is incomplete');
    expect(outcome.stderr).not.toContain('private-example-marker');
    expect(outcome.stderr).not.toContain(root);
    expect(outcome.stderr).not.toContain(token);
    expect(journal.read()).toEqual({ ...operation, stage: 'quiescing' });
    expect(stubs.invocations('pg_dump')).toEqual([]);
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
