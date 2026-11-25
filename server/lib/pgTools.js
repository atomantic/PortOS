/**
 * PostgreSQL client binary resolution and libpq env helpers.
 *
 * `resolvePgDumpBinary` and `resolvePsqlBinary` honor operator overrides and
 * discover clients in PATH, Homebrew kegs and Postgres.app. `withPgToolEnv`
 * stages Node trust roots and isolates libpq settings from inherited PG variables.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { getCACertificates } from 'node:tls';
import { join } from 'path';
import { execFileAsync } from './fileUtils.js';

/**
 * Choose the closest client major >= the server's, preserving discovery order on ties.
 *
 * @param {number|null} serverMajor - server's PG major version (null = unknown)
 * @param {Array<{binary: string, major: number}>} candidates - runnable clients
 * @returns {string|null} chosen binary path, or null if none discovered
 */
function pickPgTool(serverMajor, candidates) {
  if (!candidates?.length) return null;
  // Unknown server version: trust the first (PATH) entry.
  if (!Number.isFinite(serverMajor)) return candidates[0].binary;
  // Smallest major that satisfies >= server (avoids a wildly newer keg when an exact one exists).
  const viable = candidates.filter(c => c.major >= serverMajor).sort((a, b) => a.major - b.major);
  if (viable.length) return viable[0].binary;
  // Nothing is new enough: return the newest so the error is a clear "still too old" and dumpPostgres can flag version_mismatch.
  return [...candidates].sort((a, b) => b.major - a.major)[0].binary;
}

export { pickPgTool as pickPgDump };

async function discoverPgToolCandidates(tool) {
  const paths = [tool];
  const kegDirs = ['/opt/homebrew/opt', '/usr/local/opt', '/Applications/Postgres.app/Contents/Versions'];
  for (const dir of kegDirs) {
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (dir.endsWith('Versions') || entry.startsWith('postgresql')) {
        paths.push(join(dir, entry, 'bin', tool));
      }
    }
  }
  // Promise.all preserves PATH priority for candidates with equal versions.
  const probed = await Promise.all(paths.map(async binary => {
    const { stdout } = await execFileAsync(binary, ['--version']).catch(() => ({ stdout: '' }));
    const version = stdout.match(/PostgreSQL\)\s+(\d+)(?:\.(\d+))?/i);
    return version && { binary, major: Number(version[1]), minor: Number(version[2] ?? 0) };
  }));
  return probed.filter(Boolean);
}

export async function discoverPgDumpCandidates() {
  const candidates = await discoverPgToolCandidates('pg_dump');
  return candidates.map(({ binary, major }) => ({ binary, major }));
}

/**
 * Auto-select a pg_dump for a server at `serverMajor` by discovering installed binaries; returns the path and whether it satisfies the server's version (false ⇒ the dump will fail with a mismatch).
 * The `PORTOS_PGDUMP` override is handled by the caller (`resolvePgDumpBinary`) so it works even when the server version is unknown.
 *
 * @param {number} serverMajor - known server major (caller guards on isFinite)
 * @returns {Promise<{binary: string, satisfies: boolean}>}
 */
export async function resolvePgDump(serverMajor) {
  const candidates = await discoverPgDumpCandidates();
  const binary = pickPgTool(serverMajor, candidates) || 'pg_dump';
  const chosen = candidates.find(c => c.binary === binary);
  const satisfies = !Number.isFinite(serverMajor) || !chosen || chosen.major >= serverMajor;
  return { binary, satisfies };
}

/**
 * The full pg_dump-binary decision shared by every consumer: an explicit PORTOS_PGDUMP always wins (the escape hatch must work when version detection failed); else with a known server version, auto-select
 * a major >= it; else bare `pg_dump` without discovery I/O. `satisfies` is false only when a known server version has no new-enough binary, so the caller can warn before the dump fails.
 *
 * @param {number|null} serverMajor - server's PG major (null/NaN = unknown)
 * @returns {Promise<{binary: string, satisfies: boolean}>}
 */
export async function resolvePgDumpBinary(serverMajor) {
  if (process.env.PORTOS_PGDUMP) {
    // user forced it; the stderr classifier still catches a too-old pick
    return { binary: process.env.PORTOS_PGDUMP, satisfies: true };
  }
  if (Number.isFinite(serverMajor)) {
    return resolvePgDump(serverMajor);
  }
  return { binary: 'pg_dump', satisfies: true };
}

/** Select the closest suitable psql major, favoring the newest patch within it. */
export async function resolvePsqlBinary(serverMajor) {
  if (process.env.PORTOS_PSQL) return process.env.PORTOS_PSQL;
  const candidates = await discoverPgToolCandidates('psql');
  // Patched clients can understand dump commands that older clients in the
  // same release series reject (e.g. \restrict).
  candidates.sort((a, b) => b.major - a.major || b.minor - a.minor);
  return pickPgTool(serverMajor, candidates) ?? 'psql';
}

/** Build a libpq environment from the pool's captured connection policy.
 * Keep executable resolution and locale, but never inherit a second PG policy.
 * Inline certificate material needs a separate managed-file adapter; refuse it
 * rather than silently sending a child with weaker authentication.
 */
function buildPgToolEnv(config, inherited = process.env, rootCertPath) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^PG/i.test(key)));
  const ssl = config.ssl;
  if (ssl && typeof ssl === 'object' && Object.keys(ssl).some(key => key !== 'rejectUnauthorized')) {
    throw new Error('PostgreSQL tools do not support inline pool TLS certificate settings');
  }
  env.PGPASSWORD = config.password;
  env.PGSSLMODE = ssl ? (ssl.rejectUnauthorized === false ? 'require' : 'verify-full') : 'disable';
  if (env.PGSSLMODE === 'verify-full') {
    if (!rootCertPath) throw new Error('Verified PostgreSQL TLS requires a managed root certificate file');
    env.PGSSLROOTCERT = rootCertPath;
  }
  // libpq's require mode verifies a default root.crt when one exists. An
  // intentionally absent, unique path preserves node-postgres no-verify TLS.
  if (env.PGSSLMODE === 'require') env.PGSSLROOTCERT = join(tmpdir(), `portos-unused-root-${randomUUID()}.crt`);
  // libpq otherwise discovers client identity files in the user's home; the
  // pool does not load them. Missing explicit paths disable that discovery.
  const unusedIdentity = join(tmpdir(), `portos-unused-identity-${randomUUID()}`);
  env.PGSSLCERT = `${unusedIdentity}.crt`;
  env.PGSSLKEY = `${unusedIdentity}.key`;
  env.PGSSLNEGOTIATION = config.sslnegotiation || 'postgres';
  return env;
}

/** Run a tool with the Node TLS trust roots in a private, temporary PEM file.
 * Explicit files work on older supported libpq versions too. Cleanup covers
 * successful children, spawn failures, timeouts and rejected callbacks.
 */
export async function withPgToolEnv(config, run) {
  if (!config.ssl || config.ssl.rejectUnauthorized === false) return run(buildPgToolEnv(config));
  const dir = await mkdtemp(join(tmpdir(), 'portos-pg-tls-'));
  return (async () => {
    const path = join(dir, 'roots.pem');
    await writeFile(path, getCACertificates('default').join('\n'), { mode: 0o600 });
    return run(buildPgToolEnv(config, process.env, path));
  })().finally(() => rm(dir, { recursive: true, force: true }));
}
