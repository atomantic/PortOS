import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PATHS } from './paths.js';
import { createDatabaseMaintenanceJournal } from './databaseMaintenanceJournal.js';
import { assertNotRealDataWrite } from './testDataIsolation.js';

const reservationSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), controlDir: z.string().refine(isAbsolute),
  createdAt: z.string().datetime(), processGroup: z.boolean(),
}).strict();
const launchSchema = z.object({ pid: z.number().int().positive() }).strict();
const completionSchema = z.object({
  code: z.number().int().nullable(), signal: z.string().nullable(),
}).strict();
const retirementSchema = z.object({ version: z.literal(1) }).strict();
const RETIRED_EXITS = 'unreconciled-exits.json';
const refused = () => new Error('Detached writer inventory is incomplete or unreadable; maintenance must remain fenced.');

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function publish(directory, name, value) {
  const fd = openSync(join(directory, name), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(directory);
}
function readRecord(directory, name, schema, optional = false) {
  const path = join(directory, name);
  try {
    if (!lstatSync(path).isFile()) throw refused();
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw refused();
  }
}

/** Machine-local launch evidence, NOT a declaration of writer quiescence. */
export function createDatabaseWriterRegistry(dataDir = PATHS.data) {
  const directory = join(dataDir, 'database-writers');
  const journal = createDatabaseMaintenanceJournal(dataDir);
  const reserve = (controlDir, processGroup = false) => {
    assertNotRealDataWrite(directory, 'detached writer reservation');
    // Reject already-fenced callers without creating records. This check is an
    // optimization only: the check AFTER durable publication closes the race.
    journal.assertAdmission();
    // A corrupt aggregate cannot accept further launches whose completion
    // would only create more unretirable records. Missing history is normal.
    readRecord(directory, RETIRED_EXITS, retirementSchema, true);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    syncDirectory(dataDir);
    const record = reservationSchema.parse({ version: 1, id: randomUUID(),
      controlDir: resolve(controlDir), createdAt: new Date().toISOString(), processGroup });
    const entry = join(directory, record.id);
    mkdirSync(entry, { mode: 0o700 });
    syncDirectory(directory);
    // Incomplete publication stays visible and fails inventory closed after a
    // crash. No child may start before this record is durable and admitted.
    publish(entry, 'reservation.json', record);
    const assertLaunchAllowed = () => journal.assertAdmission();
    assertLaunchAllowed();
    return {
      assertLaunchAllowed,
      launched: pid => publish(entry, 'launch.json', launchSchema.parse({ pid })),
      completed: (code, signal) => {
        publish(entry, 'completion.json', completionSchema.parse({ code, signal }));
        // Missing launch identity stays unresolved and retains its details.
        readRecord(entry, 'launch.json', launchSchema);
        // An exit does not prove descendant termination. Compact completed
        // details into a persistent UNKNOWN-history marker, never into absence.
        // Publish fully fsynced bytes atomically, and sync the parent BEFORE
        // deletion. Competing completions share one immutable marker.
        publish(entry, 'retirement.json', { version: 1 });
        try { linkSync(join(entry, 'retirement.json'), join(directory, RETIRED_EXITS)); }
        catch (err) { if (err.code !== 'EEXIST') throw err; }
        readRecord(directory, RETIRED_EXITS, retirementSchema);
        syncDirectory(directory);
        rmSync(entry, { recursive: true });
        syncDirectory(directory);
      },
    };
  };
  const read = () => {
    let names;
    try {
      if (!lstatSync(directory).isDirectory()) throw refused();
      names = readdirSync(directory);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw refused();
    }
    const retired = names.includes(RETIRED_EXITS);
    if (retired) readRecord(directory, RETIRED_EXITS, retirementSchema);
    const writers = names.filter(name => name !== RETIRED_EXITS).sort().map(name => {
      if (!z.string().uuid().safeParse(name).success) throw refused();
      const entry = join(directory, name);
      if (!lstatSync(entry).isDirectory()) throw refused();
      const record = readRecord(entry, 'reservation.json', reservationSchema);
      if (record.id !== name) throw refused();
      const launch = readRecord(entry, 'launch.json', launchSchema, true);
      const completion = readRecord(entry, 'completion.json', completionSchema, true);
      if (completion && !launch) throw refused();
      return { ...record, state: completion ? 'exited' : launch ? 'launched' : 'unresolved',
        ...(launch ?? {}), ...(completion ? { completion } : {}) };
    });
    // Keep this in the inventory itself so a consumer cannot accidentally read
    // only current launch rows and mistake a compacted history for an empty set.
    if (retired) writers.push({ state: 'unresolved', kind: 'retired-exits' });
    return writers;
  };
  return { reserve, read };
}

export const reserveDatabaseWriter = (...args) => createDatabaseWriterRegistry().reserve(...args);
