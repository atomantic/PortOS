/** File selection shared by the real migration runners and read-only rehearsal. */
import { readdir } from 'node:fs/promises';

// Only a portable migration basename may reach a read or import, including
// when a caller supplies a mocked directory listing.
export const isShippedMigrationName = (name) => typeof name === 'string'
  && /^\d+-.*\.js$/.test(name) && !/[/\\:]/.test(name) && !name.endsWith('.test.js');

export async function scanMigrationFiles(directory) {
  return (await readdir(directory)).filter(isShippedMigrationName).sort();
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
