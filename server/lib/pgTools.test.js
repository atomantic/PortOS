/**
 * Unit tests for the shared pg_dump resolver (server/lib/pgTools.js).
 *
 * - pickPgDump — the pure closest-major selection (server-version-aware).
 * - discoverPgDumpCandidates — enumerates PATH + Homebrew/Postgres.app kegs and
 *   probes each binary's `--version`.
 * - resolvePgDump — discovery + pick + the `satisfies` verdict.
 * - resolvePgDumpBinary — the full override-or-auto decision both consumers
 *   (backup.js, routes/database.js) share: PORTOS_PGDUMP wins, else auto-select
 *   when the server version is known, else bare `pg_dump`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock readdir (keg enumeration) and execFileAsync (version probe) so discovery
// runs against a controlled filesystem/version map instead of the host.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readdir: vi.fn(async () => []) };
});
vi.mock('./fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileAsync: vi.fn(async () => ({ stdout: '' })) };
});

import { readdir } from 'fs/promises';
import { execFileAsync } from './fileUtils.js';
import {
  pickPgDump,
  discoverPgDumpCandidates,
  resolvePgDump,
  resolvePgDumpBinary,
} from './pgTools.js';

describe('pickPgDump', () => {
  const c = (major, binary = `pg_dump@${major}`) => ({ binary, major });

  it('returns null when no candidates were discovered', () => {
    expect(pickPgDump(17, [])).toBeNull();
    expect(pickPgDump(17, undefined)).toBeNull();
  });

  it('picks the exact-major binary when one is installed', () => {
    const chosen = pickPgDump(17, [c(15), c(17), c(16)]);
    expect(chosen).toBe('pg_dump@17');
  });

  it('picks the closest binary that is >= the server (newer is fine, never older)', () => {
    // server 16: 15 is too old, choose 17 (smallest qualifying), not 18.
    expect(pickPgDump(16, [c(15), c(17), c(18)])).toBe('pg_dump@17');
  });

  it('falls back to the newest available when nothing is new enough (forces a clear mismatch error)', () => {
    // This is the reported bug: server 17, only pg_dump 15 installed.
    expect(pickPgDump(17, [c(15)])).toBe('pg_dump@15');
    expect(pickPgDump(17, [c(14), c(15)])).toBe('pg_dump@15');
  });

  it('trusts the first (PATH) candidate when the server version is unknown', () => {
    expect(pickPgDump(null, [c(15, 'pg_dump'), c(17)])).toBe('pg_dump');
    expect(pickPgDump(NaN, [c(15, 'pg_dump'), c(17)])).toBe('pg_dump');
  });
});

describe('discoverPgDumpCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockResolvedValue([]);
  });

  it('always probes the bare PATH pg_dump and filters out non-runnable binaries', async () => {
    // No kegs on disk; only PATH pg_dump exists at major 16.
    execFileAsync.mockImplementation(async (binary) =>
      binary === 'pg_dump' ? { stdout: 'pg_dump (PostgreSQL) 16.4 (Homebrew)' } : { stdout: '' }
    );
    const candidates = await discoverPgDumpCandidates();
    expect(candidates).toEqual([{ binary: 'pg_dump', major: 16 }]);
  });

  it('enumerates Homebrew kegs and keeps PATH ahead of them (priority order)', async () => {
    // /opt/homebrew/opt has postgresql@15 and postgresql@17 kegs.
    readdir.mockImplementation(async (dir) =>
      dir === '/opt/homebrew/opt' ? ['postgresql@15', 'postgresql@17', 'somethingelse'] : []
    );
    const versions = {
      'pg_dump': '15.10',
      '/opt/homebrew/opt/postgresql@15/bin/pg_dump': '15.10',
      '/opt/homebrew/opt/postgresql@17/bin/pg_dump': '17.2',
    };
    execFileAsync.mockImplementation(async (binary) => ({
      stdout: versions[binary] ? `pg_dump (PostgreSQL) ${versions[binary]}` : '',
    }));
    const candidates = await discoverPgDumpCandidates();
    // PATH binary first, then the kegs; the non-postgresql entry is ignored.
    expect(candidates[0]).toEqual({ binary: 'pg_dump', major: 15 });
    expect(candidates.map(c => c.binary)).toContain('/opt/homebrew/opt/postgresql@17/bin/pg_dump');
    expect(candidates.find(c => c.binary.includes('postgresql@17')).major).toBe(17);
  });
});

describe('resolvePgDump', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockResolvedValue([]);
  });

  it('selects a satisfying binary and reports satisfies=true', async () => {
    readdir.mockImplementation(async (dir) =>
      dir === '/opt/homebrew/opt' ? ['postgresql@17'] : []
    );
    const versions = {
      'pg_dump': '15.10',
      '/opt/homebrew/opt/postgresql@17/bin/pg_dump': '17.2',
    };
    execFileAsync.mockImplementation(async (binary) => ({
      stdout: versions[binary] ? `pg_dump (PostgreSQL) ${versions[binary]}` : '',
    }));
    const { binary, satisfies } = await resolvePgDump(17);
    expect(binary).toBe('/opt/homebrew/opt/postgresql@17/bin/pg_dump');
    expect(satisfies).toBe(true);
  });

  it('reports satisfies=false when nothing installed is new enough', async () => {
    // Only an old PATH pg_dump 15 against a server 17.
    execFileAsync.mockImplementation(async (binary) =>
      binary === 'pg_dump' ? { stdout: 'pg_dump (PostgreSQL) 15.10' } : { stdout: '' }
    );
    const { binary, satisfies } = await resolvePgDump(17);
    expect(binary).toBe('pg_dump');
    expect(satisfies).toBe(false);
  });
});

describe('resolvePgDumpBinary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockResolvedValue([]);
  });
  afterEach(() => {
    delete process.env.PORTOS_PGDUMP;
  });

  it('honors the PORTOS_PGDUMP override outright, even when the server version is known', async () => {
    process.env.PORTOS_PGDUMP = '/custom/bin/pg_dump';
    const result = await resolvePgDumpBinary(17);
    expect(result).toEqual({ binary: '/custom/bin/pg_dump', satisfies: true });
    // Override short-circuits before discovery — no version probing.
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('honors the PORTOS_PGDUMP override even when the server version is unknown', async () => {
    process.env.PORTOS_PGDUMP = '/custom/bin/pg_dump';
    const result = await resolvePgDumpBinary(null);
    expect(result).toEqual({ binary: '/custom/bin/pg_dump', satisfies: true });
  });

  it('auto-selects via resolvePgDump when the server version is known and no override is set', async () => {
    execFileAsync.mockImplementation(async (binary) =>
      binary === 'pg_dump' ? { stdout: 'pg_dump (PostgreSQL) 17.2' } : { stdout: '' }
    );
    const result = await resolvePgDumpBinary(17);
    expect(result.binary).toBe('pg_dump');
    expect(result.satisfies).toBe(true);
  });

  it('falls back to bare pg_dump (no discovery) when the server version is unknown', async () => {
    const result = await resolvePgDumpBinary(null);
    expect(result).toEqual({ binary: 'pg_dump', satisfies: true });
    // Unknown version + no override ⇒ skip discovery I/O entirely.
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});
