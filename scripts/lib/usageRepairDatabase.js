/** Run a local usage repair with the install's configured PostgreSQL endpoint. */
import { join, resolve } from 'node:path';
import { parseEnvFile } from './envFile.js';
import databaseSettings from './databaseSettings.cjs';
import { resolveInstallRoot } from '../../server/lib/dataRoot.js';

export async function withUsageRepairDatabase({ root, dataDir, activeDataDir }, run) {
  if (resolve(dataDir) !== resolve(activeDataDir)) return run();
  const saved = parseEnvFile(join(resolveInstallRoot(root), '.env'));
  const settings = databaseSettings.resolveDatabaseSettings({ saved });
  if (settings.mode === 'file') process.env.MEMORY_BACKEND = 'file';
  if (process.env.MEMORY_BACKEND === 'file') return run();
  Object.assign(process.env, {
    PGHOST: settings.host,
    PGPORT: String(settings.port),
    PGDATABASE: settings.database,
    PGUSER: settings.user,
    PGPASSWORD: settings.password,
  });
  try {
    return await run();
  } finally {
    const { close } = await import('../../server/lib/db.js');
    await close();
  }
}
