#!/usr/bin/env node
// Throwaway Postgres databases for the upgrade-and-restore rehearsal.
//
//   node scripts/rehearsal-scratch-db.js create [--empty]   -> {"ok":true,"action":"create","database":"portos_rehearsal_<id>_test",...}
//   node scripts/rehearsal-scratch-db.js drop <name>
//
// Output is one JSON object on stdout; a refusal or failure exits non-zero with
// {"ok":false,"error":...}. The `_test` suffix is deliberate: server/lib/db.js
// isTestDatabase() accepts /_test$/, so the test-runner gate stays armed for a
// rehearsal that points PGDATABASE here and can never be aimed at `portos`.
// `create` applies server/scripts/init-db.sql (the base schema ensureSchema() builds on, as
// `npm run setup:db:test` does) unless --empty asks for a bare database. It clones portos_test
// when that already has the extensions, so a role without superuser needs only CREATEDB.
// `drop` is the only destructive verb and refuses every name that this helper
// would not have created — including `portos` and `portos_test`.

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import databaseSettings from './lib/databaseSettings.cjs';
import { parseEnvFile } from './lib/envFile.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SCRATCH_DB_PATTERN = /^portos_rehearsal_[a-f0-9]{12}_test$/;

export const newScratchDbName = () => `portos_rehearsal_${randomBytes(6).toString('hex')}_test`;

/** Throws unless `name` is a database this helper could have created. */
export function assertScratchDbName(name) {
  if (typeof name !== 'string' || !SCRATCH_DB_PATTERN.test(name)) {
    throw new Error(`refusing "${String(name).slice(0, 80)}": only portos_rehearsal_<12 hex>_test databases may be created or dropped here`);
  }
  return name;
}

// `.env` is untracked, so a linked worktree has none; the primary checkout that owns the
// worktree's git directory holds the install's database settings.
function findEnvFile(root) {
  const own = join(root, '.env');
  if (existsSync(own)) return own;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return join(dirname(common), '.env');
  } catch {
    return own;
  }
}

/** Connection to the install's Postgres, same resolution as scripts/setup-db.js. */
export function resolveAdminConnection({ env = process.env, root = rootDir } = {}) {
  const settings = databaseSettings.resolveDatabaseSettings({ env, saved: parseEnvFile(findEnvFile(root)) });
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    // CREATE/DROP DATABASE cannot run inside the target; `postgres` always exists.
    database: env.PGADMINDATABASE || 'postgres',
  };
}

const loadPg = () => createRequire(join(rootDir, 'server', 'package.json'))('pg');

async function withAdmin(connection, fn) {
  const { Client } = loadPg();
  const client = new Client({ ...connection, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

const INIT_SQL = join(rootDir, 'server', 'scripts', 'init-db.sql');

async function applyBaseSchema(connection, database) {
  const { Client } = loadPg();
  const client = new Client({ ...connection, database, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query(readFileSync(INIT_SQL, 'utf8'));
  } finally {
    await client.end().catch(() => {});
  }
}

// `vector` and `pgcrypto` need a role that can create extensions, which the ordinary application
// role is not. A database cloned from the test database carries them, so that role needs only CREATEDB.
export const TEMPLATE_DATABASE = 'portos_test';
const REQUIRED_EXTENSIONS = ['vector', 'pgcrypto'];
const REPAIR_HINT = 'run `npm run setup:db:test`, or see docs/CONTRIBUTING.md "Repairing a test database whose extensions were dropped"';

// Identifiers are interpolated (DDL cannot be parameterized) only after assertScratchDbName has
// matched the fixed pattern; the template is the TEMPLATE_DATABASE constant.
export const createScratchDbSql = (database, template = null) =>
  `CREATE DATABASE "${assertScratchDbName(database)}"${template ? ` TEMPLATE "${template}"` : ''}`;

/** The template database when it exists and already has every required extension, else null. */
async function findExtensionTemplate(connection) {
  const { Client } = loadPg();
  const client = new Client({ ...connection, database: TEMPLATE_DATABASE, connectionTimeoutMillis: 5000 });
  const connected = await client.connect().then(() => true, () => false);
  if (!connected) return null;
  try {
    const { rows } = await client.query('SELECT extname FROM pg_extension WHERE extname = ANY($1)', [REQUIRED_EXTENSIONS]);
    return rows.length === REQUIRED_EXTENSIONS.length ? TEMPLATE_DATABASE : null;
  } finally {
    await client.end().catch(() => {});
  }
}

/** One actionable line for the Postgres failures this helper can hit; any other error passes through. */
export function explainScratchDbError(err, { templateBusy = false } = {}) {
  const busy = templateBusy ? ` (${TEMPLATE_DATABASE} was in use by another session so it could not be cloned: stop other DB test runs and retry)` : '';
  if (err.code === '55006') return new Error(`cannot clone ${TEMPLATE_DATABASE} while another session is connected to it: stop other DB test runs and retry`, { cause: err });
  if (err.code === '42501' && /create extension/i.test(err.message)) {
    return new Error(`the database role cannot create the vector/pgcrypto extensions and has no ${TEMPLATE_DATABASE} copy to clone: ${REPAIR_HINT}${busy}`, { cause: err });
  }
  if (err.code === '42501') return new Error(`the database role lacks CREATEDB, which creating a scratch database needs${busy}`, { cause: err });
  return err;
}

export async function createScratchDb(connection = resolveAdminConnection(), { empty = false } = {}) {
  const database = assertScratchDbName(newScratchDbName());
  let template = empty ? null : await findExtensionTemplate(connection);
  let templateBusy = false;
  const create = tpl => withAdmin(connection, client => client.query(createScratchDbSql(database, tpl)));
  try {
    await create(template).catch(err => {
      // A busy template only blocks the clone; a superuser can still build from init-db.sql.
      if (!template || err.code !== '55006') throw err;
      templateBusy = true;
      template = null;
      return create(null);
    });
  } catch (err) {
    throw explainScratchDbError(err, { templateBusy });
  }
  try {
    if (!empty) await applyBaseSchema(connection, database);
  } catch (err) {
    // A half-built scratch database is never handed back; drop it before reporting the failure.
    await dropScratchDb(database, connection).catch(() => {});
    throw explainScratchDbError(err, { templateBusy });
  }
  const { host, port, user } = connection;
  return { database, host, port, user, baseSchema: !empty };
}

export async function dropScratchDb(name, connection = resolveAdminConnection()) {
  const database = assertScratchDbName(name);
  // WITH (FORCE) disconnects a straggling rehearsal server so cleanup on a failed run still succeeds.
  await withAdmin(connection, client => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
  return { database };
}

// A refused connection surfaces as an AggregateError with an empty message (one per address family).
export const describeError = err => err.message || [err.code, ...(err.errors ?? []).map(e => e.code)].filter(Boolean).join('/') || String(err);

async function main(argv) {
  const [action, name] = argv;
  if (action === 'create') return { action, ...await createScratchDb(undefined, { empty: argv.includes('--empty') }) };
  if (action === 'drop') return { action, ...await dropScratchDb(name) };
  throw new Error('usage: rehearsal-scratch-db.js create [--empty] | drop <portos_rehearsal_<id>_test>');
}

if (isDirectlyInvoked(import.meta.url)) {
  main(process.argv.slice(2))
    .then(result => console.log(JSON.stringify({ ok: true, ...result })))
    .catch(err => {
      console.log(JSON.stringify({ ok: false, error: describeError(err) }));
      process.exit(1);
    });
}
