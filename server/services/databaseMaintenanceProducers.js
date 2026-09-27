import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { PATHS } from '../lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { listMaintenanceProcesses, stopApp } from './pm2.js';

const names = ['portos-cos', 'portos-server'];
const scripts = { 'portos-cos': 'server/cos-runner/index.js', 'portos-server': 'server/start.js' };
const producerSchema = z.object({
  name: z.enum(names), pmId: z.number().int().nonnegative(),
  pid: z.number().int().nonnegative(), status: z.enum(['online', 'stopped']),
  cwd: z.string().min(1), script: z.string().min(1),
}).strict();
const refused = () => new Error('Database producer shutdown refused: ownership or PM2 identity is unverified.');

function validateInventory(rows) {
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string')) throw refused();
  const root = realpathSync(PATHS.installRoot);
  const producers = names.map(name => {
    const matches = rows.filter(row => row.name === name);
    if (matches.length !== 1) throw refused();
    const row = producerSchema.parse(matches[0]);
    if ((row.status === 'online' ? row.pid <= 0 : row.pid !== 0)
      || realpathSync(row.cwd) !== root
      || realpathSync(resolve(row.cwd, row.script)) !== realpathSync(join(root, scripts[name]))) throw refused();
    return { ...row, cwd: root, script: realpathSync(join(root, scripts[name])) };
  });
  if (new Set(producers.map(row => row.pmId)).size !== names.length) throw refused();
  return producers;
}

function sameIdentities(current, saved) {
  for (const row of current) {
    const original = saved.find(value => value.name === row.name);
    if (!original || row.pmId !== original.pmId || row.cwd !== original.cwd || row.script !== original.script
      || (row.status === 'online' && (original.status !== 'online' || row.pid !== original.pid))) throw refused();
  }
}

/**
 * Internal one-use coordinator worker stage. Stops producers only; descendants
 * and pre-fence admitted spawns still require reconciliation before any dump.
 * A recovered worker at `exporting`/`importing` repeats the same readback and
 * stop against the ORIGINAL identities before retrying its transfer step.
 * `entered` is for the transfer worker, which has already claimed its one-use
 * entry; standalone calls claim it here.
 */
export async function stopOwnedDatabaseProducers(id, token, { entered = false } = {}) {
  const journal = createDatabaseMaintenanceJournal();
  const operation = entered ? journal.assertEnteredCoordinatorWorker(id, token) : journal.enterCoordinatorWorker(id, token);
  if (!['accepted', 'quiescing', 'exporting', 'importing'].includes(operation.stage)) throw refused();
  const inventory = async () => {
    journal.assertCoordinatorWorker(id, token);
    const rows = await listMaintenanceProcesses();
    journal.assertCoordinatorWorker(id, token);
    return validateInventory(rows);
  };
  let saved = journal.readProducerSnapshot(id, token);
  const initial = await inventory();
  if (!saved) saved = journal.recordProducerSnapshot(id, token, initial);
  sameIdentities(initial, saved);
  if (operation.stage === 'accepted') journal.transition(id, token, 'accepted', 'quiescing');

  // Stop CoS first so its producer cannot keep submitting work while the server
  // shuts down. Fresh readback of BOTH identities precedes every mutation.
  for (const name of names) {
    const current = await inventory();
    sameIdentities(current, saved);
    const producer = current.find(row => row.name === name);
    if (producer.status === 'stopped') continue;
    journal.assertCoordinatorWorker(id, token);
    const result = await stopApp(producer.pmId);
    journal.assertCoordinatorWorker(id, token);
    if (result?.success !== true) throw refused();
    const stopped = await inventory();
    sameIdentities(stopped, saved);
    if (stopped.find(row => row.name === name).status !== 'stopped') throw refused();
  }
  const final = await inventory();
  sameIdentities(final, saved);
  if (final.some(row => row.status !== 'stopped')) throw refused();
  return { id, stage: journal.read().stage, producersStopped: true, quiescenceVerified: false, transferReady: false };
}
