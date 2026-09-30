import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, linkSync, rmSync } from 'node:fs';
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
// `launchedAt` is absent on launches recorded before descendant
// reconciliation existed; such a record can never prove its process identity.
const launchSchema = z.object({
  pid: z.number().int().positive(), launchedAt: z.string().datetime().optional(),
}).strict();
// POSIX only: the detached outer `sh` is a session and process-group leader,
// so its PID names the group every supervisor/job descendant inherits.
const launcherSchema = z.object({ pid: z.number().int().positive() }).strict();
const abandonedSchema = z.object({ version: z.literal(1) }).strict();
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
  const readEntry = (name) => {
    if (!z.string().uuid().safeParse(name).success) throw refused();
    const entry = join(directory, name);
    if (!lstatSync(entry).isDirectory()) throw refused();
    const record = readRecord(entry, 'reservation.json', reservationSchema);
    if (record.id !== name) throw refused();
    const launcher = readRecord(entry, 'launcher.json', launcherSchema, true);
    const launch = readRecord(entry, 'launch.json', launchSchema, true);
    const completion = readRecord(entry, 'completion.json', completionSchema, true);
    const abandoned = readRecord(entry, 'abandoned.json', abandonedSchema, true);
    // A completion needs SOME process identity to reconcile; a refusal before
    // launch must not coexist with evidence that a launcher started.
    if ((completion && !launch && !launcher) || (abandoned && (launcher || launch || completion))) throw refused();
    const state = abandoned ? 'abandoned' : completion ? 'exited' : launch ? 'launched'
      : launcher ? 'launching' : 'unresolved';
    return { ...record, state, ...(launcher ? { launcherPid: launcher.pid } : {}),
      ...(launch ?? {}), ...(completion ? { completion } : {}) };
  };
  // Retirement is only for records a caller has PROVEN quiescent (or that
  // never launched). Archiving keeps the identity evidence with the operation.
  const retire = (id, archiveDir = null) => {
    assertNotRealDataWrite(directory, 'detached writer retirement');
    readEntry(id);
    const entry = join(directory, id);
    if (archiveDir) {
      mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      renameSync(entry, join(archiveDir, id));
      syncDirectory(archiveDir);
    } else {
      rmSync(entry, { recursive: true });
    }
    syncDirectory(directory);
  };
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
      id: record.id,
      assertLaunchAllowed,
      // Published as soon as the launcher spawns. A crash before this write
      // leaves the reservation unresolved, which reconciliation refuses.
      launcher: pid => publish(entry, 'launcher.json', launcherSchema.parse({ pid })),
      launched: pid => publish(entry, 'launch.json', launchSchema.parse({ pid, launchedAt: new Date().toISOString() })),
      // Only for a launch refused before any launcher process was started.
      abandoned: () => publish(entry, 'abandoned.json', { version: 1 }),
      inspect: () => readEntry(record.id),
      retire: () => retire(record.id),
      completed: (code, signal) => {
        publish(entry, 'completion.json', completionSchema.parse({ code, signal }));
        // POSIX retains the identity so descendant reconciliation can prove the
        // launcher group empty (the spawner retires it at once when it can).
        if (process.platform !== 'win32') return;
        // Windows has no process-group proof, so its identity has no use:
        // compact into the persistent UNKNOWN-history marker (never absence).
        // Missing launch identity stays unresolved and retains its details.
        readRecord(entry, 'launch.json', launchSchema);
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
      try { return readEntry(name); } catch { throw refused(); }
    });
    // Keep this in the inventory itself so a consumer cannot accidentally read
    // only current launch rows and mistake a compacted history for an empty set.
    if (retired) writers.push({ state: 'unresolved', kind: 'retired-exits' });
    return writers;
  };
  return { reserve, read, retire };
}

export const reserveDatabaseWriter = (...args) => createDatabaseWriterRegistry().reserve(...args);

// ps reports start time at one-second resolution, truncated.
const START_SLACK_MS = 2000;

/**
 * Classify one inventory row against a POSIX process-table snapshot of
 * { pid, pgid, startedAt } rows. Pure: it never probes or signals a PID.
 *
 * - quiescent: nothing was launched, or the job is gone AND every recorded
 *   process group is empty (a group ID cannot be reused while it has members).
 * - running:   the recorded job is alive with a verified identity (its group is
 *   recorded and it started inside this launch's window), so terminating its
 *   recorded groups reaches only this launch's tree.
 * - orphaned:  the job is gone but its groups still hold survivors.
 * - pending:   an admitted launch that recorded no process identity yet.
 * - ambiguous: legacy/compacted history, no launcher group, a process-group
 *   job whose own group was never recorded, or an identity mismatch (possible
 *   PID reuse). Never safe to signal or to ignore.
 */
// A zombie (ps state Z) is a reaped-by-nobody corpse: it holds no files open and
// cannot write, so it must not keep a process group "occupied". Hosts whose
// PID 1 does not reap orphans (containers without an init) leave them forever.
export const isLiveProcess = proc => !String(proc.state ?? '').startsWith('Z');

export function classifyWriterQuiescence(row, allProcesses) {
  const processes = allProcesses.filter(isLiveProcess);
  if (row.kind === 'retired-exits') return { verdict: 'ambiguous', groups: [] };
  if (row.state === 'abandoned') return { verdict: 'quiescent', groups: [] };
  if (row.state === 'unresolved') return { verdict: 'pending', groups: [] };
  if (!row.launcherPid || (row.pid && !row.launchedAt)) return { verdict: 'ambiguous', groups: [] };
  // A process-group job leaves the launcher group for its own; without its
  // recorded PID that group is unknown, so an empty launcher group proves nothing.
  if (row.processGroup && !row.pid) return { verdict: 'ambiguous', groups: [row.launcherPid] };
  const groups = [...new Set([row.launcherPid, ...(row.processGroup && row.pid ? [row.pid] : [])])];
  const earliest = Math.floor(Date.parse(row.createdAt) / 1000) * 1000 - START_SLACK_MS;
  const latest = (row.launchedAt ? Date.parse(row.launchedAt) : Date.now()) + START_SLACK_MS;
  const inWindow = proc => proc.startedAt >= earliest && proc.startedAt <= latest;
  // A live process holding a recorded group's own ID must be that group's
  // original leader; anything else is a reused ID we must not touch.
  if (processes.some(proc => groups.includes(proc.pid) && proc.pgid === proc.pid && !inWindow(proc))) {
    return { verdict: 'ambiguous', groups };
  }
  const job = row.pid ? processes.find(proc => proc.pid === row.pid) : null;
  if (job) {
    // The supervisor already reported this job's exit: a live PID is reuse.
    if (row.state === 'exited' || !groups.includes(job.pgid) || !inWindow(job)) return { verdict: 'ambiguous', groups };
    return { verdict: 'running', groups };
  }
  return { verdict: processes.some(proc => groups.includes(proc.pgid)) ? 'orphaned' : 'quiescent', groups };
}
