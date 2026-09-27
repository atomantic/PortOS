// The real detached worker, end to end: supervisor launch, producer stop,
// writer reconciliation, db.sh dump/import, mode commit, restart with target
// proof, and release. PM2 is replaced at its module boundary by a loader hook
// in the worker process only; pg_dump/psql are disposable stubs; the restarted
// "server" is a surrogate running the real boot handshake against a stubbed
// pg module. No live daemon, database or install data is touched.
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
import { installCutoverStubs } from '../test/fixtures/databaseCutoverStubs.js';

const cutoverFixtureUrl = new URL('../test/fixtures/databaseCutoverStubs.js', import.meta.url).href;

const detachedUrl = new URL('./detachedSpawn.js', import.meta.url).href;
const source = { mode: 'native', host: 'native.example.invalid', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
let root;
let journal;
let env;
let stubs;
let strays;
let cutover;

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
import { launchSurrogateServer, restartedServerEndpoint } from ${JSON.stringify(cutoverFixtureUrl)};
const state = ${JSON.stringify(state)};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function listMaintenanceProcesses() {
  return JSON.parse(readFileSync(state, 'utf8')).map(row => row.surrogate && !alive(row.pid) ? { ...row, status: 'errored', pid: 0 } : row);
}
export async function restartMaintenanceProducer(name) {
  const rows = JSON.parse(readFileSync(state, 'utf8'));
  const row = rows.find(value => value.name === name);
  appendFileSync(${JSON.stringify(join(stubs.dir, 'events.log'))}, 'restart ' + name + '\\n');
  row.surrogate = name === 'portos-server';
  row.pid = row.surrogate ? launchSurrogateServer(${JSON.stringify(root)}, ${JSON.stringify(stubs.dir)}, restartedServerEndpoint(${JSON.stringify(root)}, ${JSON.stringify(stubs.dir)})) : 2012;
  row.status = 'online';
  writeFileSync(state, JSON.stringify(rows));
  return { success: true };
}
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
  cutover = installCutoverStubs(root, stubs.dir, { source, target });
  writeFileSync(join(root, '.env'), 'PGMODE=native\n');
  strays = [];
  env = { ...process.env, NODE_ENV: 'test', PORTOS_DATA_ROOT: root, PATH: `${stubs.bin}${delimiter}${process.env.PATH}`,
    PGPASSWORD: 'example-password', PGHOST: 'inherited.example.invalid', PGHOSTADDR: '192.0.2.10',
    NODE_OPTIONS: `--import=${installPm2Stub()}` };
  delete env.VITEST;
});
afterEach(() => {
  for (const group of strays) { try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ } }
  for (const pid of cutover.surrogatePids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
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
// Exit status of one worker launch. A worker that RELEASED admission moved its
// control directory with the fence, so its supervisor can publish no exit
// receipt; that outcome reports `released` once the worker process is gone.
function launch(id, token) {
  return run(`import {existsSync} from 'node:fs';
    import {spawnDatabaseMaintenanceWorker} from ${JSON.stringify(detachedUrl)};
    try {
      const child=await spawnDatabaseMaintenanceWorker(${JSON.stringify(id)},${JSON.stringify(token)});
      child.stdout.on('data',chunk=>process.stdout.write(chunk));
      child.stderr.on('data',chunk=>process.stderr.write(chunk));
      child.on('error',()=>{process.exitCode=1;});
      child.on('close',code=>{process.exitCode=code;process.exit();});
      const released=setInterval(()=>{
        if(existsSync(${JSON.stringify(controlDirFor(token))})) return;
        try{process.kill(child.pid,0);}catch{clearInterval(released);setTimeout(()=>{process.stdout.write('\\nRELEASED\\n',()=>process.exit(0));},300);}
      },50);
    } catch { process.exitCode=1; }`);
}
const releasedResult = outcome => JSON.parse(outcome.stdout.split('\n').find(line => line.startsWith('{')));
const isReleased = outcome => outcome.status === 0 && outcome.stdout.includes('RELEASED');

// Operator status: bounded stage evidence, never endpoints, paths or tokens.
const status = () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/database-maintenance.mjs', import.meta.url)), 'status'],
    { env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toMatch(/example\.invalid|example-password|maintenance-worker-/);
  return JSON.parse(result.stdout);
};
const controlDirFor = token => join(root, 'data', 'database-maintenance', 'worker-' + token);
// The operator CLI's same-operation recovery, as a separate process.
const recover = id => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/database-maintenance.mjs', import.meta.url)), 'recover', id],
    { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', status => resolve({ status, stdout, stderr }));
});
const importsStarted = () => stubs.events().filter(line => line === 'import-start').length;

// Bounded, synthetic-only failure evidence, read BEFORE afterEach removes the
// disposable root (#8904): every fixture event, the operator's bounded stage
// and coordinator state, and the stderr tail of each owned worker (active or
// archived) and each surrogate server.
const tail = path => (existsSync(path) ? readFileSync(path, 'utf8').slice(-1_500) : '');
function evidence() {
  const operator = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/database-maintenance.mjs', import.meta.url)), 'status'],
    { env, encoding: 'utf8', timeout: 10_000 });
  const completed = join(root, 'data', 'database-maintenance-completed');
  const controlParents = [join(root, 'data', 'database-maintenance'),
    ...(existsSync(completed) ? readdirSync(completed).map(id => join(completed, id)) : [])];
  const workers = controlParents.flatMap(parent => (existsSync(parent) ? readdirSync(parent) : [])
    .filter(name => name.startsWith('worker-')).map(name => join(parent, name, 'stderr.log')));
  return [
    `events: ${JSON.stringify(stubs.events())}`,
    `status (exit ${operator.status}): ${(operator.stdout || operator.stderr).trim().slice(0, 1_500)}`,
    ...workers.map((path, index) => `worker ${index} stderr: ${tail(path)}`),
    `surrogate stderr: ${tail(join(stubs.dir, 'surrogate-stderr.log'))}`,
  ].join('\n');
}
// vi.waitFor that appends the evidence above when its deadline expires.
async function waitWithEvidence(assertion, timeout) {
  try {
    await vi.waitFor(assertion, { timeout, interval: 50 });
  } catch (err) {
    err.message += `\n--- maintenance evidence ---\n${evidence()}`;
    throw err;
  }
}

