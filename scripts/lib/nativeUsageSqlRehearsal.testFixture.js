import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildNativeUsageBackup } from '../../server/lib/nativeUsageRehearsal.js';
import { NATIVE_USAGE_SNAPSHOT_TABLES } from './nativeUsageSnapshot.js';
import { bytes, capturedAt, hash, hosts, input } from './nativeUsageRehearsal.testFixture.js';

export const sqlDump = (extra = '') => '-- PostgreSQL database dump\n\\restrict exampleDumpKey\n'
  + 'DROP EXTENSION IF EXISTS vector;\nCREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;\n'
  + "COMMENT ON EXTENSION vector IS 'vector data type';\n"
  + NATIVE_USAGE_SNAPSHOT_TABLES.map(name => `CREATE TABLE public.${name} (\n id text PRIMARY KEY\n);\nCOPY public.${name} (id) FROM stdin;\nexample-row\n\\.\n`).join('')
  + extra + '\n--\n-- PostgreSQL database dump complete\n--\n\\unrestrict exampleDumpKey\n';

export async function sqlFixture(directory, sql = sqlDump(), { codeCommit, fileMigrationIds } = {}) {
  const fixture = input();
  if (codeCommit) fixture.request.codeCommit = codeCommit;
  const backup = buildNativeUsageBackup(fixture);
  const data = join(directory, 'data');
  await mkdir(data, { recursive: true });
  const contents = { 'usage.json': fixture.files.usageLedger, 'peer-usage.json': fixture.files.peerDigests,
    'instances.json': bytes({ self: { instanceId: hosts[0] } }),
    ...(fileMigrationIds ? { 'migrations.applied.json': bytes(fileMigrationIds) } : {}) };
  for (const [name, content] of Object.entries(contents)) await writeFile(join(data, name), content);
  await writeFile(join(directory, 'portos-db.sql'), sql);
  await writeFile(join(directory, 'manifest.json'), bytes({ generatedAt: capturedAt, fileCount: Object.keys(contents).length + 1,
    files: { ...Object.fromEntries(Object.entries(contents).map(([name, content]) => [name, hash(content)])), '../portos-db.sql': hash(sql) } }));
  const stagePath = join(directory, 'stage.json');
  const backupPath = join(directory, 'backup.json');
  await writeFile(stagePath, bytes(fixture.stage));
  await writeFile(backupPath, bytes(backup));
  return { stage: fixture.stage, backup, directory, args: ['sql-restore', stagePath, backupPath, directory] };
}

/** Minimal synthetic schema satisfying only the explicitly named probe. */
export const schemaSqlDump = (databaseIds, extra = '') => sqlDump(`
  ALTER TABLE public.memories ADD COLUMN sync_sequence bigint;
  CREATE TABLE public.catalog_ingredients (id text);
  CREATE TABLE public.catalog_scraps (id text);
  DELETE FROM public.schema_migrations;
  ${databaseIds.map(id => `INSERT INTO public.schema_migrations (id) VALUES ('${id.replaceAll("'", "''")}');`).join('\n')}
  ${extra}
`);
