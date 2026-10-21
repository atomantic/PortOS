/**
 * Prerequisite probes and stage environments for the resource suites pregate
 * runs locally: the serial Postgres suite and the cross-workspace browser
 * suites. Loaded by `scripts/pregate.js` only when a plan selects one of them,
 * because this module reaches installed packages (`pg`, `playwright-core`) and
 * server modules that a bare checkout does not have.
 *
 * A probe answers "can this machine honestly run the suite CI would run"; it
 * never substitutes for the suite. A failed probe leaves the suite reported
 * as not covered, with the remedy, rather than a green stage that ran nothing.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import databaseSettings from './databaseSettings.cjs';
import { parseEnvFile } from './envFile.js';
import { findFfmpeg } from '../../server/lib/ffmpeg.js';
import { browserSuiteBlockReason, chromeWithH264, resolveClientBundler, resolveTestChrome } from '../../server/lib/browserSuiteGate.js';

/** The only database the DB stage may target; `server/lib/db.js` refuses the rest. */
export const TEST_DATABASE = 'portos_test';

// libpq routing variables that would redirect a connection away from the
// explicit PGHOST/PGPORT; dropped for the same reason scripts/setup-db.js drops them.
const ROUTING_ENV = ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS'];

/** The suite whose guard also needs a Chrome that decodes H.264. */
const H264_SUITE = 'server/services/musicVideo/documentRender.browser.test.js';

/**
 * Environment for the DB stages, pinned to `portos_test`.
 *
 * Host, port, user and password resolve the way `scripts/setup-db.js` resolves
 * them (exported env, then the checkout's saved `.env`, then the documented
 * defaults). The port follows PGMODE only when a mode is declared; otherwise it
 * is the native port `npm run test:db` already connects to. The database name
 * is not negotiable: both `PGDATABASE` and `PGTESTDATABASE` are forced, and
 * `TEST_DB_OK` is removed so an operator's shell cannot re-admit a non-test
 * database under the runner.
 */
export function testDatabaseStageEnv({ env = {}, saved = {} } = {}) {
  const settings = databaseSettings.resolveDatabaseSettings({ env, saved });
  const modeDeclared = Boolean(env.PGMODE || saved.PGMODE);
  const port = modeDeclared ? settings.port : settings.nativePort;
  return {
    PGHOST: settings.host,
    PGPORT: String(port),
    PGUSER: settings.user,
    PGPASSWORD: settings.password,
    PGDATABASE: TEST_DATABASE,
    PGTESTDATABASE: TEST_DATABASE,
    PORTOS_REQUIRE_DB: '1',
    TEST_DB_OK: undefined,
    ...Object.fromEntries(ROUTING_ENV.map((name) => [name, undefined])),
  };
}

/** The DB stage environment for a checkout, honoring its saved `.env`. */
export function resolveTestDatabaseStageEnv(repoRoot, env = process.env) {
  return testDatabaseStageEnv({ env, saved: parseEnvFile(join(repoRoot, '.env')) });
}

/**
 * Is a Postgres answering at the DB stage's endpoint? A missing `portos_test`
 * is fine (the provisioning stage creates it); an unreachable server, refused
 * credentials or an absent `pg` package are not. The reason stays free of
 * host and port so it can travel in the receipt; the endpoint is printed
 * separately for the operator.
 */
export async function probeTestDatabase(stageEnv, { repoRoot }) {
  const endpoint = `${stageEnv.PGHOST}:${stageEnv.PGPORT}/${TEST_DATABASE}`;
  let pg;
  try {
    pg = createRequire(join(repoRoot, 'server', 'package.json'))('pg');
  } catch (error) {
    return { ok: false, endpoint, reason: `pg package unavailable (${error.code ?? error.message})` };
  }
  const client = new pg.Client({
    host: stageEnv.PGHOST,
    port: Number(stageEnv.PGPORT),
    user: stageEnv.PGUSER,
    password: stageEnv.PGPASSWORD,
    database: TEST_DATABASE,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true, endpoint, provision: false };
  } catch (error) {
    // 3D000: the database does not exist yet — `npm run setup:db:test` creates it.
    if (error.code === '3D000') return { ok: true, endpoint, provision: true };
    return { ok: false, endpoint, reason: `Postgres not reachable (${error.code ?? error.message})` };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Discover what the selected browser suites' `canRun` guards will look for —
 * Chrome, ffmpeg, the client bundler and, for the document renderer, H.264
 * decode — and return the guards' own wording when something is missing.
 */
export async function probeBrowserPrerequisites(files, { repoRoot, env = process.env }) {
  const chrome = resolveTestChrome(env) ?? undefined;
  const bundler = resolveClientBundler(repoRoot);
  const prerequisites = {
    Chrome: chrome,
    ffmpeg: await findFfmpeg(),
    'client workspace dependencies': bundler,
  };
  if (files.includes(H264_SUITE)) prerequisites['Chrome with H.264'] = await chromeWithH264(chrome);
  const reason = browserSuiteBlockReason(prerequisites);
  if (reason === null) return { ok: true, chrome };
  // A probe that ran and failed (timeout, teardown) says nothing about whether the tool is installed.
  const found = Object.values(prerequisites);
  const probeFailed = found.some((entry) => entry?.probeFailure);
  const missing = found.some((entry) => !entry);
  const category = probeFailed && missing ? 'missing-and-probe-failed' : probeFailed ? 'probe-failed' : 'missing';
  return { ok: false, reason, category };
}
