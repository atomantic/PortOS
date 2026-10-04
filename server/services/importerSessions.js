/**
 * Importer sessions — server-side progress markers for the analyze → commit
 * workflow (#9943).
 *
 * The Importer page and the Story Builder import intake used to keep "this
 * import already committed" / "arc already persisted" in React state, so a
 * reload between the commit and the next step lost the marker: re-analyzing the
 * same manuscript matches the universe + series by name, and the client then
 * re-sent the full payload — duplicated issues and an overwritten arc.
 *
 * One session per (series, manuscript). The import id is DERIVED from those two
 * inputs rather than minted, so the client holds nothing across a reload: a
 * re-analyze of the same text into the same series recomputes the same id and
 * reads the same session back.
 *
 * Machine-local `file-primary` store (`data/importer-sessions.json`), never
 * federated — it records what THIS machine's commit did to THIS machine's
 * records; docs/STORAGE.md carries the classification. Absent file = no
 * sessions, so no seed and no migration.
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { IMPORT_ID_RE } from '../lib/creativeDirectorValidation.js';

const STORE_PATH = join(PATHS.data, 'importer-sessions.json');
const STORE_VERSION = 1;
// Oldest sessions drop first. A session is a few hundred bytes, so this bounds
// the file without ever evicting anything a user could plausibly still resume.
export const IMPORT_SESSION_MAX = 500;

export const SESSION_STATUS = Object.freeze({
  // Canon + arc + seasons landed; the issue set did not (it rolled back).
  ARC_PERSISTED: 'arc-persisted',
  // Every issue was created.
  COMMITTED: 'committed',
});
const STATUSES = new Set(Object.values(SESSION_STATUS));

// Serializes the read-modify-write cycle on the one shared file.
const enqueue = createFileWriteQueue();

/**
 * Deterministic import id for one manuscript imported into one series. Line
 * endings and surrounding whitespace are normalized so a CRLF paste of the same
 * text lands on the same session. `contentType` is deliberately NOT part of it:
 * re-classifying the same text must not open a second import of it.
 */
export function deriveImportId({ seriesId, source }) {
  const digest = createHash('sha256')
    .update(String(source ?? '').replace(/\r\n?/g, '\n').trim())
    .digest('hex');
  const id = createHash('sha256').update(`${seriesId}\n${digest}`).digest('hex').slice(0, 32);
  return `imp-${id}`;
}

const strArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

function sanitizeSession(id, raw) {
  if (!raw || typeof raw !== 'object' || !STATUSES.has(raw.status)) return null;
  if (typeof raw.seriesId !== 'string' || !raw.seriesId) return null;
  return {
    id,
    universeId: typeof raw.universeId === 'string' ? raw.universeId : null,
    seriesId: raw.seriesId,
    status: raw.status,
    createdIssueIds: strArray(raw.createdIssueIds),
    remappedIssues: Array.isArray(raw.remappedIssues) ? raw.remappedIssues : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

// An absent file is a fresh install (no sessions); an unreadable one rejects
// rather than reading as empty, because the next write would then replace
// markers this reader merely failed to parse.
async function readSessions() {
  const state = await readJSONFile(STORE_PATH, null, { allowArray: false, strict: true });
  const out = new Map();
  if (state?.version !== STORE_VERSION || !state.sessions || typeof state.sessions !== 'object') return out;
  for (const [id, raw] of Object.entries(state.sessions)) {
    if (!IMPORT_ID_RE.test(id)) continue;
    const session = sanitizeSession(id, raw);
    if (session) out.set(id, session);
  }
  return out;
}

export async function getImportSession(importId) {
  if (!IMPORT_ID_RE.test(importId || '')) return null;
  return (await readSessions()).get(importId) ?? null;
}

/**
 * Upsert a session's progress. `patch` carries `status` and, for a committed
 * session, the ids it created. Returns the stored session.
 */
export async function recordImportProgress(importId, patch) {
  if (!IMPORT_ID_RE.test(importId || '')) throw new Error(`Invalid import id: ${importId}`);
  return enqueue(async () => {
    const sessions = await readSessions();
    const session = sanitizeSession(importId, {
      ...sessions.get(importId),
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    if (!session) throw new Error(`Invalid import session for ${importId}`);
    // Re-insert so the Map's iteration order is also recency order.
    sessions.delete(importId);
    sessions.set(importId, session);
    const kept = [...sessions.values()]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-IMPORT_SESSION_MAX);
    await atomicWrite(STORE_PATH, {
      version: STORE_VERSION,
      sessions: Object.fromEntries(kept.map((s) => [s.id, s])),
    });
    return session;
  });
}

// Per-import in-flight chain. A commit can run for minutes (the optional
// per-issue cleanup pass is one LLM call each), so a double-click or a second
// tab re-committing the same import must wait for the first and then see its
// `committed` session — not race it into a second issue set.
const inFlight = new Map();

export function withImportLock(importId, fn) {
  const prev = inFlight.get(importId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  inFlight.set(importId, tail);
  tail.then(() => { if (inFlight.get(importId) === tail) inFlight.delete(importId); });
  return run;
}
