import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';

// Pass-through fs whose readFileSync can run one hook before or after it: the
// only way to land a concurrent fence move deterministically between read()'s
// separate syscalls (fence check, record read, published-stage walk) in one
// sync call.
const fsHook = vi.hoisted(() => ({ beforeRead: null, afterRead: null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const readFileSync = (...args) => {
    const hook = fsHook.beforeRead;
    fsHook.beforeRead = null;
    hook?.(String(args[0]));
    const result = actual.readFileSync(...args);
    const after = fsHook.afterRead;
    fsHook.afterRead = null;
    after?.(String(args[0]));
    return result;
  };
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
const moduleUrl = new URL('./databaseMaintenanceJournal.js', import.meta.url).href;
let root;
let data;
let journal;

// These children are disposable installs, like smoke-boot, rather than Vitest
// workers. Keep NODE_ENV=test and fake pg; do not misidentify their temp data
// as a live install merely by leaking the parent's worker marker.
const childEnv = { ...process.env };
delete childEnv.VITEST;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'portos-maintenance-'));
  data = join(root, 'data');
  writeFileSync(join(root, '.portos-disposable-root'), '');
  journal = createDatabaseMaintenanceJournal(data);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function node(code, args = []) {
  return spawnSync(process.execPath, [...args, '--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...childEnv, PORTOS_DATA_ROOT: root, PGDATABASE: 'example_test', PGPASSWORD: 'example-only' },
    timeout: 10_000,
  });
}

describe('persistent database maintenance boundary', () => {
  it('publishes once across competing processes and preserves the winning direction', async () => {
    const code = `import { createDatabaseMaintenanceJournal } from ${JSON.stringify(moduleUrl)};
      const j = createDatabaseMaintenanceJournal(${JSON.stringify(data)});
      try { console.log(JSON.stringify(j.begin(${JSON.stringify({ source, target })}))); }
      catch { process.exitCode = 1; }`;
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('close', code => resolve(code));
    });
    expect((await Promise.all([run(), run()])).sort()).toEqual([0, 1]);
    const record = journal.read();
    expect(record).toMatchObject({ stage: 'accepted', source, target });
    expect(() => journal.begin({ source: target, target: source })).toThrow();
    expect(journal.read()).toEqual(record);
  });

  it('adopts a successor published between recovery owner and worker-status reads', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const directory = journal.reserveCoordinatorWorker(operation.id, token);
    writeFileSync(join(directory, 'exit'), '1\n');
    let ownerReads = 0;
    let successor;
    const interleave = path => {
      if (path.endsWith('cancel-' + operation.id + '.claim') && ++ownerReads === 2) {
        successor = journal.prepareRecovery(operation.id);
      } else {
        fsHook.beforeRead = interleave;
      }
    };
    fsHook.beforeRead = interleave;
    const recovered = journal.prepareRecovery(operation.id);
    fsHook.beforeRead = null;
    expect(successor).toBeTruthy();
    expect(recovered).toBe(successor);
    expect(recovered).not.toBe(token);
    expect(() => journal.reserveCoordinatorWorker(operation.id, recovered)).not.toThrow();
    expect(journal.prepareRecovery(operation.id)).toBeNull();
    expect(() => journal.assertAdmission()).toThrow();
  });

  // Regression: ownership can change after recoverCoordinator reads the old
  // owner but before it asserts that owner. Refusal is safe; retry adopts the
  // persisted successor instead of publishing another one (#9236).
  it('fences a contended recovery and lets an operator retry adopt the one successor', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const directory = journal.reserveCoordinatorWorker(operation.id, token);
    writeFileSync(join(directory, 'exit'), '1\n');
    let ownerReads = 0;
    let successor;
    const interleave = path => {
      if (path.endsWith('cancel-' + operation.id + '.claim') && ++ownerReads === 3) {
        successor = journal.prepareRecovery(operation.id);
      } else {
        fsHook.beforeRead = interleave;
      }
    };
    fsHook.beforeRead = interleave;
    try {
      expect(() => journal.prepareRecovery(operation.id)).toThrow(expect.objectContaining({ code: 'DATABASE_MAINTENANCE' }));
    } finally {
      fsHook.beforeRead = null;
    }
    expect(successor).toBeTruthy();
    expect(journal.prepareRecovery(operation.id)).toBe(successor);
    journal.reserveCoordinatorWorker(operation.id, successor);
    expect(journal.prepareRecovery(operation.id)).toBeNull();
    expect(() => journal.reserveCoordinatorWorker(operation.id, successor)).toThrow();
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('fences cancellation and competing coordinators through every durable stage', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    expect(() => journal.acquireCoordinator(operation.id)).toThrow();
    expect(() => journal.cancel(operation.id, source)).toThrow();
    expect(() => journal.transition(operation.id, 'wrong', 'accepted', 'quiescing')).toThrow();
    expect(() => journal.transition(operation.id, token, 'accepted', 'importing')).toThrow();
    let stage = 'accepted';
    for (const next of ['quiescing', 'exporting', 'importing']) {
      const result = node(`import {createDatabaseMaintenanceJournal} from ${JSON.stringify(moduleUrl)};
        const j=createDatabaseMaintenanceJournal(${JSON.stringify(data)});
        j.transition(${JSON.stringify(operation.id)}, ${JSON.stringify(token)}, ${JSON.stringify(stage)}, ${JSON.stringify(next)});`);
      expect(result.status, result.stderr).toBe(0);
      expect(journal.read()).toEqual({ ...operation, stage: next });
      expect(journal.transition(operation.id, token, stage, next)).toEqual({ ...operation, stage: next });
      expect(() => journal.assertAdmission()).toThrow();
      stage = next;
    }
    // Mode commit needs this operation's committed import receipt; the later
    // stages and release are covered end to end by databaseMaintenanceCutover.
    expect(() => journal.transition(operation.id, token, 'importing', 'committing')).toThrow();
    expect(journal.read().stage).toBe('importing');
    expect(() => journal.cancel(operation.id, source)).toThrow();
  });

  it('publishes a stage once when two processes share the coordinator token', async () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const code = `import { createDatabaseMaintenanceJournal } from ${JSON.stringify(moduleUrl)};
      const j = createDatabaseMaintenanceJournal(${JSON.stringify(data)});
      try { j.transition(${JSON.stringify(operation.id)}, ${JSON.stringify(token)}, 'accepted', 'quiescing'); }
      catch { process.exitCode = 1; }`;
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
      child.once('close', code => resolve(code));
    });
    expect((await Promise.all([run(), run()])).sort()).toEqual([0, 0]);
    expect(journal.read()).toEqual({ ...operation, stage: 'quiescing' });
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('recovers unpublished temporary bytes and acknowledged publications without regressing later stages', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    const active = join(data, 'database-maintenance');
    // A process killed while preparing its unique file leaves no visible stage.
    writeFileSync(join(active, 'publication-interrupted.pending'), '{');
    expect(journal.read()).toEqual(operation);
    journal.transition(operation.id, token, 'accepted', 'quiescing');
    // A restarted caller with the same durable ownership can confirm the write.
    expect(journal.transition(operation.id, token, 'accepted', 'quiescing').stage).toBe('quiescing');
    journal.transition(operation.id, token, 'quiescing', 'exporting');
    expect(() => journal.transition(operation.id, token, 'accepted', 'quiescing')).toThrow();
    expect(journal.read().stage).toBe('exporting');
    expect(() => journal.assertAdmission()).toThrow();
    const publication = join(active, 'published-quiescing.json');
    writeFileSync(publication, JSON.stringify({ ...operation, stage: 'quiescing', target: source }));
    expect(() => journal.read()).toThrow();
    expect(journal.isFenced()).toBe(true);
  });

  it('preserves the fence and prior stage after interrupted stage publication', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    writeFileSync(join(data, 'database-maintenance', 'stage-accepted.claim'), '{}');
    expect(() => journal.transition(operation.id, token, 'accepted', 'quiescing')).toThrow();
    expect(journal.read()).toEqual(operation);
    expect(() => journal.cancel(operation.id, source)).toThrow();
    expect(journal.isFenced()).toBe(true);
  });

  it('blocks a fresh database process, boot graphs, and agent admission while preserving journal identity', () => {
    const operation = journal.begin({ source, target });
    // No real pg connection is possible, even if an admission regression occurs.
    const loader = join(root, 'pg-loader.mjs');
    const stub = `export default {types:{setTypeParser(){}},Pool:class {
      on(){} query(){throw Error('POOL_REACHED')} connect(){throw Error('POOL_REACHED')}
    }};`;
    writeFileSync(loader, `export async function resolve(specifier, context, next) {
      if (specifier === 'pg') return {url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(stub))}, shortCircuit:true};
      return next(specifier, context);
    }`);
    const dbUrl = new URL('./db.js', import.meta.url).href;
    const guardsUrl = new URL('../services/agentGuards.js', import.meta.url).href;
    const code = `import {query, withTransaction, withDatabaseMaintenance, ensureSchema, checkHealth} from ${JSON.stringify(dbUrl)};
      import {withSpawnDedupGuard} from ${JSON.stringify(guardsUrl)};
      const outcomes = [];
      for (const call of [
        () => query('INSERT INTO example_record VALUES (1)'),
        () => withTransaction(() => {throw Error('CALLER_REACHED')}),
        () => withDatabaseMaintenance(() => query('SELECT 1')),
        () => ensureSchema(),
        () => withSpawnDedupGuard(new Set(), 'example', () => {throw Error('SPAWN_REACHED')})
      ]) { try { await call(); outcomes.push('unexpected'); } catch(e) {outcomes.push(e.code || e.message);} }
      const health=await checkHealth();
      if(health.connected || !health.error?.includes('Persistent database maintenance')) throw Error('HEALTH_BYPASSED');
      outcomes.push('DATABASE_MAINTENANCE');
      console.log(JSON.stringify(outcomes));`;
    // A second invocation is a restarted process, not a module-cache reset.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = node(code, ['--loader', pathToFileURL(loader).href]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual(Array(6).fill('DATABASE_MAINTENANCE'));
    }
    const bootUrl = new URL('../services/databaseBootFence.js', import.meta.url).href;
    const boot = node(`try {await import(${JSON.stringify(bootUrl)}); process.exitCode=2;}
      catch(e) {console.log(e.code);}`);
    expect(boot.status, boot.stderr).toBe(0);
    expect(boot.stdout.trim()).toBe('DATABASE_MAINTENANCE');
    expect(journal.read().id).toBe(operation.id);
  });

  it('allows admitted work to finish when checkout completes after the fence', () => {
    const loader = join(root, 'transaction-loader.mjs');
    const stub = `const log=[]; globalThis.sqlLog=log; export default {
      types:{setTypeParser(){}},Pool:class {
        on(){} async connect(){globalThis.beforeCheckout(); return {query:async sql=>{log.push(sql); return {rows:[]}},release(){}}}
        query(){throw Error('NEW_QUERY_REACHED')}
      }};`;
    writeFileSync(loader, `export async function resolve(s,c,n) {
      return s==='pg'?{url:${JSON.stringify('data:text/javascript,'+encodeURIComponent(stub))},shortCircuit:true}:n(s,c);
    }`);
    const code = `import {spawnSync} from 'node:child_process';
      import {withTransaction,query} from ${JSON.stringify(new URL('./db.js', import.meta.url).href)};
      globalThis.beforeCheckout=()=>{
        const result=spawnSync(process.execPath,['--input-type=module','-e',
          ${JSON.stringify('import {createDatabaseMaintenanceJournal} from '+JSON.stringify(moduleUrl)+'; createDatabaseMaintenanceJournal('+JSON.stringify(data)+').begin('+JSON.stringify({source,target})+');')}]);
        if(result.status!==0) throw Error('FENCE_FAILED');
      };
      await withTransaction(async client=>{
        await client.query('INSERT INTO example_record VALUES (1)');
        try {await query('INSERT INTO example_record VALUES (2)'); throw Error('NEW_WRITE_ACCEPTED')}
        catch(e){if(e.code!=='DATABASE_MAINTENANCE') throw e}
      });
      console.log(JSON.stringify(globalThis.sqlLog));`;
    const result = node(code, ['--loader', pathToFileURL(loader).href]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['BEGIN', 'INSERT INTO example_record VALUES (1)', 'COMMIT']);
    expect(journal.isFenced()).toBe(true);
  });

  it('fails closed across interrupted publication and damaged or future journals', () => {
    expect(journal.read()).toBeNull();
    expect(() => journal.assertAdmission()).not.toThrow();
    mkdirSync(join(data, 'database-maintenance'), { recursive: true });
    expect(() => journal.assertAdmission()).toThrowError(expect.objectContaining({ code: 'DATABASE_MAINTENANCE' }));
    expect(() => journal.read()).toThrow();
    for (const body of ['{', JSON.stringify({ version: 2 }), JSON.stringify({ stage: 'verified' })]) {
      writeFileSync(join(data, 'database-maintenance', 'operation.json'), body);
      expect(() => journal.read()).toThrow();
      expect(() => journal.assertAdmission()).toThrow();
      expect(() => journal.cancel('unknown', source)).toThrow();
    }
  });

  // Regression caught (#8904): a coordinator releasing admission between the
  // fence check and the record read made a booting server's release poll
  // throw DATABASE_MAINTENANCE and exit fenced although admission was open.
  it('reports no operation when the fence moves mid-read, but fails closed while still fenced', () => {
    const operation = journal.begin({ source, target });
    const active = join(data, 'database-maintenance');
    fsHook.beforeRead = () => renameSync(active, join(root, 'archived'));
    expect(journal.read()).toBeNull();
    expect(() => journal.assertAdmission()).not.toThrow();

    renameSync(join(root, 'archived'), active);
    expect(journal.read()).toMatchObject({ id: operation.id });
    fsHook.beforeRead = () => rmSync(join(active, 'operation.json'));
    expect(() => journal.read()).toThrowError(expect.objectContaining({ code: 'DATABASE_MAINTENANCE' }));
  });

  // Regression caught (#8929): a release that moved the fence after the record
  // read but before the published-stage walk truncated the history to an
  // earlier stage, so a booting server's release poll saw "the fenced
  // operation changed" and exited fenced although admission had just opened.
  it('never reports a stage history truncated by a fence move mid-walk', () => {
    const operation = journal.begin({ source, target });
    const token = journal.acquireCoordinator(operation.id);
    journal.transition(operation.id, token, 'accepted', 'quiescing');
    journal.transition(operation.id, token, 'quiescing', 'exporting');
    const active = join(data, 'database-maintenance');
    fsHook.afterRead = () => renameSync(active, join(root, 'released'));
    expect(journal.read()).toBeNull();
    expect(() => journal.assertAdmission()).not.toThrow();

    renameSync(join(root, 'released'), active);
    expect(journal.read()).toMatchObject({ id: operation.id, stage: 'exporting' });
    // A different fence now at the same path never inherits the moved one's
    // partial history; it fails closed until read again.
    fsHook.afterRead = () => { renameSync(active, join(root, 'released')); mkdirSync(active); };
    expect(() => journal.read()).toThrowError(expect.objectContaining({ code: 'DATABASE_MAINTENANCE' }));
  });

  it('cancels only an accepted matching source and retains the immutable operation as local evidence', () => {
    const operation = journal.begin({ source, target });
    expect(() => journal.cancel('00000000-0000-4000-8000-000000000000', source)).toThrow();
    expect(() => journal.cancel(operation.id, target)).toThrow();
    expect(() => journal.cancel(operation.id, { ...source, port: 6000 })).toThrow();
    expect(journal.read()).toEqual(operation);
    expect(journal.cancel(operation.id, source)).toEqual({ id: operation.id, stage: 'cancelled' });
    expect(journal.read()).toBeNull();
    expect(() => journal.assertAdmission()).not.toThrow();
    const archived = join(data, 'database-maintenance-cancelled', operation.id, 'operation.json');
    expect(JSON.parse(readFileSync(archived, 'utf8'))).toEqual(operation);
    const next = journal.begin({ source: target, target: source });
    expect(next.id).not.toBe(operation.id);
    expect(() => journal.cancel(operation.id, source)).toThrow();
    expect(journal.read()).toEqual(next);
  });

  it('does not reopen admission after an interrupted cancellation or an unknown transfer stage', () => {
    const operation = journal.begin({ source, target });
    const active = join(data, 'database-maintenance');
    writeFileSync(join(active, 'cancel-' + operation.id + '.claim'), '{}');
    expect(() => journal.cancel(operation.id, source)).toThrow();
    expect(journal.isFenced()).toBe(true);
    writeFileSync(join(active, 'operation.json'), JSON.stringify({ ...operation, stage: 'importing' }));
    expect(() => journal.cancel(operation.id, source)).toThrow();
    expect(readdirSync(data)).toEqual(['database-maintenance']);
  });

  it('drives the operator CLI against disposable saved configuration without touching PostgreSQL', () => {
    copyFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), join(root, 'ecosystem.config.cjs'));
    const config = 'PGMODE=native\nPGPORT=6543\nPGPORT_DOCKER=6544\n';
    writeFileSync(join(root, '.env'), config);
    const cli = new URL('../../scripts/database-maintenance.mjs', import.meta.url);
    let overrides = {};
    const run = (...args) => spawnSync(process.execPath, [fileURLToPath(cli), ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...childEnv, PORTOS_DATA_ROOT: root, PGPORT: '', PGPORT_DOCKER: '',
        PORTOS_NATIVE_PGPORT: '', PGHOST: 'localhost', PGUSER: 'example', PGDATABASE: 'example_test', PGPASSWORD: 'example-only', ...overrides },
    });
    expect(JSON.parse(run('status').stdout)).toEqual({ stage: 'idle' });
    expect(run('begin', 'docker', 'native').status).toBe(1);
    const started = run('begin', 'native', 'docker');
    expect(started.status, started.stderr).toBe(0);
    const operation = JSON.parse(started.stdout);
    expect(journal.read()).toMatchObject({ source: { port: 6543 }, target: { port: 6544 } });
    expect(JSON.parse(run('status').stdout)).toEqual(operation);
    expect(run('begin', 'docker', 'native').status).toBe(1);
    writeFileSync(join(root, '.env'), config.replace('6543', '6545'));
    expect(run('cancel', operation.id).status).toBe(1);
    expect(journal.isFenced()).toBe(true);
    writeFileSync(join(root, '.env'), config);
    expect(JSON.parse(run('cancel', operation.id).stdout)).toEqual({ id: operation.id, stage: 'cancelled' });
    expect(JSON.parse(run('status').stdout)).toEqual({ stage: 'idle' });
    // Mode follows the ecosystem's saved PGMODE contract; each endpoint uses
    // its own environment port override, rather than mixing env and file ports.
    overrides = { PGPORT: '7001', PGPORT_DOCKER: '7002', PGMODE: 'docker', PGHOST: 'example.invalid' };
    const overridden = run('begin', 'native', 'docker');
    expect(overridden.status, overridden.stderr).toBe(0);
    expect(journal.read()).toMatchObject({
      source: { mode: 'native', host: 'example.invalid', port: 7001 },
      target: { mode: 'docker', host: 'example.invalid', port: 7002 },
    });
    const overrideId = JSON.parse(overridden.stdout).id;
    overrides = {};
    expect(run('cancel', overrideId).status).toBe(1);
    overrides = { PGPORT: '7001', PGPORT_DOCKER: '7002', PGHOST: 'example.invalid' };
    expect(run('cancel', overrideId).status).toBe(0);
  });

  it('keeps maintenance direction when invoked by a Docker-managed process', () => {
    copyFileSync(new URL('../../ecosystem.config.cjs', import.meta.url), join(root, 'ecosystem.config.cjs'));
    writeFileSync(join(root, '.env'), 'PGMODE=docker\nPGPORT=6543\nPGPORT_DOCKER=6544\n');
    const cli = fileURLToPath(new URL('../../scripts/database-maintenance.mjs', import.meta.url));
    const env = { ...childEnv, PORTOS_DATA_ROOT: root, PGPORT: '6544',
      PORTOS_NATIVE_PGPORT: '6543', PGPORT_DOCKER: '6544',
      PGHOST: 'localhost', PGUSER: 'example', PGDATABASE: 'example_test', PGPASSWORD: 'example-only' };
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
      env, encoding: 'utf8', timeout: 10_000,
    });
    const result = run('begin', 'docker', 'native');
    expect(result.status, result.stderr).toBe(0);
    const operation = JSON.parse(result.stdout);
    expect(journal.read()).toMatchObject({
      source: { mode: 'docker', port: 6544 }, target: { mode: 'native', port: 6543 },
    });
    expect(JSON.parse(run('status').stdout)).toEqual(operation);
    expect(run('begin', 'native', 'docker').status).toBe(1);
    expect(run('cancel', operation.id).status).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('never releases a symlinked active directory or journal', () => {
    const operation = journal.begin({ source, target });
    const active = join(data, 'database-maintenance');
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify(operation));
    rmSync(join(active, 'operation.json'));
    symlinkSync(outside, join(active, 'operation.json'));
    expect(() => journal.cancel(operation.id, source)).toThrow();
    expect(journal.isFenced()).toBe(true);
    rmSync(active, { recursive: true });
    const outsideDir = join(root, 'outside');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'operation.json'), JSON.stringify(operation));
    symlinkSync(outsideDir, active);
    expect(() => journal.cancel(operation.id, source)).toThrow();
    expect(journal.isFenced()).toBe(true);
    expect(readdirSync(outsideDir)).toEqual(['operation.json']);
  });

  it('refuses same-endpoint and credential-bearing journals before fencing', () => {
    expect(() => journal.begin({ source, target: { ...target, host: '127.0.0.1', port: source.port } })).toThrow();
    expect(() => journal.begin({ source: { ...source, password: 'example-secret' }, target })).toThrow();
    expect(journal.isFenced()).toBe(false);
  });
});
