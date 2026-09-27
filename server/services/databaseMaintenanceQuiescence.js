import { sep } from 'node:path';
import { PATHS } from '../lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { classifyWriterQuiescence, createDatabaseWriterRegistry } from '../lib/databaseWriterRegistry.js';
import { isDetachedSupervisorCommand, signalProcessGroup, snapshotProcesses } from '../lib/detachedSpawn.js';
import { sleep } from '../lib/fileUtils.js';
import { stopOwnedDatabaseProducers } from './databaseMaintenanceProducers.js';

const TERMINATE_GRACE_MS = 12000;
const POLL_MS = 100;
const PREDECESSOR_GRACE_MS = 5000;
const refused = (reason) => Object.assign(
  new Error(`Database writer quiescence refused: ${reason}. Maintenance remains fenced.`),
  { code: 'DATABASE_WRITER_QUIESCENCE' },
);

// Every live detached supervisor of THIS install (its control directory is
// under the data root, and its argv carries that path) must belong to a record
// we can account for. This catches launches with no reservation: legacy code
// or lost state. The coordinator worker's own supervisor shares our group.
function assertNoUnknownSupervisors(processes, knownGroups) {
  const own = processes.find(proc => proc.pid === process.pid)?.pgid;
  const dataRoot = PATHS.data + sep;
  if (processes.some(proc => isDetachedSupervisorCommand(proc.command) && proc.command.includes(dataRoot)
    && proc.pgid !== own && !knownGroups.has(proc.pgid))) {
    throw refused('an unregistered detached supervisor is running');
  }
}

function classifyAll(rows, processes) {
  const results = rows.map(row => ({ row, ...classifyWriterQuiescence(row, processes) }));
  const counts = {};
  for (const { verdict } of results) counts[verdict] = (counts[verdict] ?? 0) + 1;
  // Bounded diagnostics only: counts, never PIDs, paths or commands.
  if (counts.pending) throw refused(`${counts.pending} admitted launch(es) have not recorded a process identity`);
  if (counts.ambiguous) throw refused(`${counts.ambiguous} writer record(s) are legacy, compacted, or have an unverifiable identity`);
  if (counts.orphaned) throw refused(`${counts.orphaned} exited writer(s) still have surviving descendants`);
  return results;
}

/**
 * Internal coordinator-worker stage, run AFTER producer shutdown. Terminates
 * the process groups of verified still-running detached writers, then proves
 * every registry record quiescent and archives it with the operation. There is
 * no force/skip option: any unprovable state refuses and leaves the fence.
 * `graceMs`/`pollMs` exist only so subprocess tests avoid production sleeps.
 */
