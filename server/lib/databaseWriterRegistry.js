import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
      completed: (code, signal) => publish(entry, 'completion.json', completionSchema.parse({ code, signal })),
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
    return names.sort().map(name => {
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
  };
  return { reserve, read };
}

export const reserveDatabaseWriter = (...args) => createDatabaseWriterRegistry().reserve(...args);
