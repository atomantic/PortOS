import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDatabaseDump, prepareDatabaseReplay } from './backupDatabaseDump.js';

/** Stage an import before any target writes, keeping its original identity. */
export async function stageDatabaseImport(dumpPath, directory, expectedSha256) {
  const spool = join(directory, 'original.sql');
  const inspected = await inspectDatabaseDump(dumpPath, { spoolTo: spool, omitVersionDirectives: true });
  if (!inspected.replayScanSafe) throw new Error('Database import contains oversized SQL that cannot be safely scanned');
  if (expectedSha256 && inspected.sha256 !== expectedSha256) {
    throw new Error('Database import no longer matches its recorded digest');
  }
  return prepareDatabaseReplay(spool, inspected.extensionMetadata);
}

/** Own the private copy until the consumer confirms replay has finished. */
export async function withDatabaseImport(dumpPath, consume) {
  const directory = await mkdtemp(join(tmpdir(), 'portos-database-import-'));
  try {
    const replay = await stageDatabaseImport(dumpPath, directory);
    return await consume(replay);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
