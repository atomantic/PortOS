import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  DEFAULT_PEER_PORT,
  DEFAULT_TAILCAT_LOCAL_PORT,
  DEFAULT_TAILCAT_REMOTE_PORT,
  PORTS,
  resolvePostgresPort,
} from './ports.js';

// `ecosystem.config.cjs` is the source of truth for port numbers; `ports.js` is a
// hand-maintained ESM mirror of it (the ESM server can't require() the CJS
// config). These tests fail when the two drift apart — see docs/PORTS.md.
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ecosystemPath = path.join(repoRoot, 'ecosystem.config.cjs');
const { PORTS: ECOSYSTEM_PORTS } = require(ecosystemPath);

// `POSTGRES` is resolved from PGMODE at config-load time, so it has no single
// literal counterpart in the mirror — it's covered by its own assertions below.
const RESOLVED_ONLY = ['POSTGRES'];
// The mirror keeps both PostgreSQL literals so callers can resolve either mode.
const MIRROR_ONLY = ['POSTGRES_NATIVE'];

describe('PORTS mirror of ecosystem.config.cjs', () => {
  it('mirrors every fixed port from the ecosystem config', () => {
    const expected = Object.fromEntries(
      Object.entries(ECOSYSTEM_PORTS).filter(([key]) => !RESOLVED_ONLY.includes(key))
    );
    const actual = Object.fromEntries(
      Object.entries(PORTS).filter(([key]) => !MIRROR_ONLY.includes(key))
    );
    expect(actual).toEqual(expected);
  });

  it('has no extra ports beyond the ecosystem config', () => {
    const extras = Object.keys(PORTS).filter(
      (key) => !(key in ECOSYSTEM_PORTS) && !MIRROR_ONLY.includes(key)
    );
    expect(extras).toEqual([]);
  });

  it('resolves the active PostgreSQL port to one of the mirrored literals', () => {
    expect([PORTS.POSTGRES_NATIVE, PORTS.POSTGRES_DOCKER]).toContain(ECOSYSTEM_PORTS.POSTGRES);
  });

  it('keeps both PostgreSQL literals, and their PGMODE branches, in sync with the config source', () => {
    // The native port only appears inside the config's `pgMode === 'native' ? a : b`
    // ternary, so there is no exported constant to compare against — assert against
    // the config source instead. Two traps this deliberately avoids:
    //   * a substring check passes on a renumber to 15432 or 54321, which still
    //     *contains* "5432", so match whole numeric literals;
    //   * an unordered compare passes on a swapped ternary (native getting the
    //     Docker port), which inverts every mode resolution, so match positionally.
    const source = readFileSync(ecosystemPath, 'utf8');
    const entry = source.slice(source.indexOf('POSTGRES:')).replace(/\/\/[^\n]*/g, '');
    const branches = entry.match(/pgMode\s*===\s*'native'\s*\?\s*(\d+)\s*:\s*(\d+)/);
    expect(branches).toBeTruthy();
    expect(Number(branches[1])).toBe(PORTS.POSTGRES_NATIVE);
    expect(Number(branches[2])).toBe(PORTS.POSTGRES_DOCKER);
  });

  it('defaults a new peer to the API port', () => {
    expect(DEFAULT_PEER_PORT).toBe(ECOSYSTEM_PORTS.API);
  });

  it('defaults a new tailcat local forward to 15555 → remote ingress', () => {
    expect(DEFAULT_TAILCAT_LOCAL_PORT).toBe(15555);
    expect(DEFAULT_TAILCAT_LOCAL_PORT).toBe(ECOSYSTEM_PORTS.TAILCAT_FORWARD);
    expect(DEFAULT_TAILCAT_REMOTE_PORT).toBe(ECOSYSTEM_PORTS.TAILCAT_INGRESS);
  });
});

describe('resolvePostgresPort', () => {
  it('returns the native port for PGMODE=native', () => {
    expect(resolvePostgresPort('native')).toBe(5432);
  });

  it('returns the Docker port for PGMODE=docker', () => {
    expect(resolvePostgresPort('docker')).toBe(5561);
  });

  it('defaults to the Docker port when the mode is unset or unknown', () => {
    expect(resolvePostgresPort(undefined)).toBe(5561);
    expect(resolvePostgresPort('file')).toBe(5561);
  });
});
