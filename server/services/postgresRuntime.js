/**
 * The running PostgreSQL server's version and its release line, for the
 * Settings › Software row. The project's versions.json is the release source:
 * it lists every major's latest minor and end-of-life date. Read-only.
 */
import { query } from '../lib/db.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';

const VERSIONS_URL = 'https://www.postgresql.org/versions.json';
const RELEASES_TTL_MS = 6 * 60 * 60 * 1000;

let releaseCache = null; // null = not fetched; { at, lines } once fetched

async function readReleaseLines({ fresh, fetchImpl = fetchWithTimeout, now = Date.now() } = {}) {
  if (!fresh && releaseCache && now - releaseCache.at < RELEASES_TTL_MS) return releaseCache.lines;
  const res = await fetchImpl(VERSIONS_URL, { headers: { Accept: 'application/json' } }, 10_000);
  if (!res.ok) throw new Error(`postgresql.org versions.json returned HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('postgresql.org versions.json is not a list');
  const lines = body.filter((line) => /^\d+$/.test(String(line?.major)));
  releaseCache = { at: now, lines };
  return lines;
}

/**
 * @param {{fresh?: boolean, env?: object, readVersion?: Function, fetchImpl?: Function}} [options]
 * @returns {Promise<{version: string|null, major: number|null, build: string|null, mode: 'native'|'docker',
 *   line: {latestMinor: string, eolDate: string, supported: boolean}|null, releasesError: string|null}>}
 */
export async function getPostgresRuntimeStatus({ fresh = false, env = process.env, readVersion, fetchImpl } = {}) {
  const read = readVersion || (async () => (await query('SHOW server_version')).rows[0]?.server_version);
  const [raw, releases] = await Promise.all([
    read(),
    readReleaseLines({ fresh, fetchImpl }).then((lines) => ({ lines }), (err) => ({ error: err.message })),
  ]);
  const match = String(raw || '').match(/^(\d+)\.(\d+)\s*(?:\((.+)\))?/);
  const major = match ? Number(match[1]) : null;
  const line = releases.lines?.find((l) => Number(l.major) === major) || null;
  return {
    version: match ? `${match[1]}.${match[2]}` : null,
    major,
    build: match?.[3] || null,
    // The ecosystem gives each process the active endpoint in PGPORT and the
    // native one in PORTOS_NATIVE_PGPORT; any other endpoint is the container.
    mode: env.PGPORT && env.PGPORT === env.PORTOS_NATIVE_PGPORT ? 'native' : 'docker',
    line: line ? { latestMinor: String(line.latestMinor), eolDate: line.eolDate, supported: line.supported !== false } : null,
    releasesError: releases.error || (major && !line ? `postgresql.org lists no PostgreSQL ${major} line.` : null),
  };
}

export const __testing = { resetReleaseCache: () => { releaseCache = null; } };
