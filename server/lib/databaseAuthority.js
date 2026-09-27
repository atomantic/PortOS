import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PATHS } from './paths.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';

// Same shape as the maintenance journal's endpoint identity (kept local so the
// journal can depend on this module without a cycle).
const endpointSchema = z.object({
  mode: z.enum(['native', 'docker']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
}).strict();

const authoritySchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  releasedAt: z.string().datetime(),
  source: endpointSchema,
  target: endpointSchema,
}).strict();

const normalizedHost = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase())
  ? 'loopback' : String(host).toLowerCase();
const sameEndpoint = (pool, endpoint) => normalizedHost(pool.host) === normalizedHost(endpoint.host)
  && Number(pool.port) === endpoint.port && pool.database === endpoint.database && pool.user === endpoint.user;

const staleBackendError = () => Object.assign(
  new Error('This process is connected to the database backend a completed cutover retired. Restart it with the saved configuration; see docs/STORAGE.md (retired backend).'),
  { status: 503, code: 'DATABASE_RETIRED_BACKEND' },
);
const unreadableError = () => Object.assign(
  new Error('The database authority record is unreadable. Inspect data/database-authority.json; see docs/STORAGE.md.'),
  { status: 503, code: 'DATABASE_MAINTENANCE' },
);

function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The backend a verified cutover released admission to, and the one it
 * retired. After release the retired source still holds a complete (now
 * stale) copy, so a process whose pool still names it — a PM2 app restarted
 * with a cached environment, a shell with an old PGPORT — must never write
 * there. Absent means no cutover has completed on this install.
 */
export function createDatabaseAuthority(dataDir = PATHS.data) {
  const recordPath = join(dataDir, 'database-authority.json');
  let cache = { key: null, value: null };

  const read = () => {
    let stat;
    try { stat = statSync(recordPath); } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw unreadableError();
    }
    // Re-parse only when the file changes; the check runs on every pooled query.
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (cache.key === key) return cache.value;
    let value;
    try {
      if (!lstatSync(recordPath).isFile()) throw unreadableError();
      value = authoritySchema.parse(JSON.parse(readFileSync(recordPath, 'utf8')));
    } catch {
      throw unreadableError();
    }
    cache = { key, value };
    return value;
  };

  // Durable replace: a later cutover (e.g. back again) supersedes the record.
  const record = ({ operationId, source, target }) => {
    assertNotRealDataWrite(recordPath, 'database authority record');
    const value = authoritySchema.parse({ version: 1, operationId, releasedAt: new Date().toISOString(), source, target });
    const existing = read();
    if (existing?.operationId === operationId) return existing;
    mkdirSync(dataDir, { recursive: true });
    const pending = join(dataDir, `database-authority-${randomUUID()}.pending`);
    const fd = openSync(pending, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(pending, recordPath);
    syncDirectory(dataDir);
    return read();
  };

  // A pool naming the retired source (and not the released target) is stale.
  const assertPool = (pool) => {
    const authority = read();
    if (authority && sameEndpoint(pool, authority.source) && !sameEndpoint(pool, authority.target)) throw staleBackendError();
    return authority;
  };

  return { read, record, assertPool, sameEndpoint };
}

const authority = createDatabaseAuthority();
export const assertDatabasePoolAuthority = authority.assertPool;
