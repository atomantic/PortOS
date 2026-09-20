/**
 * Durable presentation markers for the live Review Hub queue.
 *
 * The source record remains authoritative. This store deliberately contains
 * only the canonical action identity plus snooze/dismissal/delivery markers;
 * it never copies a queue title, summary, prompt, or source payload.
 * PostgreSQL is authoritative for normal installs. The JSON backend is the
 * documented development/test escape hatch only.
 */

import { join } from 'node:path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend } from '../lib/pgFileFacade.js';

const triageFile = () => join(PATHS.data, 'review-queue-triage.json');
const queueFileWrite = createFileWriteQueue();

const normalizeIdentityPart = (value) => (value == null ? '' : String(value));

const normalizeSnoozedUntil = (value) => {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

export function triageIdentityKey({ actionKey, occurrence, revision } = {}) {
  return JSON.stringify([
    normalizeIdentityPart(actionKey),
    normalizeIdentityPart(occurrence),
    normalizeIdentityPart(revision),
  ]);
}

export function normalizeReviewQueueTriage(value = {}, { rejectInvalid = false } = {}) {
  const actionKey = normalizeIdentityPart(value.actionKey).trim();
  if (!actionKey) {
    if (rejectInvalid) throw new Error('Review queue triage is missing actionKey');
    return null;
  }
  const rawSnoozedUntil = value.snoozedUntil;
  const snoozedUntil = normalizeSnoozedUntil(rawSnoozedUntil);
  if (rejectInvalid && rawSnoozedUntil != null && rawSnoozedUntil !== '' && !snoozedUntil) {
    throw new Error('Review queue triage has an invalid snoozedUntil');
  }
  const deliveryGeneration = value.deliveryGeneration == null ? 0 : Number(value.deliveryGeneration);
  if (!Number.isSafeInteger(deliveryGeneration) || deliveryGeneration < 0) {
    if (rejectInvalid) throw new Error('Review queue triage has an invalid deliveryGeneration');
    return null;
  }
  return {
    actionKey,
    occurrence: normalizeIdentityPart(value.occurrence),
    revision: normalizeIdentityPart(value.revision),
    snoozedUntil,
    dismissed: value.dismissed === true,
    deliveryGeneration,
    ...(value.delivery && typeof value.delivery === 'object' ? {
      delivery: {
        severity: Number.isSafeInteger(value.delivery.severity) ? value.delivery.severity : 0,
        channels: Object.fromEntries(['toast', 'telegram', 'scheduled']
          .filter((channel) => Number.isSafeInteger(value.delivery.channels?.[channel]) && value.delivery.channels[channel] >= 0)
          .map((channel) => [channel, value.delivery.channels[channel]])),
      },
    } : {}),
  };
}

async function readFileTriage() {
  const raw = await readJSONFile(triageFile(), [], { allowArray: true, logError: false, strict: true });
  return (Array.isArray(raw) ? raw : []).map((entry) => normalizeReviewQueueTriage(entry)).filter(Boolean);
}

const findEntry = (entries, value) => {
  const key = triageIdentityKey(value);
  return entries.findIndex((entry) => triageIdentityKey(entry) === key);
};

function makeFileBackend() {
  return {
    name: 'file',
    list: readFileTriage,
    upsert: (value) => queueFileWrite(async () => {
      const entries = await readFileTriage();
      const index = findEntry(entries, value);
      if (index === -1) entries.push(value);
      else entries[index] = value;
      await atomicWrite(triageFile(), entries);
    }),
    remove: (value) => queueFileWrite(async () => {
      const entries = await readFileTriage();
      const index = findEntry(entries, value);
      if (index === -1) return;
      entries.splice(index, 1);
      await atomicWrite(triageFile(), entries);
    }),
  };
}

function makePgBackend(db) {
  return {
    name: 'postgres',
    async list() {
      const { rows } = await db.query(
        `SELECT action_key, occurrence, revision, snoozed_until, dismissed, delivery_generation, delivery
         FROM review_queue_triage
         ORDER BY action_key, occurrence, revision`,
      );
      return rows.map((row) => normalizeReviewQueueTriage({
        actionKey: row.action_key,
        occurrence: row.occurrence,
        revision: row.revision,
        snoozedUntil: row.snoozed_until,
        dismissed: row.dismissed,
        deliveryGeneration: row.delivery_generation,
        delivery: row.delivery,
      })).filter(Boolean);
    },
    async upsert(value) {
      await db.query(
        `INSERT INTO review_queue_triage
           (action_key, occurrence, revision, snoozed_until, dismissed, delivery_generation, delivery)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (action_key, occurrence, revision) DO UPDATE SET
           snoozed_until = EXCLUDED.snoozed_until,
           dismissed = EXCLUDED.dismissed,
           delivery_generation = EXCLUDED.delivery_generation,
           delivery = EXCLUDED.delivery`,
        [value.actionKey, value.occurrence, value.revision, value.snoozedUntil, value.dismissed, value.deliveryGeneration, value.delivery || null],
      );
    },
    async remove(value) {
      await db.query(
        `DELETE FROM review_queue_triage
         WHERE action_key = $1 AND occurrence = $2 AND revision = $3`,
        [value.actionKey, value.occurrence, value.revision],
      );
    },
  };
}

const backendFacade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: 'Review queue triage requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the file escape hatch)',
    loadDb: () => import('../lib/db.js'),
    makePg: makePgBackend,
  }),
});

export async function listReviewQueueTriage() {
  return (await backendFacade.getBackend()).list();
}

export async function upsertReviewQueueTriage(value) {
  const normalized = normalizeReviewQueueTriage(value, { rejectInvalid: true });
  await (await backendFacade.getBackend()).upsert(normalized);
  return normalized;
}

export async function removeReviewQueueTriage(value) {
  const normalized = normalizeReviewQueueTriage(value, { rejectInvalid: true });
  await (await backendFacade.getBackend()).remove(normalized);
}

/** Test seam for suites that swap the file data root between cases. */
export function resetReviewQueueTriageStore() {
  backendFacade.reset();
}
