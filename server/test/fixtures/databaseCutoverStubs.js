// Disposable stand-ins for the restart half of a database cutover. Nothing
// here reaches a real database, PM2 daemon or install configuration:
//
// - `ecosystem.config.cjs` in the disposable root resolves DATABASE_MODE from
//   that root's `.env` exactly like the real file, over fixed test endpoints.
// - a `pg` stub (loaded through a module hook) answers the read-only target
//   verification: `pg-health` = healthy | unhealthy switches the outcome, and
//   the reported database/user are the pool's own configuration.
// - `launchServer(endpoint)` starts a surrogate ordinary server: the REAL
//   databaseCutoverHandshake + databaseBootFence against a pool configured
//   from its environment, then records `server booted` (or `server refused`).
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const handshakeUrl = new URL('../../services/databaseCutoverHandshake.js', import.meta.url).href;
const bootFenceUrl = new URL('../../services/databaseBootFence.js', import.meta.url).href;

export function installCutoverStubs(root, dir, { source, target }) {
  writeFileSync(join(dir, 'endpoints.json'), JSON.stringify({ [source.mode]: source, [target.mode]: target }));
  writeFileSync(join(root, 'ecosystem.config.cjs'), `const fs = require('fs');
const path = require('path');
const endpoints = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'endpoints.json'))}, 'utf8'));
let mode = ${JSON.stringify(source.mode)};
try { mode = /^PGMODE=(\\S+)/m.exec(fs.readFileSync(path.join(__dirname, '.env'), 'utf8'))?.[1] ?? mode; } catch {}
module.exports = { DATABASE_MODE: mode, DATABASE_ENDPOINTS: endpoints };
`);

  const pgStub = join(dir, 'pg-stub.mjs');
  writeFileSync(pgStub, `import { existsSync, readFileSync } from 'node:fs';
const health = () => existsSync(${JSON.stringify(join(dir, 'pg-health'))}) ? readFileSync(${JSON.stringify(join(dir, 'pg-health'))}, 'utf8').trim() : 'healthy';
function Pool(config) {
  return {
    on() {},
    async end() {},
    async query() { throw new Error('pooled query is not stubbed'); },
    async connect() {
      if (health() !== 'healthy') throw new Error('connection refused');
      return {
        async query(input) {
          const text = typeof input === 'string' ? input : input.text;
          if (!/current_database/.test(text)) return { rows: [] };
          return { rows: [{ database: config.database, user: config.user, has_memories: true, has_links: true,
            has_sync: true, has_catalog: true, has_catalog_scraps: true }] };
        },
        release() {},
      };
    },
  };
}
export default { Pool, types: { setTypeParser() {} } };
`);
  const hooks = join(dir, 'pg-hooks.mjs');
  writeFileSync(hooks, `export async function resolve(specifier, context, next) {
  if (specifier === 'pg') return { url: ${JSON.stringify(pathToFileURL(pgStub).href)}, format: 'module', shortCircuit: true };
  return next(specifier, context);
}\n`);
  const register = join(dir, 'pg-register.mjs');
  writeFileSync(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);

  const events = join(dir, 'events.log');
  const surrogate = join(dir, 'server-surrogate.mjs');
  writeFileSync(surrogate, `import { appendFileSync } from 'node:fs';
const log = line => appendFileSync(${JSON.stringify(events)}, line + '\\n');
try {
  const { awaitDatabaseCutoverRelease } = await import(${JSON.stringify(handshakeUrl)});
  await awaitDatabaseCutoverRelease({ pollMs: 20, releaseTimeoutMs: 20000 });
  await import(${JSON.stringify(bootFenceUrl)});
  log('server booted ' + process.env.PGPORT);
} catch (err) {
  log('server refused ' + (err.code ?? 'error'));
  process.exit(1);
}
setInterval(() => {}, 1000);
`);
  chmodSync(surrogate, 0o644);

  const pidsPath = join(dir, 'surrogates');
  return {
    setHealth: value => writeFileSync(join(dir, 'pg-health'), value),
    // Make the next stubbed PM2 restart hand the server this endpoint instead
    // of the one the saved configuration names (a stale cached environment).
    overrideRestartPool: endpoint => writeFileSync(join(dir, 'restart-pool.json'), JSON.stringify(endpoint)),
    clearRestartPool: () => writeFileSync(join(dir, 'restart-pool.json'), 'null'),
    launchServer: endpoint => launchSurrogateServer(root, dir, endpoint),
    surrogatePids: () => (existsSync(pidsPath) ? readFileSync(pidsPath, 'utf8').split('\n').filter(Boolean).map(Number) : []),
  };
}

/** The endpoint a stubbed `pm2 restart ecosystem.config.cjs --update-env` hands the server. */
export function restartedServerEndpoint(root, dir) {
  const override = join(dir, 'restart-pool.json');
  const forced = existsSync(override) ? JSON.parse(readFileSync(override, 'utf8')) : null;
  if (forced) return forced;
  const endpoints = JSON.parse(readFileSync(join(dir, 'endpoints.json'), 'utf8'));
  const env = existsSync(join(root, '.env')) ? readFileSync(join(root, '.env'), 'utf8') : '';
  const mode = /^PGMODE=(\S+)/m.exec(env)?.[1];
  return endpoints[mode] ?? Object.values(endpoints)[0];
}

/** A surrogate ordinary server whose pool is `endpoint`. Returns its pid. */
export function launchSurrogateServer(root, dir, endpoint) {
  const env = { ...process.env, NODE_ENV: 'test', PORTOS_DATA_ROOT: root,
    PGHOST: endpoint.host, PGPORT: String(endpoint.port), PGDATABASE: endpoint.database, PGUSER: endpoint.user,
    PGPASSWORD: 'example-password', NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'pg-register.mjs')).href}` };
  delete env.VITEST;
  const child = spawn(process.execPath, [join(dir, 'server-surrogate.mjs')], { env, stdio: 'ignore', detached: true });
  child.unref();
  appendFileSync(join(dir, 'surrogates'), `${child.pid}\n`);
  return child.pid;
}
