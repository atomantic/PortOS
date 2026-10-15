/** Local album/track unit of work. Federation retains its per-record LWW path. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ensureSchema, withTransaction } from '../lib/db.js';
import { isFileBackend } from '../lib/pgFileFacade.js';
import { ServerError } from '../lib/errorHandler.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const mutations = new AsyncLocalStorage();
const queueFiles = createFileWriteQueue();

export const musicMutationClient = () => mutations.getStore()?.client;

export function afterMusicCommit(announce) {
  const context = mutations.getStore();
  if (context) context.events.push(announce);
  else announce();
}

// The unsupported file backend stages both arrays before touching disk. A
// failed second write restores the first, making an ordinary retry safe. This
// is NOT crash atomic: production requires PostgreSQL.
export async function readMusicFile(key, load) {
  const context = mutations.getStore();
  if (!context?.files) return load();
  if (!context.files.has(key)) {
    const original = await load();
    context.files.set(key, { original, records: structuredClone(original), save: null });
  }
  return structuredClone(context.files.get(key).records);
}

export async function writeMusicFile(key, records, save) {
  const context = mutations.getStore();
  if (!context?.files) return save(records);
  const entry = context.files.get(key);
  entry.records = records;
  entry.save = save;
}

async function commitFiles(files) {
  const written = [];
  try {
    for (const entry of files.values()) {
      if (!entry.save) continue;
      await entry.save(entry.records);
      written.push(entry);
    }
  } catch (error) {
    const restored = await Promise.allSettled(written.map((entry) => entry.save(entry.original)));
    if (restored.some((result) => result.status === 'rejected')) {
      throw new ServerError('Music membership file recovery failed. Reconcile albums.json and tracks.json before retrying; use PostgreSQL for atomic writes.', {
        code: 'MUSIC_MEMBERSHIP_RECONCILIATION_REQUIRED',
      });
    }
    throw new ServerError('Music membership was not saved. Previous records were restored; retry the request.', {
      code: 'MUSIC_MEMBERSHIP_WRITE_FAILED', context: { cause: error.code || 'WRITE_FAILED' },
    });
  }
}

export function withMusicMutation(operation) {
  if (mutations.getStore()) return operation();
  const run = async () => {
    const context = { events: [] };
    let result;
    if (isFileBackend()) {
      context.files = new Map();
      result = await mutations.run(context, operation);
      await commitFiles(context.files);
    } else {
      await ensureSchema();
      result = await withTransaction(async (client) => {
        // One domain lock, acquired before any row lock or membership read.
        // All LOCAL writers share it, including track metadata saves.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['portos:music-membership']);
        context.client = client;
        return mutations.run(context, operation);
      });
    }
    for (const announce of context.events) announce();
    return result;
  };
  return isFileBackend() ? queueFiles(run) : run();
}