describe.skipIf(process.platform === 'win32')('owned maintenance worker', () => {
  it.each([[source, target], [target, source]])('cuts over the recorded operation once and releases only after the restarted server proves the target (%#)', async (from, to) => {
    writeFileSync(join(root, '.env'), `PGMODE=${from.mode}\n`);
    const operation = journal.begin({ source: from, target: to });
    const token = journal.acquireCoordinator(operation.id);
    const outcomes = await Promise.all([launch(operation.id, token), launch(operation.id, token)]);
    const released = outcomes.filter(isReleased);
    expect(released, outcomes.map(value => value.stderr).join('\n')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 1)).toHaveLength(1);
    expect(releasedResult(released[0])).toEqual({ id: operation.id, stage: 'released', source: from.mode, target: to.mode,
      importCommitted: true, sourceRetained: true, restartVerified: true, cosRestarted: true });
    await waitWithEvidence(() => expect(stubs.events()).toContain(`server booted ${to.port}`), 15_000);
    expect(stubs.events().slice(0, 6)).toEqual(['stop portos-cos', 'stop portos-server', 'dump writer=none',
      'import-start', 'import-commit', 'restart portos-server']);
    expect(stubs.events()).toContain('restart portos-cos');
    expect(stubs.invocations('pg_dump')).toEqual([`pg_dump -h ${from.host} -p ${from.port} -U ${from.user} -d ${from.database} --no-owner --no-privileges --if-exists --clean`]);
    expect(stubs.invocations('psql')).toEqual([`psql -h ${to.host} -p ${to.port} -U ${to.user} -d ${to.database} -v ON_ERROR_STOP=1 --single-transaction`]);
    expect(stubs.receivedVariables()).toEqual(['PGPASSWORD']);
    expect(stubs.imported()).toBe(STUB_DUMP_COMPLETE);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(`PGMODE=${to.mode}\n`);
    expect(journal.read()).toBeNull();
    expect(status()).toEqual({ stage: 'idle', lastCutover: { id: operation.id, source: from.mode, target: to.mode } });
    expect(createDatabaseWriterRegistry(join(root, 'data')).read()).toEqual([]);
    // The one-use owner cannot run again, and its evidence is archived.
    expect((await launch(operation.id, token)).status).toBe(1);
    expect(readdirSync(join(root, 'data', 'database-maintenance-completed', operation.id, 'worker-' + token)))
      .toEqual(expect.arrayContaining(['owner.json', 'started.json', 'group.json', 'stdout.log', 'stderr.log', 'pid']));
  }, 90_000);

  it('relaunches only the recorded operation once across repeated operator recovery', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    stubs.setMode('dump', 'fail');
    expect((await launch(operation.id, token)).status).toBe(1);
    expect(status()).toMatchObject({ stage: 'exporting', coordinator: { state: 'exited', exitCode: 1 } });
    stubs.setMode('dump', 'ok');
    const outcomes = await Promise.all([recover(operation.id), recover(operation.id)]);
    expect(outcomes.map(value => value.status), outcomes.map(value => value.stderr).join('\n')).toEqual([0, 0]);
    expect(outcomes.map(value => JSON.parse(value.stdout).recovery).sort()).toEqual(['launched', 'running']);
    await waitWithEvidence(() => expect(stubs.events()).toContain(`server booted ${target.port}`), 30_000);
    await waitWithEvidence(() => expect(journal.read()).toBeNull(), 10_000);
    // One recovered worker: one export retry, one import, one server restart.
    expect(stubs.invocations('pg_dump')).toHaveLength(2);
    expect(importsStarted()).toBe(1);
    expect(stubs.events().filter(line => line === 'restart portos-server')).toHaveLength(1);
    // A released operation has nothing left to recover.
    expect((await recover(operation.id)).status).toBe(1);
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

    // Neither knowing the token nor passing extra spawn options authorizes a
    // different executable, arguments, control directory, or ordinary child.
    const ran = join(root, 'ordinary-ran');
    const ordinary = await run(`import {spawnDetached} from ${JSON.stringify(detachedUrl)};
      const child=await spawnDetached(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(ran)},'bad')`)}],{
        controlDir:${JSON.stringify(join(root, 'ordinary'))}, maintenanceCoordinator:{id:${JSON.stringify(operation.id)},token:${JSON.stringify(token)}}});
      child.on('error',()=>{process.exitCode=1;}); child.on('close',()=>{process.exitCode=2;});`);
    expect(ordinary.status).toBe(1);
    expect(existsSync(ran)).toBe(false);

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
    expect(isReleased(done), done.stderr).toBe(true);
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(importsStarted()).toBe(2);
    expect(status()).toMatchObject({ stage: 'idle', lastCutover: { id: operation.id } });
    expect(stubs.imported()).toBe(STUB_DUMP_COMPLETE);
    expect(journal.read()).toBeNull();
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
