// Offline transfer workflow against the REAL journal, writer reconciliation
// (live process table) and scripts/db.sh, with PM2 mocked at its module
// boundary and pg_dump/psql replaced by disposable stubs. No live database,
// PM2 daemon or install data is touched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUB_DUMP_COMPLETE, installDatabaseStubs } from '../test/fixtures/databaseTransferStubs.js';

const context = vi.hoisted(() => ({ root: undefined, list: null, stop: null, timed: null }));
vi.mock('../lib/paths.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: new Proxy(actual.PATHS, {
    get: (target, key) => {
      if (key === 'data' && context.root) return context.root + '/data';
      if (key === 'installRoot' && context.root) return context.root;
      return target[key];
    },
  }) };
});
// Only the process-table snapshot is wrapped (timed per call); every behavior
// is the real one. It is the harness's one real `ps -A` and the first suspect
// when a case is slow under load.
vi.mock('../lib/detachedSpawn.js', async original => {
  const actual = await original();
  return { ...actual, snapshotProcesses: (...args) => context.timed('snapshotProcesses', () => actual.snapshotProcesses(...args)) };
});
vi.mock('./pm2.js', () => ({
  listMaintenanceProcesses: (...args) => context.list(...args),
  stopApp: (...args) => context.stop(...args),
}));
const { createDatabaseMaintenanceJournal } = await import('../lib/databaseMaintenanceJournal.js');
const { spawnDetached } = await import('../lib/detachedSpawn.js');
const { runDatabaseTransfer } = await import('./databaseMaintenanceTransfer.js');

import { isProcessAlive } from '../test/processAlive.js';

const native = { mode: 'native', host: 'native.example.invalid', port: 5432, database: 'example_test', user: 'example' };
const docker = { mode: 'docker', host: 'docker.example.invalid', port: 5561, database: 'example_test', user: 'example' };
const fast = { graceMs: 1500, pollMs: 20 };
const endpointArgs = endpoint => `-h ${endpoint.host} -p ${endpoint.port} -U ${endpoint.user} -d ${endpoint.database}`;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const alive = isProcessAlive;
const savedEnv = { ...process.env };

let root;
let journal;
let stubs;
let rows;
let operation;
let token;
let strays;
let ordinary;

beforeEach(({ onTestFailed }) => {
  root = mkdtempSync(join(tmpdir(), 'database-transfer-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
  mkdirSync(join(root, 'server', 'cos-runner'), { recursive: true });
  writeFileSync(join(root, 'server', 'start.js'), '');
  writeFileSync(join(root, 'server', 'cos-runner', 'index.js'), '');
  context.root = root;
  onTestFailed(() => console.error(`❌ database transfer fixture failed: ${diagnostics()}`));
  journal = createDatabaseMaintenanceJournal(join(root, 'data'));
  stubs = installDatabaseStubs(root);
  strays = [];
  ordinary = [];
  context.timed = (name, run) => stubs.timed(name, run);
  rows = [
    { name: 'portos-cos', pmId: 12, pid: 1012, status: 'online', cwd: root, script: 'server/cos-runner/index.js' },
    { name: 'portos-server', pmId: 13, pid: 1013, status: 'online', cwd: root, script: 'server/start.js' },
  ];
  context.list = vi.fn(() => stubs.timed('listMaintenanceProcesses', async () => rows.map(row => ({ ...row }))));
  context.stop = vi.fn(id => stubs.timed('stopApp', async () => {
    const row = rows.find(value => value.pmId === id);
    stubs.event('stop ' + row.name);
    row.status = 'stopped'; row.pid = 0;
    return { success: true };
  }));
  // Inherited libpq settings that must never redirect the transfer.
  Object.assign(process.env, {
    PATH: `${stubs.bin}:${savedEnv.PATH}`, PGPASSWORD: 'example-password',
    PGHOST: 'inherited.example.invalid', PGPORT: '1', PGUSER: 'inherited', PGDATABASE: 'inherited',
    PGHOSTADDR: '192.0.2.10', PGSERVICE: 'inherited', PGSERVICEFILE: '/example/pg_service.conf',
    PGOPTIONS: '-c search_path=inherited',
  });
});
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const group of strays) { try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ } }
  for (const child of ordinary) child.kill('SIGKILL');
  // A timed-out case's transfer is still running: end the stubs it waits on and
  // let it settle BEFORE its root goes, so it neither overlaps the next case
  // nor writes into a removed root. Never infer completion from the timeout:
  // while anything is in flight, keep the root and say so.
  const contained = await stubs.contain();
  if (process.env.DB_TRANSFER_DIAG) console.log(`⏱️ database transfer fixture: ${stubs.report()}`);
  context.root = undefined;
  if (contained) rmSync(root, { recursive: true, force: true });
  else console.error(`❌ database transfer fixture still in flight at teardown; keeping its disposable root: ${stubs.report()}`);
});

