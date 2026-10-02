// Disposable stand-ins for the restart half of a database cutover. Nothing
// here reaches a real database, PM2 daemon or install configuration:
//
// - the REAL `ecosystem.config.cjs` is copied into the disposable root, so the
//   cutover's saved-configuration probe resolves endpoints exactly as PM2 will
//   (both test endpoints therefore share one host/user/database, as real ones do).
// - a `pg` stub (loaded through a module hook) answers the read-only target
//   verification: `pg-health` = healthy | unhealthy switches the outcome, and
//   the reported database/user are the pool's own configuration.
// - `launchServer(endpoint)` starts a surrogate ordinary server: the REAL
//   databaseCutoverHandshake + databaseBootFence against a pool configured
//   from its environment, then records `server booted` (or `server refused`).
//   Its stderr is kept in `surrogate-stderr.log` as failure evidence.
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from '../../lib/childProcess.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyEcosystemConfig } from './ecosystemConfigCopy.js';

const handshakeUrl = new URL('../../services/databaseCutoverHandshake.js', import.meta.url).href;
const bootFenceUrl = new URL('../../services/databaseBootFence.js', import.meta.url).href;

export function installCutoverStubs(root, dir, { source, target }) {
  writeFileSync(join(dir, 'endpoints.json'), JSON.stringify({ [source.mode]: source, [target.mode]: target }));
  copyEcosystemConfig(root);

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
// db.js snapshots TLS before constructing the pool; this synthetic endpoint
// uses plain PostgreSQL and never opens a real Client socket.
class Client { connectionParameters = { ssl: false, sslnegotiation: "postgres" }; }
export default { Client, Pool, types: { setTypeParser() {} } };
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
// Timestamped progress on stderr lets a failed wait tell a refusal from a
// boot that was still pending (or never started) when the test gave up.
const trace = step => console.error(new Date().toISOString() + ' surrogate ' + process.pid + ' port ' + process.env.PGPORT + ' ' + step);
trace('started');
// A killed Vitest worker cannot run afterEach. Its pipe closes even on
// SIGKILL, so the owned surrogate exits instead of writing into a swept root.
if (process.argv.includes('--owner-bound')) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
try {
  trace('handshake import started');
  const { awaitDatabaseCutoverRelease } = await import(${JSON.stringify(handshakeUrl)});
  trace('handshake imported');
  const released = await awaitDatabaseCutoverRelease({ pollMs: 20, releaseTimeoutMs: 20000 });
  trace('handshake returned released=' + released.released);
  await import(${JSON.stringify(bootFenceUrl)});
  log('server booted ' + process.env.PGPORT);
  trace('booted');
} catch (err) {
  log('server refused ' + (err.code ?? 'error'));
  trace('refused ' + (err.code ?? 'error') + ': ' + String(err?.message ?? err).slice(0, 300));
  process.exit(1);
}
setInterval(() => {}, 1000);
`);
  chmodSync(surrogate, 0o644);

  const pidsPath = join(dir, 'surrogates');
  const ownedServers = [];
  return {
    setHealth: value => writeFileSync(join(dir, 'pg-health'), value),
    // Make the next stubbed PM2 restart hand the server this endpoint instead
    // of the one the saved configuration names (a stale cached environment).
    overrideRestartPool: endpoint => writeFileSync(join(dir, 'restart-pool.json'), JSON.stringify(endpoint)),
    clearRestartPool: () => writeFileSync(join(dir, 'restart-pool.json'), 'null'),
    // Ordinary fixture servers belong to the test worker. Keep their handles
    // so teardown waits for exit before removing files they may still write.
    launchServer: endpoint => launchSurrogateServer(root, dir, endpoint, child => {
      const closed = new Promise(resolve => child.once('close', resolve));
      ownedServers.push({ child, closed });
    }),
    stopSurrogates: () => Promise.all(ownedServers.map(({ child, closed }) => {
      child.kill('SIGKILL');
      return closed;
    })),
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

/**
 * A surrogate ordinary server whose pool is `endpoint`. Returns its pid.
 * onOwnedChild binds direct test launches to their worker's lifetime. The
 * detached maintenance-worker fixture omits it: its restarted server must
 * survive that coordinator's successful exit, like a real PM2 restart.
 */
export function launchSurrogateServer(root, dir, endpoint, onOwnedChild) {
  const env = { ...process.env, NODE_ENV: 'test', PORTOS_DATA_ROOT: root,
    PGHOST: endpoint.host, PGPORT: String(endpoint.port), PGDATABASE: endpoint.database, PGUSER: endpoint.user,
    PGPASSWORD: 'example-password', NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'pg-register.mjs')).href}` };
  delete env.VITEST;
  const stderr = openSync(join(dir, 'surrogate-stderr.log'), 'a');
  const args = [join(dir, 'server-surrogate.mjs'), ...(onOwnedChild ? ['--owner-bound'] : [])];
  const child = spawn(process.execPath, args, { env, stdio: [onOwnedChild ? 'pipe' : 'ignore', 'ignore', stderr], detached: true });
  closeSync(stderr);
  appendFileSync(join(dir, 'surrogate-stderr.log'), new Date().toISOString() + ' launched surrogate ' + child.pid + '\n');
  child.once('error', err => console.error('Cutover surrogate launch failed: ' + (err.code ?? 'error')));
  onOwnedChild?.(child);
  child.stdin?.unref();
  child.unref();
  if (Number.isSafeInteger(child.pid)) appendFileSync(join(dir, 'surrogates'), `${child.pid}\n`);
  return child.pid;
}
