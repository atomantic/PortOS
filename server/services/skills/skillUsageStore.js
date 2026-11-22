/**
 * Skill Curator telemetry and policy flags: per-skill view/use/patch counters, provenance, pin/lock and lifecycle state, read strictly so a corrupt file never drops a lock.
 *
 * Storage: `file-primary` (`data/skills/.usage.json`, `{ version: 1, skills:
 * { [skillId]: record }, curator: { lastRun } }`). A record is keyed by the
 * skill's current id, so archiving re-keys it to `archive:<path>` and a new
 * skill created at the old path starts a fresh record. Machine-local, backed up
 * with `data/skills/`, never federated. A dot-file, so skill discovery never
 * walks it.
 *
 * Fail closed (ADR 2026-08-14, strict JSON reads): the file is the base of
 * every read-modify-write and holds the `locked`/`pinned` guards, so an
 * unreadable or malformed file is `SKILL_USAGE_UNREADABLE` — never an empty
 * default that the next write would persist over the real flags. Only ENOENT
 * (never written) reads as empty.
 *
 * Every read-modify-write runs on one file tail (`createFileWriteQueue`).
 */

import { join } from 'path';
import { z } from 'zod';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, PATHS, readJSONFileStrict } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';

export const USAGE_FILE = '.usage.json';
export const SKILL_STATES = Object.freeze(['active', 'stale', 'archived']);

const usagePath = () => join(PATHS.data, 'skills', USAGE_FILE);
const isoOrNull = z.string().datetime().nullable().default(null);
const count = z.number().int().min(0).default(0);

// Passthrough: a newer PortOS may add fields, and rewriting the record through
// an older one must keep them.
const usageRecordSchema = z.object({
  viewCount: count,
  useCount: count,
  patchCount: count,
  lastViewedAt: isoOrNull,
  lastUsedAt: isoOrNull,
  lastPatchedAt: isoOrNull,
  createdAt: isoOrNull,
  restoredAt: isoOrNull,
  archivedAt: isoOrNull,
  // When the curator took ownership (explicit adopt, or the first pass that
  // saw a managed skill with no stamp): a never-used skill's idle floor.
  adoptedAt: isoOrNull,
  createdBy: z.enum(['agent', 'user']).nullable().default(null),
  state: z.enum(SKILL_STATES).default('active'),
  pinned: z.boolean().default(false),
  locked: z.boolean().default(false),
  // An archived skill's record is keyed by its `archive:` id; this is the
  // `local:` id it was archived from (and returns to on restore).
  originalId: z.string().min(1).max(600).nullable().default(null),
}).passthrough();

const usageFileSchema = z.object({
  version: z.literal(1),
  skills: z.record(z.string().min(1).max(600), usageRecordSchema),
  curator: z.object({ lastRun: z.unknown().optional() }).passthrough().optional(),
}).passthrough();

export const emptyUsageRecord = () => usageRecordSchema.parse({});

const unreadable = () => new ServerError('Skill usage file (data/skills/.usage.json) is unreadable; pin/lock guards cannot be verified, so skill writes are refused until it is repaired', {
  status: 503,
  code: 'SKILL_USAGE_UNREADABLE',
});

/**
 * Read the whole usage document.
 *
 * @returns {Promise<{ ok: true, doc: object } | { ok: false }>}
 */
export async function tryReadUsage() {
  const read = await readJSONFileStrict(usagePath(), null, { allowArray: false, logError: false });
  if (!read.ok) return { ok: false };
  if (read.value === null) return { ok: true, doc: { version: 1, skills: {} } };
  const parsed = usageFileSchema.safeParse(read.value);
  return parsed.success ? { ok: true, doc: parsed.data } : { ok: false };
}

/** Strict read: throws `SKILL_USAGE_UNREADABLE` instead of returning a default. */
export async function readUsage() {
  const read = await tryReadUsage();
  if (!read.ok) throw unreadable();
  return read.doc;
}

const queueUsageWrite = createFileWriteQueue();

/**
 * Serialized read-modify-write. `mutate(doc)` edits `doc.skills` in place and
 * may return a value; the document is written only when the read succeeded.
 */
export function updateUsage(mutate) {
  return queueUsageWrite(async () => {
    const doc = await readUsage();
    const result = await mutate(doc);
    await atomicWrite(usagePath(), doc);
    return result;
  });
}

/** Move a record to a new key (archive/restore), returning it; a missing source starts a fresh record. */
export const rekeyRecord = (doc, fromId, toId) => {
  const record = doc.skills[fromId] || emptyUsageRecord();
  delete doc.skills[fromId];
  doc.skills[toId] = record;
  return record;
};

/** The record for `id`, created (normalized defaults) when absent. */
export const ensureRecord = (doc, id) => {
  if (!doc.skills[id]) doc.skills[id] = emptyUsageRecord();
  return doc.skills[id];
};

const EVENT_FIELDS = Object.freeze({
  view: ['viewCount', 'lastViewedAt'],
  use: ['useCount', 'lastUsedAt'],
  patch: ['patchCount', 'lastPatchedAt'],
});

/**
 * Count one or more events (`view`, `use`, `patch`) against a skill. Any
 * activity brings a `stale` skill back to `active`; an archived skill keeps
 * its state (only restore moves it).
 */
export function recordSkillEvents(id, events, { now = new Date() } = {}) {
  const at = now.toISOString();
  return updateUsage((doc) => {
    const record = ensureRecord(doc, id);
    for (const event of events) {
      const [counter, stamp] = EVENT_FIELDS[event];
      record[counter] += 1;
      record[stamp] = at;
    }
    if (record.state === 'stale') record.state = 'active';
    return { ...record };
  });
}

/** Latest activity of any kind (or the creation/restore stamp): the curator's idle clock. */
export const lastActivityAt = (record) => {
  const stamps = [record?.lastUsedAt, record?.lastViewedAt, record?.lastPatchedAt, record?.restoredAt, record?.createdAt]
    .filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
};

/** The client-facing telemetry for one skill (Level 0 annotation). */
export const toUsageSummary = (record) => {
  const value = record || emptyUsageRecord();
  return {
    viewCount: value.viewCount,
    useCount: value.useCount,
    patchCount: value.patchCount,
    lastViewedAt: value.lastViewedAt,
    lastUsedAt: value.lastUsedAt,
    lastPatchedAt: value.lastPatchedAt,
    createdAt: value.createdAt,
    createdBy: value.createdBy,
    state: value.state,
    pinned: value.pinned,
    locked: value.locked,
    archivedAt: value.archivedAt,
    adoptedAt: value.adoptedAt,
    originalId: value.originalId,
  };
};
