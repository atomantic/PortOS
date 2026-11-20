/**
 * Preflight the connected PostgreSQL cluster before provisioning or DB fixtures.
 * PostgreSQL can place its write-ahead log on a different volume from PGDATA.
 */
import { readFile, realpath, statfs } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { formatBytes, parseFilesystemStats } from '../lib/fileCore.js';

const MIN_FREE_BYTES = 2 * 1024 ** 3;
const VOLUMES = [
  ['PostgreSQL data', '.'],
  ['PostgreSQL WAL', 'pg_wal'],
];

const CLUSTER_IDENTITY_SQL = `
  SELECT setting AS directory, CASE
    WHEN inet_server_addr() IS NULL
      OR inet_server_addr() <<= inet '127.0.0.0/8'
      OR inet_server_addr() = inet '::1'
    THEN pg_catalog.pg_read_file('postmaster.pid', 0, 8192, true)
  END AS pid_file
  FROM pg_catalog.pg_settings WHERE name = 'data_directory'
`;

// The pid, data directory, start time and port are fixed for a running cluster.
// Later lines include Postgres startup state, which can change between reads.
function lockFileIdentity(contents) {
  const [pid, directory, start, port] = contents?.split(/\r?\n/, 4) ?? [];
  return /^\d+$/.test(pid ?? '') && directory && /^\d+$/.test(start ?? '') && /^\d+$/.test(port ?? '')
    ? [pid, directory, start, port].join('\n')
    : null;
}

export async function checkDbTestStorage(client, {
  host,
  log = console.log,
  readFileImpl = readFile,
  realpathImpl = realpath,
  statfsImpl = statfs,
} = {}) {
  const unchecked = reason => log(`ℹ️ DB test storage unchecked: ${reason}. Verify space on the database host or use a disposable test cluster.`);
  if (!(isAbsolute(host || '') || /^(localhost|127(?:\.\d{1,3}){3}|::1)$/i.test(host))) {
    unchecked('the PostgreSQL endpoint is remote');
    return;
  }

  const result = await client.query(CLUSTER_IDENTITY_SQL).catch(error => {
    if (error.code !== '42501') throw error;
    return null;
  });
  const cluster = result?.rows[0];
  const databaseIdentity = lockFileIdentity(cluster?.pid_file);
  const directory = cluster?.directory;
  // A loopback port can reach a container or tunnel. Require host-side
  // evidence of the same live cluster before measuring a server-reported path.
  const localLock = databaseIdentity && directory && isAbsolute(directory)
    ? await readFileImpl(join(directory, 'postmaster.pid'), 'utf8').catch(() => null)
    : null;
  if (!databaseIdentity || databaseIdentity !== lockFileIdentity(localLock)) {
    unchecked('the connected PostgreSQL data directory could not be verified on this host');
    return;
  }

  for (const [name, entry] of VOLUMES) {
    const stats = await realpathImpl(join(directory, entry))
      .then(path => statfsImpl(path))
      .then(parseFilesystemStats)
      .catch(() => null);
    if (!stats) {
      unchecked(`free space on the ${name} volume is unavailable`);
    } else if (stats.freeBytes < MIN_FREE_BYTES) {
      throw new Error(`${name} volume has ${formatBytes(stats.freeBytes)} free; DB tests require at least 2 GiB free. Free space on that volume or use a disposable test cluster with adequate storage.`);
    }
  }
}
