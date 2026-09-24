/**
 * Opt-in synthetic collection instance. Parent owns every resource; the child
 * imports application modules only after its environment has been isolated.
 */
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { isDirectlyInvoked } from '../lib/directInvocation.js';

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function validateFixtureEnvironment(env = process.env, host = '127.0.0.1') {
  if (host !== '127.0.0.1') throw new Error('Fixture bind must be 127.0.0.1');
  if (env.PORTOS_DATA_ROOT) throw new Error('Unset PORTOS_DATA_ROOT; the fixture creates its own root');
  if (env.PGDATABASE && env.PGDATABASE !== 'portos_test') throw new Error('Fixture requires portos_test');
  if (env.PGHOST && !['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST)) {
    throw new Error('Fixture PostgreSQL must be on loopback');
  }
  if (env.PGSERVICE || env.PGSERVICEFILE || env.DATABASE_URL) throw new Error('Remove alternate database configuration');
}

/** Each invocation returns { url, cardinalities, close }; close is idempotent. */
export async function startCollectionFixture({
  env = process.env, host = '127.0.0.1', clientDist = join(codeRoot, 'client/dist'),
} = {}) {
  validateFixtureEnvironment(env, host);
  await access(join(clientDist, 'index.html'));
  const require = createRequire(join(codeRoot, 'server/package.json'));
  const { Client } = require('pg');
  const schema = 'collection_audit_' + randomUUID().replaceAll('-', '');
  const dbConfig = { host: env.PGHOST || '127.0.0.1', port: Number(env.PGPORT || 5432),
    database: 'portos_test', user: env.PGUSER || 'portos', password: env.PGPASSWORD || 'portos',
    options: '', connectionTimeoutMillis: 10000 };
  const db = new Client(dbConfig);
  let root;
  let child;
  let schemaCreated = false;
  let closing;
  let stopped = false;
  let finishSetup;
  const setupFinished = new Promise(resolveSetup => { finishSetup = resolveSetup; });
  const close = () => closing ||= (async () => {
    await setupFinished;
    let cleanupError;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(killTimer);
    }
    // Never touch public/shared tables. This unguessable schema is created by
    // this invocation and is the only database object cleanup can drop.
    try {
      if (schemaCreated) await db.query('DROP SCHEMA "' + schema + '" CASCADE');
    } catch (error) { cleanupError = error; }
    await db.end().catch(error => { cleanupError ||= error; });
    if (root) await rm(root, { recursive: true, force: true });
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (cleanupError) throw cleanupError;
  })();
  const onSignal = () => { stopped = true; close().catch(() => { process.exitCode = 1; }); };
  db.on('error', onSignal);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), 'portos-collection-audit-')));
    // Copy code, never data, configuration, credentials, or the live checkout's
    // symlinks. A physical temp copy also preserves dataRoot's worktree guard.
    const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--', 'server', 'lib'], { cwd: codeRoot });
    for (const file of stdout.split('\0').filter(Boolean)) {
      if (file === 'lib/slashdo' || file.endsWith('.test.js') || file.endsWith('.test.jsx')) continue;
      if (!(await lstat(join(codeRoot, file))).isFile()) throw new Error('Fixture source must contain regular files');
      await mkdir(dirname(join(root, file)), { recursive: true });
      await cp(join(codeRoot, file), join(root, file), { dereference: false });
    }
    await mkdir(join(root, 'scripts/perf'), { recursive: true });
    for (const file of ['collectionFixtureWorker.js', 'collectionFixtureData.js']) {
      await cp(join(codeRoot, 'scripts/perf', file), join(root, 'scripts/perf', file));
    }
    await cp(join(codeRoot, 'scripts/perf/assets'), join(root, 'scripts/perf/assets'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await symlink(join(codeRoot, 'server/node_modules'), join(root, 'server/node_modules'), 'junction');
    await db.connect();
    const identity = await db.query('SELECT current_database() AS name');
    if (identity.rows[0].name !== 'portos_test') throw new Error('Connected database is not portos_test');
    await db.query('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;
    // An allowlist prevents API tokens, provider keys, proxy settings, NODE_OPTIONS,
    // user home configuration, and inherited test escape hatches reaching reads.
    if (stopped) throw new Error('Fixture startup interrupted');
    child = fork(join(root, 'scripts/perf/collectionFixtureWorker.js'), [], {
      cwd: root, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        NODE_ENV: 'production', PORTOS_DATA_ROOT: root,
        HOME: root, USERPROFILE: root, TMPDIR: root,
        PGHOST: dbConfig.host, PGPORT: String(dbConfig.port), PGDATABASE: 'portos_test',
        PGUSER: dbConfig.user, PGPASSWORD: dbConfig.password,
        PGOPTIONS: '-csearch_path=' + schema, COLLECTION_FIXTURE_SCHEMA: schema,
        COLLECTION_FIXTURE_CLIENT: resolve(clientDist),
      },
    });
    // Drain diagnostics without leaking paths, payloads, or credentials into reports.
    child.stderr.resume();
    const ready = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Collection fixture readiness timed out')), 30000);
      const finish = (error, value) => {
        clearTimeout(timer);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.removeListener('message', onMessage);
        error ? rejectReady(error) : resolveReady(value);
      };
      const onError = () => finish(new Error('Collection fixture child failed to start'));
      const onExit = () => finish(new Error('Collection fixture child exited before readiness'));
      const onMessage = message => {
        if (message?.type === 'ready') finish(null, message);
        if (message?.type === 'failed') finish(new Error('Collection fixture initialization failed at ' + message.phase));
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    });
    if (stopped) throw new Error('Fixture startup interrupted');
    finishSetup();
    child.once('exit', () => { close().catch(() => { process.exitCode = 1; }); });
    return { url: ready.url, cardinalities: ready.cardinalities, close };
  } catch (error) {
    finishSetup();
    await close();
    throw error;
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  startCollectionFixture().then(fixture => {
    console.log(JSON.stringify({ ready: true, url: fixture.url, cardinalities: fixture.cardinalities }));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