function begin(source = native, target = docker) {
  operation = journal.begin({ source, target });
  token = journal.acquireCoordinator(operation.id);
  journal.reserveCoordinatorWorker(operation.id, token);
}

// Same-operation recovery exactly as a detached supervisor receipt permits it.
function successor() {
  const previous = token;
  writeFileSync(join(root, 'data', 'database-maintenance', 'worker-' + previous, 'exit'), '1\n');
  token = journal.recoverCoordinator(operation.id, previous, randomUUID());
  journal.reserveCoordinatorWorker(operation.id, token);
  return previous;
}

// Last harness phase plus owned-child state, for a failure or timeout. Bounded
// and redacted: mark names, child kinds and durations only.
const diagnostics = () => {
  let stage = 'unknown';
  try { stage = journal.read()?.stage ?? 'none'; } catch { /* journal not readable */ }
  return stubs.report(`stage=${stage}`);
};
const transfer = () => stubs.track(stubs.timed('runDatabaseTransfer', () => runDatabaseTransfer(operation.id, token, fast)));
const dumpPath = () => join(root, 'data', 'db-dumps', `portos-maintenance-${operation.id}.sql`);

// An ordinary process of this install: a pooled write and a detached spawn.
function ordinaryWriter() {
  const dbUrl = new URL('../lib/db.js', import.meta.url).href;
  const detachedUrl = new URL('../lib/detachedSpawn.js', import.meta.url).href;
  const ran = join(root, 'ordinary-ran');
  const code = `import { query } from ${JSON.stringify(dbUrl)};
    import { spawnDetached } from ${JSON.stringify(detachedUrl)};
    const out = {};
    try { await query('INSERT INTO example_record VALUES (1)'); out.query = 'allowed'; } catch (err) { out.query = err.code ?? 'failed'; }
    const child = await spawnDetached(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(ran)},'x')`)}],
      { controlDir: ${JSON.stringify(join(root, 'ordinary-control'))} });
    out.spawn = await new Promise(resolve => { child.once('error', err => resolve(err.code)); child.once('close', () => resolve('ran')); });
    console.log(JSON.stringify(out)); process.exit(0);`;
  const env = { ...savedEnv, NODE_ENV: 'test', PORTOS_DATA_ROOT: root,
    PGHOST: 'ordinary.example.invalid', PGPORT: '1', PGDATABASE: 'example_test' };
  delete env.VITEST;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    ordinary.push(child);
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', () => resolve({ ...JSON.parse(stdout || '{}'), ran: existsSync(ran) }));
  });
}

describe.skipIf(process.platform === 'win32')('offline database transfer', () => {
  it.each([[native, docker], [docker, native]])('exports only after every writer stops, then imports the recorded dump into the recorded target (%#)', async (source, target) => {
    const writer = await spawnDetached(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { controlDir: join(root, 'writer'), pollMs: 10 });
    strays.push(writer.pid);
    stubs.writerPid(writer.pid);
    begin(source, target);

    const result = await transfer();
    expect(result).toEqual({ id: operation.id, stage: 'importing', source: source.mode, target: target.mode,
      imported: true, importCommitted: true, sourceRetained: true, restartVerified: false });
    // Regression caught: a dump taken while a producer or detached writer still ran.
    expect(stubs.events()).toEqual(['stop portos-cos', 'stop portos-server', 'dump writer=dead', 'import-start', 'import-commit']);
    expect(alive(writer.pid)).toBe(false);
    const [dump] = stubs.invocations('pg_dump');
    const [load] = stubs.invocations('psql');
    expect(dump).toBe(`pg_dump ${endpointArgs(source)} --no-owner --no-privileges --no-comments --if-exists --clean`);
    expect(load).toBe(`psql ${endpointArgs(target)} -v ON_ERROR_STOP=1 --single-transaction`);
    // Inherited libpq endpoint/option variables never reach the client tools.
    expect(stubs.receivedVariables()).toEqual(['PGPASSWORD']);
    expect(stubs.calls()).not.toMatch(/inherited|192\.0\.2\.10/);
    expect(stubs.imported()).toBe(STUB_DUMP_COMPLETE);
    // The source recovery dump is retained, recorded, and bound to this operation.
    expect(readFileSync(dumpPath(), 'utf8')).toBe(STUB_DUMP_COMPLETE);
    const manifest = JSON.parse(readFileSync(join(root, 'data', 'database-maintenance', 'transfer-dump.json'), 'utf8'));
    expect(manifest).toEqual({ id: operation.id, source, file: `portos-maintenance-${operation.id}.sql`,
      bytes: Buffer.byteLength(STUB_DUMP_COMPLETE), sha256: sha256(STUB_DUMP_COMPLETE) });
    // Direction, mode and the fence are unchanged; restart is the cutover worker's.
    expect(journal.read()).toEqual({ ...operation, stage: 'importing' });
    expect(journal.transferStatus(operation.id)).toEqual({ dump: 'recorded', import: 'committed' });
    expect(existsSync(join(root, '.env'))).toBe(false);
    expect(() => journal.assertAdmission()).toThrow();
    // One-use worker entry: the same owner cannot transfer twice.
    await expect(transfer()).rejects.toThrow();
    expect(stubs.invocations('psql')).toHaveLength(1);
  }, 30_000);

  it.each(['ok', 'fail'])('preserves original dump and receipt identity when extension metadata is normalized (%s)', async mode => {
    const legacy = "DROP EXTENSION IF EXISTS vector;\nCOMMENT ON EXTENSION vector IS 'legacy';\n" + STUB_DUMP_COMPLETE;
    writeFileSync(join(stubs.dir, 'dump.sql'), legacy);
    begin();
    stubs.setMode('import', mode);
    if (mode === 'fail') {
      await expect(transfer()).rejects.toThrow(/target import failed/);
      expect(journal.transferStatus(operation.id)).toEqual({ dump: 'recorded', import: 'pending' });
      successor();
      stubs.setMode('import', 'ok');
    }
    expect(await transfer()).toMatchObject({ importCommitted: true });
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(stubs.imported()).toBe('\n\n' + STUB_DUMP_COMPLETE);
    expect(readFileSync(dumpPath(), 'utf8')).toBe(legacy);
    expect(journal.readTransferDump(operation.id)).toMatchObject({ sha256: sha256(legacy), bytes: Buffer.byteLength(legacy) });
    expect(journal.readTransferImport(operation.id)).toMatchObject({ id: operation.id, target: docker, sha256: sha256(legacy) });
    expect(() => journal.assertAdmission()).toThrow();
  }, 30_000);

  it('refuses ordinary writes and spawns while export and import are paused', async () => {
    begin();
    stubs.setMode('dump', 'pause');
    stubs.setMode('import', 'pause');
    const pending = transfer();
    await vi.waitFor(() => expect(stubs.started('dump')).toBe(true), { timeout: 10_000, interval: 20 });
    expect(journal.read().stage).toBe('exporting');
    expect(await ordinaryWriter()).toEqual({ query: 'DATABASE_MAINTENANCE', spawn: 'DATABASE_MAINTENANCE', ran: false });
    stubs.release('dump');
    await vi.waitFor(() => expect(stubs.started('import')).toBe(true), { timeout: 10_000, interval: 20 });
    expect(journal.read().stage).toBe('importing');
    expect(await ordinaryWriter()).toEqual({ query: 'DATABASE_MAINTENANCE', spawn: 'DATABASE_MAINTENANCE', ran: false });
    stubs.release('import');
    expect(await pending).toMatchObject({ importCommitted: true });
  }, 30_000);

  // Regression caught: a case that times out while a stub is blocked leaves its
  // transfer and child running into the next case, or writing into a removed root.
  it('reports a blocked case\'s last phase and owned child state, then settles it before its root goes', async () => {
    begin();
    stubs.setMode('dump', 'pause');
    const pending = transfer();
    const outcome = pending.then(() => 'resolved', error => error.message);
    await vi.waitFor(() => expect(stubs.started('dump')).toBe(true), { timeout: 10_000, interval: 20 });

    const blocked = diagnostics();
    expect(blocked).toMatch(/^last=\S+\(\d+ms ago\) slowest=.+ children=dump:running pending=1 stage=exporting$/);
    expect(blocked).toMatch(/snapshotProcesses=\d+x\/\d+ms/);
    // No argv, endpoint, credential or path reaches the report (the only "/" is a count/duration separator).
    expect(blocked).not.toMatch(/invalid|example|portos|bash|db\.sh|pg_dump|psql|PG[A-Z]|\/(?!\d)/);

    expect(await stubs.contain()).toBe(true);
    expect(await outcome).toMatch(/source export failed/);
    // SIGKILL skips the stub's own exit line, so a contained child reads gone, not exited.
    expect(diagnostics()).toMatch(/children=dump:gone pending=0 stage=exporting$/);
    // Nothing continued past the settled case: no import began, no dump recorded.
    expect(stubs.invocations('psql')).toEqual([]);
    expect(journal.transferStatus(operation.id)).toEqual({ dump: 'absent', import: 'pending' });
  }, 30_000);

  it.each(['fail', 'incomplete'])('never records a %s export; a recovered owner re-quiesces and exports again', async mode => {
    begin();
    stubs.setMode('dump', mode);
    await expect(transfer()).rejects.toThrow(mode === 'fail' ? /source export failed/ : /incomplete/);
    expect(journal.read().stage).toBe('exporting');
    expect(journal.transferStatus(operation.id)).toEqual({ dump: 'absent', import: 'pending' });
    expect(stubs.invocations('psql')).toEqual([]);

    const retired = successor();
    await expect(stubs.track(runDatabaseTransfer(operation.id, retired, fast))).rejects.toThrow();
    stubs.setMode('dump', 'ok');
    const listed = context.list.mock.calls.length;
    expect(await transfer()).toMatchObject({ stage: 'importing', imported: true });
    // Renewed producer readback precedes the retried export.
    expect(context.list.mock.calls.length).toBeGreaterThan(listed);
    expect(stubs.invocations('pg_dump')).toHaveLength(2);
    expect(stubs.imported()).toBe(STUB_DUMP_COMPLETE);
    expect(journal.read()).toEqual({ ...operation, stage: 'importing' });
  }, 30_000);

  it.each([[native, docker], [docker, native]])('retries a failed import only from the same recorded dump into the same target (%#)', async (source, target) => {
    begin(source, target);
    stubs.setMode('import', 'fail');
    await expect(transfer()).rejects.toThrow(/target import failed/);
    expect(journal.read()).toEqual({ ...operation, stage: 'importing' });
    expect(journal.transferStatus(operation.id)).toEqual({ dump: 'recorded', import: 'pending' });
    const recorded = readFileSync(dumpPath(), 'utf8');

    successor();
    stubs.setMode('import', 'ok');
    expect(await transfer()).toMatchObject({ source: source.mode, target: target.mode, imported: true });
    // No second export: the retry cannot pick up post-fence source state.
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(stubs.invocations('psql')).toEqual([
      `psql ${endpointArgs(target)} -v ON_ERROR_STOP=1 --single-transaction`,
      `psql ${endpointArgs(target)} -v ON_ERROR_STOP=1 --single-transaction`,
    ]);
    expect(readFileSync(dumpPath(), 'utf8')).toBe(recorded);
    expect(journal.transferStatus(operation.id)).toEqual({ dump: 'recorded', import: 'committed' });

    // A later recovery never imports a committed transfer again.
    successor();
    expect(await transfer()).toMatchObject({ imported: false, importCommitted: true });
    expect(stubs.invocations('psql')).toHaveLength(2);
  }, 30_000);

  it.each(['changed', 'missing'])('refuses to import a recovery dump whose recorded bytes are %s', async fault => {
    begin();
    stubs.setMode('import', 'fail');
    await expect(transfer()).rejects.toThrow(/target import failed/);
    if (fault === 'changed') writeFileSync(dumpPath(), STUB_DUMP_COMPLETE.replace('id int', 'id text'));
    else rmSync(dumpPath());
    successor();
    stubs.setMode('import', 'ok');
    await expect(transfer()).rejects.toThrow(fault === 'changed' ? /no longer matches/ : /missing/);
    expect(stubs.invocations('psql')).toHaveLength(1);
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(journal.read().stage).toBe('importing');
  }, 30_000);
});
