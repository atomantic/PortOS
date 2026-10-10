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
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseEnvFile, resolveHttpMirrorPortForRoot } from './lib/envFile.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_SOURCE = readFileSync(join(REPO_ROOT, 'ecosystem.config.cjs'), 'utf8');
// The config require()s this dependency-free parser (#9471), so each temp copy needs it too.
const PARSER_SOURCE = readFileSync(join(REPO_ROOT, 'scripts', 'lib', 'envFile.cjs'), 'utf8');

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
  return loadConfigIn(envContent, overrideEnv).config;
}

function loadConfigIn(envContent, overrideEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portos-ecosystem-env-'));
  tmpDirs.push(dir);
  const configPath = join(dir, 'ecosystem.config.cjs');
  writeFileSync(configPath, CONFIG_SOURCE);
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'lib', 'envFile.cjs'), PARSER_SOURCE);
  if (envContent !== null) writeFileSync(join(dir, '.env'), envContent);

  const savedEnv = {};
  for (const key of Object.keys(overrideEnv)) {
    savedEnv[key] = process.env[key];
    if (overrideEnv[key] === undefined) delete process.env[key];
    else process.env[key] = overrideEnv[key];
  }
  try {
    delete require.cache[configPath];
    return { config: require(configPath), dir };
  } finally {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

// Clear any real PG* vars the host shell/CI runner might have exported, so
// the "neither set" cases actually exercise the default branch.
const PG_KEYS = ['PGPASSWORD', 'PGUSER', 'PGDATABASE', 'PGHOST', 'PGPORT', 'PGPORT_DOCKER', 'PGMODE', 'PORTOS_NATIVE_PGPORT'];
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

  it.each(['portos-server', 'portos-cos'])('preserves both endpoints when reloaded from %s across a mode change', (name) => {
    const saved = 'PGMODE=docker\nPGPORT=5433\nPGPORT_DOCKER=5570\n';
    const initial = loadConfig(saved, clearedPgEnv);
    const inherited = { ...clearedPgEnv, ...initial.apps.find(app => app.name === name).env };
    expect(inherited.PGPORT).toBe(5570);
    const reloaded = loadConfig(saved, inherited);
    expect(reloaded.DATABASE_ENDPOINTS).toEqual(initial.DATABASE_ENDPOINTS);
    const switched = loadConfig(saved.replace('docker', 'native'), inherited);
    expect(switched.DATABASE_ENDPOINTS).toEqual(initial.DATABASE_ENDPOINTS);
    expect(switched.apps.find(app => app.name === name).env.PGPORT).toBe(5433);
    const returned = loadConfig(saved, {
      ...clearedPgEnv, ...switched.apps.find(app => app.name === name).env,
    });
    expect(returned.DATABASE_ENDPOINTS).toEqual(initial.DATABASE_ENDPOINTS);
    expect(returned.apps.find(app => app.name === name).env.PGPORT).toBe(5570);
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

describe('ecosystem.config.cjs parses .env with the setup grammar (#9471)', () => {
  const server = (config) => config.apps.find((a) => a.name === 'portos-server');

  it.each([
    ['double', (v) => `"${v}"`],
    ['single', (v) => `'${v}'`],
  ])('resolves %s-quoted native mode and port to the endpoint setup resolves', (_label, quote) => {
    const env = `PGMODE=${quote('native')}\nPGPORT=${quote('5433')}\n`;
    const { config, dir } = loadConfigIn(env, clearedPgEnv);
    const setup = parseEnvFile(join(dir, '.env'));
    expect(setup).toMatchObject({ PGMODE: 'native', PGPORT: '5433' });
    expect(config.DATABASE_MODE).toBe('native');
    expect(config.DATABASE_ENDPOINTS.native.port).toBe(5433);
    expect(server(config).env.PGPORT).toBe(5433);
  });

  it('resolves a quoted native port under an unquoted mode to a finite endpoint', () => {
    const config = loadConfig('PGMODE=native\nPGPORT="5433"\n', clearedPgEnv);
    expect(config.DATABASE_ENDPOINTS.native.port).toBe(5433);
  });

  it('preserves a quoted password with spaces exactly, for server and CoS, and still lets the shell win', () => {
    const env = 'PGPASSWORD="example secret pass"\n';
    const { config, dir } = loadConfigIn(env, clearedPgEnv);
    expect(parseEnvFile(join(dir, '.env')).PGPASSWORD).toBe('example secret pass');
    expect(server(config).env.PGPASSWORD).toBe('example secret pass');
    expect(config.apps.find((a) => a.name === 'portos-cos').env.PGPASSWORD).toBe('example secret pass');

    const overridden = loadConfig(env, { ...clearedPgEnv, PGPASSWORD: 'from-shell' });
    expect(server(overridden).env.PGPASSWORD).toBe('from-shell');
  });

  it('reads quoted user/database/host/memory settings, with whitespace around the assignment', () => {
    const env = `PGUSER = "example user"\nPGDATABASE='example db'\nPGHOST = "db.example.com"\nPORTOS_SERVER_MAX_MEMORY = "6G"\n`;
    const config = loadConfig(env, { ...clearedPgEnv, PORTOS_SERVER_MAX_MEMORY: undefined });
    expect(server(config).env).toMatchObject({ PGUSER: 'example user', PGDATABASE: 'example db', PGHOST: 'db.example.com' });
    expect(server(config).max_memory_restart).toBe('6G');
  });

  it('still keeps a quoted PGPASSWORD out of the non-DB apps', () => {
    const { apps } = loadConfig('PGPASSWORD="example secret pass"\n', clearedPgEnv);
    for (const name of ['portos-ui', 'portos-autofixer', 'portos-autofixer-ui', 'portos-browser']) {
      expect(apps.find((a) => a.name === name).env.PGPASSWORD).toBeUndefined();
    }
  });

  it('keeps the docker defaults when .env is missing', () => {
    const config = loadConfig(null, clearedPgEnv);
    expect(config.DATABASE_MODE).toBe('docker');
    expect(server(config).env.PGPORT).toBe(5561);
  });
  describe('mode precedence matches setup (#10758)', () => {
    const ports = 'PGPORT=5433\nPGPORT_DOCKER=5570\n';
    it.each([
      ['docker', 'native', 5433],
      ['native', 'docker', 5570],
    ])('saved %s with exported %s resolves to the exported mode and port %i', (saved, exported, port) => {
      const config = loadConfig(`PGMODE=${saved}\n${ports}`, { ...clearedPgEnv, PGMODE: exported });
      expect(config.DATABASE_MODE).toBe(exported);
      for (const name of ['portos-server', 'portos-cos']) {
        expect(config.apps.find((a) => a.name === name).env.PGPORT).toBe(port);
      }
      expect(config.DATABASE_ENDPOINTS.native.port).toBe(5433);
      expect(config.DATABASE_ENDPOINTS.docker.port).toBe(5570);
    });

    it('treats an empty exported PGMODE as unset and uses the saved mode', () => {
      const config = loadConfig(`PGMODE=native\n${ports}`, { ...clearedPgEnv, PGMODE: '' });
      expect(config.DATABASE_MODE).toBe('native');
      expect(server(config).env.PGPORT).toBe(5433);
    });

    it('falls back to docker when the export is empty and no .env is saved', () => {
      const config = loadConfig(null, { ...clearedPgEnv, PGMODE: '' });
      expect(config.DATABASE_MODE).toBe('docker');
    });

    it('lets an exported mode apply with no saved .env', () => {
      const config = loadConfig(null, { ...clearedPgEnv, PGMODE: 'native' });
      expect(config.DATABASE_MODE).toBe('native');
      expect(server(config).env.PGPORT).toBe(5432);
    });
  });
});

describe('ecosystem.config.cjs loopback HTTP mirror port (#10950)', () => {
  const mirrorOf = (envContent, env) => {
    const { config, dir } = loadConfigIn(envContent, { PORTOS_HTTP_PORT: undefined, ...env });
    return { port: config.apps.find((a) => a.name === 'portos-server').env.PORTOS_HTTP_PORT, dir };
  };

  it('defaults to the canonical mirror port', () => {
    expect(mirrorOf(null, {}).port).toBe(5553);
  });

  it('honors a port saved only in .env, and advertises the same one to setup helpers', () => {
    const { port, dir } = mirrorOf('PORTOS_HTTP_PORT=5599\n', {});
    expect(port).toBe(5599);
    expect(resolveHttpMirrorPortForRoot(dir)).toBe(port);
  });

  it('lets a nonempty exported value win over .env, matching setup helpers', () => {
    const saved = { PORTOS_HTTP_PORT: '5588' };
    const { config, dir } = loadConfigIn('PORTOS_HTTP_PORT=5599\n', saved);
    const port = config.apps.find((a) => a.name === 'portos-server').env.PORTOS_HTTP_PORT;
    expect(port).toBe(5588);
    const prev = process.env.PORTOS_HTTP_PORT;
    process.env.PORTOS_HTTP_PORT = '5588';
    try { expect(resolveHttpMirrorPortForRoot(dir)).toBe(5588); }
    finally { if (prev === undefined) delete process.env.PORTOS_HTTP_PORT; else process.env.PORTOS_HTTP_PORT = prev; }
  });

  it.each(['abc', '0', '70000', '55.5', ''])('skips invalid value %j and falls through to the next source', (bad) => {
    expect(mirrorOf(null, { PORTOS_HTTP_PORT: bad }).port).toBe(5553);
    expect(mirrorOf('PORTOS_HTTP_PORT=5599\n', { PORTOS_HTTP_PORT: bad }).port).toBe(5599);
    expect(mirrorOf(`PORTOS_HTTP_PORT=${bad}\n`, {}).port).toBe(5553);
  });
});
