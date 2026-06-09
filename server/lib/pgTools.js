/**
 * pg_dump binary resolution.
 *
 * `pg_dump` REFUSES to dump a server newer than itself ("server version
 * mismatch"), but a newer `pg_dump` dumps an older server fine. On machines
 * with multiple Postgres installs (the common Homebrew case: an old
 * `postgresql@NN` keg shadowing a newer running server in PATH) the bare
 * `pg_dump` is often the wrong one, so these helpers discover the installed
 * binaries and select the closest whose major is >= the running server's.
 *
 * Shared by both pg_dump consumers — the backup snapshot path
 * (`server/services/backup.js`) and the native↔Docker backend-copy / export
 * path (`server/routes/database.js`) — so the version-aware selection and the
 * `PORTOS_PGDUMP` override behave identically in both. Self-contained: no
 * imports out to other PortOS services.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { execFileAsync } from './fileUtils.js';

/**
 * Choose which discovered pg_dump binary to run, given the server's major
 * version. pg_dump REFUSES to dump a server newer than itself ("server version
 * mismatch"), but a newer pg_dump dumps an older server fine — so the rule is:
 * pick the closest binary whose major is >= the server's.
 *
 * Pure + exported for unit testing (the IO-bound discovery lives in
 * resolvePgDump, which feeds this the runnable candidates it found).
 *
 * @param {number|null} serverMajor - server's PG major version (null = unknown)
 * @param {Array<{binary: string, major: number}>} candidates - runnable pg_dumps
 * @returns {string|null} chosen binary path, or null if none discovered
 */
export function pickPgDump(serverMajor, candidates) {
  if (!candidates?.length) return null;
  // Unknown server version: keep prior behavior — trust the first (PATH) entry.
  if (!Number.isFinite(serverMajor)) return candidates[0].binary;
  // Prefer the smallest major that still satisfies >= server (closest match,
  // avoids reaching for a wildly newer keg when an exact one is installed).
  const viable = candidates.filter(c => c.major >= serverMajor).sort((a, b) => a.major - b.major);
  if (viable.length) return viable[0].binary;
  // Nothing is new enough. Return the newest we have so the resulting error is a
  // clear "still too old" instead of an arbitrary pick — and so the version
  // detection in dumpPostgres can flag it as version_mismatch.
  return [...candidates].sort((a, b) => b.major - a.major)[0].binary;
}

/**
 * Read a pg_dump binary's major version, or null if it isn't runnable.
 * `pg_dump --version` prints e.g. "pg_dump (PostgreSQL) 17.10 (Homebrew)".
 */
async function pgDumpMajor(binary) {
  const { stdout } = await execFileAsync(binary, ['--version']).catch(() => ({ stdout: '' }));
  const m = stdout.match(/PostgreSQL\)\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Enumerate candidate pg_dump locations: the bare PATH binary, then versioned
 * Homebrew kegs and Postgres.app bundles (where multiple majors coexist and
 * PATH order silently picks the wrong one).
 */
export async function discoverPgDumpCandidates() {
  // Note: the PORTOS_PGDUMP override is NOT a candidate here — resolvePgDumpBinary
  // honors it outright before discovery runs, so it's never subject to the
  // closest-major auto-selection below.
  const paths = ['pg_dump']; // whatever PATH resolves — preserves the old default
  const kegDirs = ['/opt/homebrew/opt', '/usr/local/opt', '/Applications/Postgres.app/Contents/Versions'];
  for (const dir of kegDirs) {
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (dir.endsWith('Versions') || entry.startsWith('postgresql')) {
        paths.push(join(dir, entry, 'bin', 'pg_dump'));
      }
    }
  }
  // Probe versions concurrently (each `pg_dump --version` is an independent
  // spawn); [...new Set(paths)] de-dups while preserving priority order, which
  // Promise.all keeps — so pickPgDump still sees PATH > kegs.
  const probed = await Promise.all(
    [...new Set(paths)].map(async (binary) => ({ binary, major: await pgDumpMajor(binary) }))
  );
  return probed.filter(c => c.major != null);
}

/**
 * Auto-select a pg_dump binary for a server at `serverMajor` by discovering
 * installed binaries and picking the closest whose major is >= the server's.
 * Returns the chosen path and whether it satisfies the server's version
 * (false ⇒ the dump will fail with a version mismatch and there's nothing
 * newer installed).
 *
 * The explicit `PORTOS_PGDUMP` override is NOT handled here — the caller
 * (`resolvePgDumpBinary`) honors it before reaching this resolver, so the
 * override works even when the server version is unknown and this resolver
 * is skipped.
 *
 * @param {number} serverMajor - known server major (caller guards on isFinite)
 * @returns {Promise<{binary: string, satisfies: boolean}>}
 */
export async function resolvePgDump(serverMajor) {
  const candidates = await discoverPgDumpCandidates();
  const binary = pickPgDump(serverMajor, candidates) || 'pg_dump';
  const chosen = candidates.find(c => c.binary === binary);
  const satisfies = !Number.isFinite(serverMajor) || !chosen || chosen.major >= serverMajor;
  return { binary, satisfies };
}

/**
 * The full pg_dump-binary decision shared by every consumer:
 *  - an explicit PORTOS_PGDUMP override always wins — the escape hatch must
 *    work even when version detection failed (its main use case);
 *  - else, when we know the server version, auto-select a binary whose major
 *    is >= it (resolvePgDump scans Homebrew kegs / Postgres.app);
 *  - else keep the prior behavior (bare `pg_dump` off PATH) without paying for
 *    discovery I/O we couldn't act on.
 *
 * `satisfies` is false only when a known server version has no new-enough
 * installed binary — the caller can warn before the dump fails with a clear
 * "server version mismatch".
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
