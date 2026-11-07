/** File selection shared by the real migration runners and read-only rehearsal. */
import { readdir } from 'node:fs/promises';

export async function scanMigrationFiles(directory) {
  return (await readdir(directory)).filter(name => /^\d+-.*\.js$/.test(name) && !name.endsWith('.test.js')).sort();
}

export async function scanDatabaseMigrationFiles(directory) {
  // A missing database migration directory has always meant no migrations to
  // the runner. Rehearsal separately requires its committed source inventory.
  const entries = await readdir(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  return entries.filter(name => /\.(sql|js)$/.test(name) && !name.endsWith('.test.js') && !name.startsWith('_')).sort();
}
