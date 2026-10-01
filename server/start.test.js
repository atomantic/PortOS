import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabaseMaintenanceJournal } from './lib/databaseMaintenanceJournal.js';

const entry = fileURLToPath(new URL('./start.js', import.meta.url));
const application = new URL('./index.js', import.meta.url).href;
const source = { mode: 'native', host: 'localhost', port: 5432, user: 'example', database: 'example_test' };
const target = { ...source, mode: 'docker', port: 5561 };
let root;
let journal;
let loader;
let trace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'portos-verify-boot-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
  journal = createDatabaseMaintenanceJournal(join(root, 'data'));
  trace = join(root, 'trace.jsonl');
  writeFileSync(trace, '');
  // A loader substitutes ONLY pg and the final application import. No real
  // database or running install can be reached, even if admission regresses.
  const stub = `import {appendFileSync,writeFileSync} from 'node:fs';
    const log = x => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(x)+'\\n');
    export default {Client:class {connectionParameters={ssl:false,sslnegotiation:"postgres"}},types:{setTypeParser(){}}, Pool:class {
      constructor(config){ log({pool:{host:config.host,port:config.port,database:config.database,user:config.user}}); }
      on(){} async end(){log('closed')}
      async connect(){log('connected');return {
        async query(q){log(q.text);if(process.env.EXAMPLE_PROBE_FAILURE==='throw') throw Error('example-secret');
          if(q.text.startsWith('\\n')){
            if(process.env.EXAMPLE_PROBE_FAILURE==='journal') writeFileSync(${JSON.stringify(join(root, 'data/database-maintenance/operation.json'))}, '{');
            return {rows:[{database:process.env.PGDATABASE,user:process.env.PGUSER,
              has_memories:true,has_links:true,has_sync:true,has_catalog:true,
              has_catalog_scraps:process.env.EXAMPLE_PROBE_FAILURE!=='schema',
              ...(process.env.EXAMPLE_PROBE_FAILURE==='identity'?{database:'different_test'}:{})}]};
          } return {rows:[]};
        }, release(discard){log({released:discard})}
      }}
    }};`;
  loader = join(root, 'loader.mjs');
  writeFileSync(loader, `export async function resolve(s,c,n){
    if(s==='pg')return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(stub))},shortCircuit:true};
    const resolved=await n(s,c);
    if(resolved.url===${JSON.stringify(application)})return {url:'data:text/javascript,console.log("APPLICATION_IMPORTED")',shortCircuit:true};
    return resolved;
  }`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args = [], endpoint = target, overrides = {}) {
  const env = { ...process.env, NODE_ENV: 'test', PORTOS_DATA_ROOT: root,
    PGHOST: endpoint.host, PGPORT: String(endpoint.port), PGUSER: endpoint.user,
    PGDATABASE: endpoint.database, PGPASSWORD: 'example-secret', ...overrides };
  delete env.VITEST;
  delete env.TEST_DB_OK;
  return spawnSync(process.execPath, ['--loader', pathToFileURL(loader).href, entry, ...args], {
    encoding: 'utf8', timeout: 15_000, env,
  });
}
// Walk an owned operation to `finalStage`, publishing the dump manifest and
// import receipt the journal requires before mode commit.
function operation(from = source, to = target, finalStage = 'verifying') {
  const record = journal.begin({ source: from, target: to });
  const token = journal.acquireCoordinator(record.id);
  journal.reserveCoordinatorWorker(record.id, token);
  journal.enterCoordinatorWorker(record.id, token);
  const sha256 = 'a'.repeat(64);
  let previous = 'accepted';
  for (const next of ['quiescing', 'exporting', 'importing', 'committing', 'verifying', 'verified']) {
    if (previous === finalStage) break;
    if (previous === 'exporting') {
      journal.recordTransferDump(record.id, token, { id: record.id, source: from,
        file: `portos-maintenance-${record.id}.sql`, bytes: 1, sha256 });
    }
    if (previous === 'importing') journal.recordTransferImport(record.id, token, { id: record.id, target: to, sha256 });
    journal.transition(record.id, token, previous, next);
    previous = next;
  }
  return journal.read();
}
const events = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

describe('managed database verification startup', () => {
  it.each([[source, target], [target, source]])('probes the recorded target through the actual pool without importing writers (%j)', (from, to) => {
    const record = operation(from, to);
    const result = run(['--verify-database', record.id], to);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: record.id, stage: 'verifying', target: to.mode, targetHealthy: true, fenced: true });
    expect(events()[0]).toEqual({ pool: { host: to.host, port: to.port, database: to.database, user: to.user } });
    const sql = events().filter(e => typeof e === 'string');
    expect(sql[1]).toBe('BEGIN READ ONLY');
    expect(sql[2]).toContain('current_database()');
    expect(sql.slice(3)).toEqual(['ROLLBACK', 'closed']);
    expect(journal.read()).toEqual(record);
    expect(() => journal.assertAdmission()).toThrow();
  });

  it('refuses ordinary startup before even resolving the application graph while fenced before verification', () => {
    const record = operation(source, target, 'importing');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('APPLICATION_IMPORTED');
    expect(events()).toEqual([]);
    expect(journal.read()).toEqual(record);
  });

  it.each(['verifying', 'verified'])('refuses an ordinary %s boot whose own pool is not the recorded target', stage => {
    const record = operation(source, target, stage);
    const result = run([], source);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('APPLICATION_IMPORTED');
    expect(events()).not.toContain('connected');
    expect(journal.read()).toEqual(record);
    expect(journal.isFenced()).toBe(true);
  });

  it('loads the ordinary application through the managed entrypoint only when unfenced', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('APPLICATION_IMPORTED');
    // The boot fence reads the pool identity for the retired-backend check;
    // it never connects or queries before the application loads.
    expect(events()).toEqual([{ pool: { host: target.host, port: target.port, database: target.database, user: target.user } }]);
  });

  it('refuses wrong operations, old-source pools, premature stages, and non-test databases before checkout', () => {
    const record = operation();
    for (const [id, endpoint] of [['not-this-operation', target], [record.id, source],
      [record.id, { ...target, host: 'example.invalid' }], [record.id, { ...target, user: 'other' }]]) {
      expect(run(['--verify-database', id], endpoint).status).toBe(1);
    }
    expect(events()).not.toContain('connected');
    rmSync(join(root, 'data/database-maintenance'), { recursive: true });
    const early = operation(source, target, 'committing');
    expect(run(['--verify-database', early.id]).status).toBe(1);
    rmSync(join(root, 'data/database-maintenance'), { recursive: true });
    const production = { ...target, database: 'example_production' };
    const blocked = operation(source, production);
    expect(run(['--verify-database', blocked.id], production).status).toBe(1);
    expect(events()).not.toContain('connected');
  });

  it.each(['schema', 'identity', 'throw', 'journal'])('refuses %s failure without leaking details or opening admission', failure => {
    const record = operation();
    const result = run(['--verify-database', record.id], target, { EXAMPLE_PROBE_FAILURE: failure });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('example-secret');
    expect(result.stderr).toContain('maintenance remains fenced');
    expect(events()).toContain('ROLLBACK');
    expect(events().at(-1)).toBe('closed');
    expect(journal.isFenced()).toBe(true);
  });

  it('requires the same operation again on restart and never treats a verified stage as admission', () => {
    const record = operation(source, target, 'verified');
    for (let restart = 0; restart < 2; restart++) {
      const result = run(['--verify-database', record.id]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ id: record.id, stage: 'verified', fenced: true });
      expect(run([], source).status).toBe(1);
    }
    expect(journal.read()).toEqual(record);
  });
});
