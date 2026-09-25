/**
 * Pins PM2's PostgreSQL connection env against a temporary `.env` (#8447).
 *
 * Setup (`scripts/setup-db.js`) already resolves PGUSER/PGDATABASE/PGPASSWORD/
 * PGPORT/PGPORT_DOCKER via `process.env → .env → default`, but `ecosystem.config.cjs`
 * only ever read PGMODE and PORTOS_SERVER_MAX_MEMORY out of `.env` — every other
 * PG setting fell back straight to its hardcoded default, so a password set only
 * in `.env` (not exported into the shell) never reached `portos-server`. This
 * test loads the real ecosystem config against a controlled `.env` (never the
 * repo's own, which may hold real machine-local values) and pins the resolved
 * env for `portos-server` and `portos-cos`.
 *
 * The config reads its `.env` from `path.join(__dirname, '.env')`, so each case
 * copies the real `ecosystem.config.cjs` source into a fresh temp directory next
 * to a synthetic `.env`, then `require()`s the copy — never the checked-out one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_SOURCE = readFileSync(join(REPO_ROOT, 'ecosystem.config.cjs'), 'utf8');

let tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs = [];
});

/**
 * Load a fresh copy of ecosystem.config.cjs against a synthetic `.env`
 * (`envContent`, or none), with `overrideEnv` merged into `process.env` for the
 * duration of the load only.
 */
function loadConfig(envContent, overrideEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portos-ecosystem-env-'));
  tmpDirs.push(dir);
  const configPath = join(dir, 'ecosystem.config.cjs');
  writeFileSync(configPath, CONFIG_SOURCE);
  if (envContent !== null) writeFileSync(join(dir, '.env'), envContent);

  const savedEnv = {};
  for (const key of Object.keys(overrideEnv)) {
    savedEnv[key] = process.env[key];
    if (overrideEnv[key] === undefined) delete process.env[key];
    else process.env[key] = overrideEnv[key];
  }
  try {
    delete require.cache[configPath];
    return require(configPath);
  } finally {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

// Clear any real PG* vars the host shell/CI runner might have exported, so
// the "neither set" cases actually exercise the default branch.
const PG_KEYS = ['PGPASSWORD', 'PGUSER', 'PGDATABASE', 'PGHOST', 'PGPORT', 'PGPORT_DOCKER', 'PGMODE'];
const clearedPgEnv = Object.fromEntries(PG_KEYS.map((k) => [k, undefined]));

describe('ecosystem.config.cjs PostgreSQL env', () => {
  it('picks up a PGPASSWORD set only in .env (not exported to the shell)', () => {
    const { apps } = loadConfig('PGPASSWORD=example-secret\n', clearedPgEnv);
    const server = apps.find((a) => a.name === 'portos-server');
    const cos = apps.find((a) => a.name === 'portos-cos');
    expect(server.env.PGPASSWORD).toBe('example-secret');
    expect(cos.env.PGPASSWORD).toBe('example-secret');
  });

  it('lets an exported PGPASSWORD win over .env', () => {
    const { apps } = loadConfig('PGPASSWORD=from-dotenv\n', { ...clearedPgEnv, PGPASSWORD: 'from-shell' });
    const server = apps.find((a) => a.name === 'portos-server');
    expect(server.env.PGPASSWORD).toBe('from-shell');
  });

  it('resolves the Docker host port from PGPORT_DOCKER in .env under PGMODE=docker', () => {
    const { apps } = loadConfig('PGMODE=docker\nPGPORT_DOCKER=5570\n', clearedPgEnv);
    const server = apps.find((a) => a.name === 'portos-server');
    expect(server.env.PGPORT).toBe(5570);
  });

  it('resolves the native port from PGPORT in .env under PGMODE=native', () => {
    const { apps } = loadConfig('PGMODE=native\nPGPORT=5433\n', clearedPgEnv);
    const server = apps.find((a) => a.name === 'portos-server');
    expect(server.env.PGPORT).toBe(5433);
  });

  it('falls back to the per-mode default port when neither override is set', () => {
    const docker = loadConfig('PGMODE=docker\n', clearedPgEnv);
    const native = loadConfig('PGMODE=native\n', clearedPgEnv);
    expect(docker.apps.find((a) => a.name === 'portos-server').env.PGPORT).toBe(5561);
    expect(native.apps.find((a) => a.name === 'portos-server').env.PGPORT).toBe(5432);
  });

  it('forwards PGUSER/PGDATABASE from .env to portos-server, keeping the portos default otherwise', () => {
    const { apps } = loadConfig('PGUSER=example-user\nPGDATABASE=example-db\n', clearedPgEnv);
    const server = apps.find((a) => a.name === 'portos-server');
    expect(server.env.PGUSER).toBe('example-user');
    expect(server.env.PGDATABASE).toBe('example-db');

    const defaults = loadConfig(null, clearedPgEnv);
    const defaultServer = defaults.apps.find((a) => a.name === 'portos-server');
    expect(defaultServer.env.PGUSER).toBe('portos');
    expect(defaultServer.env.PGDATABASE).toBe('portos');
    expect(defaultServer.env.PGPASSWORD).toBe('portos');
  });

  it('keeps PGPASSWORD out of the non-DB apps (portos-ui, autofixer, browser)', () => {
    const { apps } = loadConfig('PGPASSWORD=example-secret\n', clearedPgEnv);
    for (const name of ['portos-ui', 'portos-autofixer', 'portos-autofixer-ui', 'portos-browser']) {
      const app = apps.find((a) => a.name === name);
      expect(app, `expected an app named ${name}`).toBeTruthy();
      expect(app.env.PGPASSWORD).toBeUndefined();
    }
  });
});
