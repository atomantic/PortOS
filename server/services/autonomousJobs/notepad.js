/**
 * Autonomous Job notepad store: bounded per-job durable KV (`listJobNotes`, `getJobNote`, `setJobNote`, `deleteJobNote`, `clearJobNotes`).
 *
 * Storage: `db-primary` — machine-local, never federated. `autonomous_job_notepads` holds one row per (job, key); the JSON file backend is the dev/test escape hatch only. Cap checks run inside a per-job transaction
 * (PostgreSQL advisory lock) or write queue (file) so concurrent writers cannot jointly exceed the budget, and a rejected write leaves existing keys untouched. Values are never logged.
 */

import { join } from 'node:path';
import { atomicWrite, PATHS, readJSONFile } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend, POSTGRES_SETUP_HINT } from '../../lib/pgFileFacade.js';
import { assertNoteFits, sortNotes, summarizeNotepad } from '../../lib/autonomousJobNotepad.js';

const notepadFile = () => join(PATHS.data, 'autonomous-job-notepads.json');
const queueFileWrite = createFileWriteQueue();

const toEntries = (jobNotes = {}) => Object.entries(jobNotes).map(([key, { value, updatedAt }]) => ({ key, value, updatedAt }));

function makeFileBackend() {
  const read = () => readJSONFile(notepadFile(), {}, { logError: false, strict: true });
  return {
    name: 'file',
    async transact(jobId, fn) {
      return queueFileWrite(async () => {
        const all = await read();
        const notes = { ...(all[jobId] || {}) };
        let dirty = false;
        const result = await fn({
          entries: toEntries(notes),
          put: (key, value) => { notes[key] = { value, updatedAt: new Date().toISOString() }; dirty = true; },
          remove: (key) => { if (key in notes) { delete notes[key]; dirty = true; } },
          clear: () => { for (const key of Object.keys(notes)) { delete notes[key]; dirty = true; } },
        });
        if (dirty) {
          if (Object.keys(notes).length) all[jobId] = notes;
          else delete all[jobId];
          await atomicWrite(notepadFile(), all);
        }
        return result;
      });
    },
    async list(jobId) {
      return toEntries((await read())[jobId]);
    },
  };
}

function makePgBackend(db) {
  const SELECT = `SELECT key, value, updated_at FROM autonomous_job_notepads WHERE job_id = $1 ORDER BY key COLLATE "C"`;
  const toEntry = (row) => ({ key: row.key, value: row.value, updatedAt: new Date(row.updated_at).toISOString() });
  return {
    name: 'postgres',
    async transact(jobId, fn) {
      return db.withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`autonomous_job_notepad:${jobId}`]);
        const { rows } = await client.query(SELECT, [jobId]);
        return fn({
          entries: rows.map(toEntry),
          put: (key, value) => client.query(
            `INSERT INTO autonomous_job_notepads (job_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
             ON CONFLICT (job_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [jobId, key, value]),
          remove: (key) => client.query('DELETE FROM autonomous_job_notepads WHERE job_id = $1 AND key = $2', [jobId, key]),
          clear: () => client.query('DELETE FROM autonomous_job_notepads WHERE job_id = $1', [jobId]),
        });
      });
    },
    async list(jobId) {
      const { rows } = await db.query(SELECT, [jobId]);
      return rows.map(toEntry);
    },
  };
}

const backendFacade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: `Autonomous job notepads require PostgreSQL — ${POSTGRES_SETUP_HINT}`,
    loadDb: () => import('../../lib/db.js'),
    makePg: makePgBackend,
  }),
});

const getBackend = () => backendFacade.getBackend();

/** Notes for a job, key-sorted. */
export async function listJobNotes(jobId) {
  return sortNotes(await (await getBackend()).list(jobId));
}

/** `{ notes, usedBytes, maxBytes, remainingBytes }` for the API and UI. */
export async function getJobNotepad(jobId) {
  const notes = await listJobNotes(jobId);
  return { notes, ...summarizeNotepad(notes) };
}

export async function getJobNote(jobId, key) {
  return (await listJobNotes(jobId)).find((n) => n.key === key) || null;
}

/** Upsert one key; a 400 (cap overflow) leaves existing keys untouched. Returns the updated notepad. */
export async function setJobNote(jobId, key, value) {
  await (await getBackend()).transact(jobId, async (tx) => {
    assertNoteFits(tx.entries, key, value);
    await tx.put(key, value);
  });
  console.log(`📝 Job notepad set: ${jobId}/${key} (${Buffer.byteLength(value, 'utf8')} bytes)`);
  return getJobNotepad(jobId);
}

/** Delete one key; resolves false when it was absent. */
export async function deleteJobNote(jobId, key) {
  const existed = await (await getBackend()).transact(jobId, async (tx) => {
    if (!tx.entries.some((e) => e.key === key)) return false;
    await tx.remove(key);
    return true;
  });
  if (existed) console.log(`🗑️ Job notepad key deleted: ${jobId}/${key}`);
  return existed;
}

/** Remove every key for a job (job deletion or an explicit clear). */
export async function clearJobNotes(jobId) {
  await (await getBackend()).transact(jobId, (tx) => tx.clear());
  console.log(`🧹 Job notepad cleared: ${jobId}`);
}

/** Test seam for suites that swap the backend or data root between cases. */
export function resetJobNotepadStore() {
  backendFacade.reset();
}