export async function reconcileDetachedWriters(id, token, { graceMs = TERMINATE_GRACE_MS, pollMs = POLL_MS } = {}) {
  const journal = createDatabaseMaintenanceJournal();
  const registry = createDatabaseWriterRegistry();
  const operation = journal.assertCoordinatorWorker(id, token);
  if (!['quiescing', 'exporting', 'importing'].includes(operation.stage) || !journal.readProducerSnapshot(id, token)) {
    throw refused('producer shutdown has not been recorded for this operation');
  }
  // Windows has no process-group proof and its completions are compacted into
  // identity-free history, so only never-launched records are provable there.
  const windows = process.platform === 'win32';
  const rows = registry.read();
  if (windows && rows.some(row => row.state !== 'abandoned')) {
    throw refused('descendant termination cannot be proven on Windows');
  }
  let processes = windows ? [] : await snapshotProcesses();
  let results = classifyAll(rows, processes);
  assertNoUnknownSupervisors(processes, new Set(results.flatMap(result => result.groups)));

  // Only groups of a verified live job are signalled: while a group has members
  // its ID cannot be reused, so a group seen non-empty since verification is
  // still this launch's tree. A group once seen empty is never signalled again.
  let live = new Set(results.filter(result => result.verdict === 'running').flatMap(result => result.groups));
  const terminated = results.filter(result => result.verdict === 'running').length;
  const deadline = Date.now() + graceMs;
  let signal = 'SIGTERM';
  while (live.size > 0) {
    journal.assertCoordinatorWorker(id, token);
    for (const group of live) signalProcessGroup(group, signal);
    await sleep(pollMs);
    processes = await snapshotProcesses();
    live = new Set([...live].filter(group => processes.some(proc => proc.pgid === group)));
    if (signal === 'SIGTERM' && Date.now() >= deadline) signal = 'SIGKILL';
    else if (signal === 'SIGKILL' && Date.now() >= deadline + graceMs) throw refused('writer process groups did not terminate');
  }

  // Two consecutive fresh snapshots must agree that everything is quiescent.
  for (let pass = 0; pass < 2; pass += 1) {
    journal.assertCoordinatorWorker(id, token);
    const current = registry.read();
    if (current.length !== rows.length || current.some((row, index) => row.id !== rows[index].id)) {
      throw refused('the writer inventory changed during reconciliation');
    }
    processes = windows ? [] : await snapshotProcesses();
    results = classifyAll(current, processes);
    if (results.some(result => result.verdict !== 'quiescent')) throw refused('a writer is still running');
    assertNoUnknownSupervisors(processes, new Set());
  }
  journal.assertCoordinatorWorker(id, token);
  for (const { row } of results) registry.retire(row.id, journal.reconciledWritersDirectory);
  if (registry.read().length !== 0) throw refused('the writer inventory is not empty after retirement');
  return { id, stage: journal.read().stage, writersReconciled: rows.length, writersTerminated: terminated,
    quiescenceVerified: true, transferReady: false };
}

/**
 * Earlier coordinator workers of this operation ran dump/import children in
 * their own process group. Their supervisor's exit receipt (which recovery
 * requires) does not prove those children stopped: a killed worker can leave
 * an import running. Refuse while any recorded predecessor group has members.
 * Nothing is signalled: the group may have emptied and its ID been reused, so
 * the operator must inspect and stop it. Windows has no group proof at all.
 */
export async function assertPredecessorCoordinatorsStopped(id, token, { graceMs = PREDECESSOR_GRACE_MS, pollMs = POLL_MS } = {}) {
  const journal = createDatabaseMaintenanceJournal();
  const predecessors = journal.readPredecessorWorkers(id, token);
  if (!predecessors.some(worker => worker.started)) return { predecessorsVerified: predecessors.length };
  if (process.platform === 'win32') throw refused('a previous coordinator\'s children cannot be proven stopped on Windows');
  const groups = new Set(predecessors.filter(worker => worker.pgid !== null).map(worker => worker.pgid));
  const deadline = Date.now() + graceMs;
  let consecutive = 0;
  // Two consecutive empty snapshots; the predecessor supervisor may still be
  // exiting just after publishing its receipt.
  while (consecutive < 2) {
    journal.assertCoordinatorWorker(id, token);
    const processes = await snapshotProcesses();
    const own = processes.find(proc => proc.pid === process.pid)?.pgid;
    // A recorded ID equal to our own group was empty when ours was created.
    const occupied = processes.some(proc => proc.pgid !== own && groups.has(proc.pgid));
    consecutive = occupied ? 0 : consecutive + 1;
    if (occupied && Date.now() >= deadline) throw refused('a previous coordinator\'s dump or import process is still running');
    if (consecutive < 2) await sleep(pollMs);
  }
  return { predecessorsVerified: predecessors.length };
}

/**
 * The full internal quiescence stage for the entered transfer worker: stop
 * owned PM2 producers, prove earlier coordinator children stopped, then
 * reconcile detached writers. Every transfer attempt repeats it before any
 * dump or import; a recovered worker never relies on a predecessor's result.
 */
export async function quiesceDatabaseWriters(id, token, options = {}) {
  await stopOwnedDatabaseProducers(id, token, { entered: true });
  await assertPredecessorCoordinatorsStopped(id, token, options);
  return reconcileDetachedWriters(id, token, options);
}
